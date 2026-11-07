import { validateChromeIdentity } from '../../automation-contracts/src/chrome.mjs'
import {
  CHROME_WIRE_MIN,
  CHROME_WIRE_VERSION,
  type ChromeExtensionSource,
  type ChromeReply,
  type ChromeRequest,
  type ChromeWelcome,
} from '../../automation-contracts/src/litch/chrome-browser.mjs'
import type { ExtensionOptions } from './options.mjs'
import { cleanupPointer, disposePointer } from './pointer.mjs'
import { TabPresentation } from './presentation.mjs'
import { execute } from './requests.mjs'
import {
  ChromeFault,
  type ExtensionState,
  lockTab,
  ownerKey,
  requireGrant,
  saveAttached,
  tabState,
} from './state.mjs'

/** 创建不接触浏览器；start 才注册本实例的监听器和原生连接。 */
export function createExtensionRuntime(options: ExtensionOptions) {
  validateChromeIdentity(options.identity)
  if (
    !Number.isInteger(options.protocol.min) ||
    !Number.isInteger(options.protocol.max) ||
    options.protocol.min < CHROME_WIRE_MIN ||
    options.protocol.max > CHROME_WIRE_VERSION ||
    options.protocol.min > options.protocol.max
  )
    throw new Error('Unsupported Chrome wire range')
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(options.storagePrefix))
    throw new Error('Invalid extension storage prefix')
  const chrome = options.chrome
  const keys = {
    attached: `${options.storagePrefix}Attached`,
    stopped: `${options.storagePrefix}StoppedTurns`,
    pointers: `${options.storagePrefix}PointerLeases`,
    instance: `${options.storagePrefix}InstanceId`,
    control: `${options.storagePrefix}ControlStopped`,
  }
  let active = false
  let generation = 0
  let initializing: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  const pending = new Set<Promise<unknown>>()
  let interval: ReturnType<typeof setInterval> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()
  function listen(event: any, listener: (...args: any[]) => any): () => void {
    event.addListener(listener)
    const off = () => {
      event.removeListener(listener)
      listeners.delete(off)
    }
    listeners.add(off)
    return off
  }
  let port: any = null
  let reconnect: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let ready = false
  /** Litch 协商出的协议号；以后升号时按它决定说哪一版。不兼容或还没收到 welcome 时为 null。 */
  let wire: number | null = null
  const state: ExtensionState = {
    chrome,
    keys,
    pointerSource: options.pointerSource,
    presentation: new TabPresentation(
      chrome,
      options.identity.productName,
      `${options.storagePrefix}TabPresentation:`,
    ),
    epoch: crypto.randomUUID(),
    grants: new Map(),
    tabLocks: new Map(),
    paused: new Set(),
    generations: new Map(),
    stoppedTurns: new Set(),
    stopped: false,
    productName: options.identity.productName,
    console: new Map(),
    send(message) {
      if (port) {
        try {
          port.postMessage(message)
        } catch {
          /* 断链由 onDisconnect 处理。 */
        }
      }
    },
    async revoke(leaseId, reason) {
      const grant = state.grants.get(leaseId)
      if (!grant) return
      const unlock = lockTab(state, grant.tabId)
      state.grants.delete(leaseId)
      state.paused.delete(leaseId)
      state.console.delete(grant.tabId)
      try {
        await state.presentation.release(grant.tabId, leaseId).catch(() => {})
        await disposePointer(state, grant)
        await chrome.debugger.detach({ tabId: grant.tabId }).catch(() => {})
        await saveAttached(state)
        state.send({ kind: 'revoked', leaseId, reason })
      } finally {
        unlock()
      }
    },
  }

  async function stopAll(): Promise<void> {
    state.stopped = true
    await chrome.storage.local.set({ [keys.control]: true })
    state.send({ kind: 'control', stopped: true })
    await controlLabel()
    for (const grant of state.grants.values()) state.stoppedTurns.add(ownerKey(grant.owner))
    await chrome.storage.session.set({ [keys.stopped]: [...state.stoppedTurns].slice(-100) })
    await Promise.all([...state.grants.keys()].map((id) => state.revoke(id, 'userStopped')))
  }

  async function controlLabel(): Promise<void> {
    const zh = chrome.i18n.getUILanguage().startsWith('zh')
    const name = options.identity.productName
    await chrome.action.setTitle({
      title: state.stopped
        ? zh
          ? `${name} — 控制已停止，点击重新打开`
          : `${name} — Control stopped; click to resume`
        : zh
          ? `${name} — 点击停止控制`
          : `${name} — Click to stop control`,
    })
    await chrome.action.setBadgeText({ text: state.stopped ? 'OFF' : '' })
  }

  async function resumeControl(): Promise<void> {
    await chrome.storage.local.set({ [keys.control]: false })
    state.stoppedTurns.clear()
    await chrome.storage.session.remove(keys.stopped)
    state.stopped = false
    state.send({ kind: 'control', stopped: false })
    await controlLabel()
  }

  function register(): void {
    listen(chrome.action.onClicked, () => {
      if (!ready) return
      if (state.stopped) void resumeControl()
      else void stopAll()
    })
    listen(chrome.runtime.onInstalled, () => {
      void connect()
    })
    listen(chrome.runtime.onStartup, () => {
      void connect()
    })
    listen(
      chrome.runtime.onMessage,
      (message: any, sender: any, reply: (value: unknown) => void) => {
        if (
          sender.id !== chrome.runtime.id ||
          !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)
        )
          return false
        if (message?.type === 'stop') {
          void stopAll().then(() => reply({ ok: true }))
          return true
        }
        if (message?.type === 'status') {
          reply({
            connected: !!port,
            version: chrome.runtime.getManifest().version,
            protocol: wire,
            claimed: state.grants.size,
            stopped: state.stopped,
          })
          return false
        }
        return false
      },
    )
    listen(chrome.tabs.onRemoved, (tabId: number) => {
      for (const grant of state.grants.values())
        if (grant.tabId === tabId) void state.revoke(grant.leaseId, 'tabClosed')
      state.generations.delete(tabId)
      state.send({ kind: 'removed', tabId })
    })
    listen(chrome.tabs.onUpdated, (tabId: number) => {
      void tabState(state, tabId)
        .then((tab) => state.send({ kind: 'tab', tab }))
        .catch(() => {})
    })
    listen(chrome.webNavigation.onCommitted, (event: { tabId: number }) => {
      for (const grant of state.grants.values())
        if (grant.tabId === event.tabId) void disposePointer(state, grant)
      state.console.delete(event.tabId)
      state.generations.set(event.tabId, (state.generations.get(event.tabId) ?? 0) + 1)
      void tabState(state, event.tabId)
        .then((tab) => state.send({ kind: 'tab', tab }))
        .catch(() => {})
    })
    listen(chrome.debugger.onDetach, (source: { tabId?: number }) => {
      for (const grant of state.grants.values())
        if (grant.tabId === source.tabId) void state.revoke(grant.leaseId, 'debuggerDetached')
    })
    listen(chrome.debugger.onEvent, (source: { tabId?: number }, method: string, params: any) => {
      if (typeof source.tabId !== 'number') return
      if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
        const tabId = source.tabId
        const generation = state.generations.get(tabId) ?? 0
        const grant = [...state.grants.values()].find((item) => item.tabId === tabId)
        if (grant)
          void requireGrant(state, grant.leaseId, generation)
            .then(() => {
              if (
                state.paused.size ||
                !state.grants.has(grant.leaseId) ||
                (state.generations.get(tabId) ?? 0) !== generation
              )
                return
              const text =
                method === 'Runtime.exceptionThrown'
                  ? String(params.exceptionDetails?.text ?? 'Exception')
                  : (params.args ?? [])
                      .map((arg: any) =>
                        typeof arg.value === 'string'
                          ? arg.value
                          : arg.value !== undefined
                            ? JSON.stringify(arg.value)
                            : String(arg.description ?? arg.type),
                      )
                      .join(' ')
              const level =
                method === 'Runtime.exceptionThrown' || params.type === 'error'
                  ? 'error'
                  : params.type === 'warning'
                    ? 'warning'
                    : 'log'
              const entries = state.console.get(tabId) ?? []
              entries.push({ level, text: text.slice(0, 4096), source: '', at: Date.now() })
              state.console.set(tabId, entries.slice(-200))
            })
            .catch(() => {})
      }
      if (method === 'Page.javascriptDialogOpening' || method === 'Page.javascriptDialogClosed') {
        // 不转发对话框内容；受来源闸保护的调用再按需获取，避免导航事件竞态泄漏。
        state.send({
          kind: 'dialog',
          tabId: source.tabId,
          generation: state.generations.get(source.tabId) ?? 0,
          dialog: method.endsWith('Opening')
            ? { type: params.type, message: '', defaultPrompt: '' }
            : null,
        })
      }
    })
  }

  async function connect(): Promise<void> {
    if (!active || !ready || port) return
    if (reconnect) {
      clearTimeout(reconnect)
      reconnect = null
    }
    let current: any
    try {
      current = chrome.runtime.connectNative(options.identity.hostName)
    } catch {
      schedule()
      return
    }
    port = current
    state.epoch = crypto.randomUUID()
    let offPort = () => {}
    const offDisconnect = listen(current.onDisconnect, () => {
      offPort()
      void chrome.runtime.lastError
      if (port !== current) return
      port = null
      wire = null
      void showCompatibility(null)
      for (const id of [...state.grants.keys()]) void state.revoke(id, 'bridgeDisconnected')
      schedule()
    })
    const offMessage = listen(current.onMessage, (message: ChromeRequest | ChromeWelcome) => {
      if (!active || current !== port) return
      if (message?.kind === 'welcome') {
        wire =
          message.protocol !== null &&
          message.protocol >= options.protocol.min &&
          message.protocol <= options.protocol.max
            ? message.protocol
            : null
        void showCompatibility(message)
        return
      }
      if (
        message?.kind !== 'request' ||
        typeof message.id !== 'string' ||
        !message.args ||
        typeof message.args !== 'object'
      )
        return
      if (wire === null) return
      const operation = execute(state, message).then(
        async (result) => {
          if (
            !active &&
            message.op === 'new' &&
            result &&
            typeof result === 'object' &&
            'id' in result
          )
            await chrome.tabs.remove(result.id).catch(() => {})
          respond(current, { kind: 'result', id: message.id, result })
        },
        (error: unknown) =>
          respond(current, {
            kind: 'result',
            id: message.id,
            error: {
              code: error instanceof ChromeFault ? error.code : 'failed',
              message: error instanceof Error ? error.message : 'Chrome operation failed.',
            },
          }),
      )
      pending.add(operation)
      void operation.finally(() => pending.delete(operation)).catch(() => {})
    })
    offPort = () => {
      offDisconnect()
      offMessage()
    }
    const saved = await chrome.storage.local.get(keys.instance)
    const instanceId =
      typeof saved[keys.instance] === 'string' ? saved[keys.instance] : crypto.randomUUID()
    await chrome.storage.local.set({ [keys.instance]: instanceId })
    if (port === current) {
      state.send({
        kind: 'hello',
        protocol: options.protocol.max,
        minProtocol: options.protocol.min,
        source: await installSource(),
        version: chrome.runtime.getManifest().version,
        instanceId,
        epoch: state.epoch,
        name: 'Chrome',
        stopped: state.stopped,
        inputReceipts: true,
      })
      attempt = 0
    }
  }

  /** 商店（含策略安装）和开发者模式加载的更新方式不同，Litch 据此提示怎么更新扩展。 */
  async function installSource(): Promise<ChromeExtensionSource | undefined> {
    const self = await chrome.management.getSelf()
    if (self.installType === 'development') return 'unpacked'
    if (self.installType === 'normal' || self.installType === 'admin') return 'store'
    return undefined
  }

  /** 不兼容时在工具栏图标上标出来；详细原因和办法在 Litch 设置页。 */
  async function showCompatibility(welcome: ChromeWelcome | null): Promise<void> {
    if (!welcome?.incompatible) return controlLabel()
    const title =
      welcome?.incompatible === 'litchOutdated'
        ? `${options.identity.productName} — Update ${options.identity.productName} (${welcome.litchVersion}) to use this extension`
        : welcome?.incompatible === 'extensionOutdated'
          ? `${options.identity.productName} — Update this extension for ${options.identity.productName} ${welcome.litchVersion}`
          : `${options.identity.productName} — Stop browser control`
    await chrome.action.setBadgeText({ text: welcome?.incompatible ? '!' : '' })
    await chrome.action.setTitle({ title })
  }

  function respond(current: any, reply: ChromeReply): void {
    if (!active || current !== port) return
    if (JSON.stringify(reply).length > 12 * 1024 * 1024)
      reply = {
        kind: 'result',
        id: reply.id,
        error: {
          code: 'failed',
          message: 'Chrome result is too large. Narrow the requested content.',
        },
      }
    try {
      current.postMessage(reply)
    } catch {
      /* 不重放已执行动作。 */
    }
  }

  function schedule(): void {
    if (active && !reconnect)
      reconnect = setTimeout(
        () => {
          reconnect = null
          void connect()
        },
        Math.min(5000, 250 * 2 ** attempt++),
      )
  }

  async function initialize(run: number): Promise<void> {
    state.stopped = (await chrome.storage.local.get(keys.control))[keys.control] === true
    await controlLabel()
    await state.presentation.recover()
    const saved = await chrome.storage.session.get([keys.attached, keys.stopped, keys.pointers])
    for (const prior of saved[keys.pointers] ?? [])
      if (typeof prior.tabId === 'number' && typeof prior.leaseId === 'string')
        await cleanupPointer(state, prior.tabId, prior.leaseId)
    // 仅撤本扩展登记过的标签，不扫描或接管用户其他调试器。
    for (const tabId of saved[keys.attached] ?? [])
      await chrome.debugger.detach({ tabId }).catch(() => {})
    await chrome.storage.session.remove([keys.attached, keys.pointers])
    for (const key of saved[keys.stopped] ?? [])
      if (typeof key === 'string') state.stoppedTurns.add(key)
    if (!active || run !== generation) return
    ready = true
    await connect()
    if (!active || run !== generation) return
    interval = setInterval(() => {
      for (const grant of state.grants.values())
        if (grant.expiresAt <= Date.now()) void state.revoke(grant.leaseId, 'expired')
      void state.presentation.retry(new Set(state.grants.keys())).catch(() => {})
    }, 1000)
  }
  return {
    async start(): Promise<void> {
      if (stopping) await stopping
      if (active) return initializing ?? undefined
      if (!options.identity.extensionIds.includes(chrome.runtime.id))
        throw new Error('Extension identity is not authorized')
      active = true
      const run = ++generation
      register()
      const begin = (): Promise<void> =>
        initialize(run).catch(() => {
          if (active && run === generation)
            retry = setTimeout(() => {
              initializing = begin()
            }, 1000)
        })
      initializing = begin()
      await initializing
    },
    stop(): Promise<void> {
      if (stopping) return stopping
      active = false
      generation++
      ready = false
      for (const off of [...listeners]) off()
      if (reconnect) clearTimeout(reconnect)
      if (retry) clearTimeout(retry)
      if (interval) clearInterval(interval)
      reconnect = retry = interval = null
      stopping = (async () => {
        await initializing
        initializing = null
        await Promise.all([...state.grants.keys()].map((id) => state.revoke(id, 'runtimeStopped')))
        await Promise.allSettled([...pending])
        const current = port
        port = null
        wire = null
        current?.disconnect()
      })()
      const finished = stopping
      void finished
        .finally(() => {
          if (stopping === finished) stopping = null
        })
        .catch(() => {})
      return finished
    },
  }
}
