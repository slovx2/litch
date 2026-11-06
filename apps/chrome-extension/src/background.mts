import {
  CHROME_HOST_NAME,
  CHROME_WIRE_MIN,
  CHROME_WIRE_VERSION,
  type ChromeExtensionSource,
  type ChromeReply,
  type ChromeRequest,
  type ChromeWelcome,
} from '../../../packages/protocol/src/chrome-browser.mjs'
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

declare const chrome: any
let port: any = null
let reconnect: ReturnType<typeof setTimeout> | null = null
let attempt = 0
let ready = false
/** Litch 协商出的协议号；以后升号时按它决定说哪一版。不兼容或还没收到 welcome 时为 null。 */
let wire: number | null = null
const state: ExtensionState = {
  chrome,
  presentation: new TabPresentation(chrome),
  epoch: crypto.randomUUID(),
  grants: new Map(),
  tabLocks: new Map(),
  paused: new Set(),
  generations: new Map(),
  stoppedTurns: new Set(),
  stopped: false,
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
  await chrome.storage.local.set({ litchControlStopped: true })
  state.send({ kind: 'control', stopped: true })
  await controlLabel()
  for (const grant of state.grants.values()) state.stoppedTurns.add(ownerKey(grant.owner))
  await chrome.storage.session.set({ litchStoppedTurns: [...state.stoppedTurns].slice(-100) })
  await Promise.all([...state.grants.keys()].map((id) => state.revoke(id, 'userStopped')))
}

chrome.action.onClicked.addListener(() => {
  if (!ready) return
  if (state.stopped) void resumeControl()
  else void stopAll()
})

async function controlLabel(): Promise<void> {
  const zh = chrome.i18n.getUILanguage().startsWith('zh')
  await chrome.action.setTitle({
    title: state.stopped
      ? zh
        ? 'Litch — 控制已停止，点击重新打开'
        : 'Litch — Control stopped; click to resume'
      : zh
        ? 'Litch — 点击停止控制'
        : 'Litch — Click to stop control',
  })
  await chrome.action.setBadgeText({ text: state.stopped ? 'OFF' : '' })
}

async function resumeControl(): Promise<void> {
  await chrome.storage.local.set({ litchControlStopped: false })
  state.stoppedTurns.clear()
  await chrome.storage.session.remove('litchStoppedTurns')
  state.stopped = false
  state.send({ kind: 'control', stopped: false })
  await controlLabel()
}
chrome.runtime.onInstalled.addListener(() => {
  void connect()
})
chrome.runtime.onStartup.addListener(() => {
  void connect()
})
chrome.runtime.onMessage.addListener(
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
chrome.tabs.onRemoved.addListener((tabId: number) => {
  for (const grant of state.grants.values())
    if (grant.tabId === tabId) void state.revoke(grant.leaseId, 'tabClosed')
  state.generations.delete(tabId)
  state.send({ kind: 'removed', tabId })
})
chrome.tabs.onUpdated.addListener((tabId: number) => {
  void tabState(state, tabId)
    .then((tab) => state.send({ kind: 'tab', tab }))
    .catch(() => {})
})
chrome.webNavigation.onCommitted.addListener((event: { tabId: number }) => {
  for (const grant of state.grants.values())
    if (grant.tabId === event.tabId) void disposePointer(state, grant)
  state.console.delete(event.tabId)
  state.generations.set(event.tabId, (state.generations.get(event.tabId) ?? 0) + 1)
  void tabState(state, event.tabId)
    .then((tab) => state.send({ kind: 'tab', tab }))
    .catch(() => {})
})
chrome.debugger.onDetach.addListener((source: { tabId?: number }) => {
  for (const grant of state.grants.values())
    if (grant.tabId === source.tabId) void state.revoke(grant.leaseId, 'debuggerDetached')
})
chrome.debugger.onEvent.addListener((source: { tabId?: number }, method: string, params: any) => {
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

async function connect(): Promise<void> {
  if (!ready || port) return
  if (reconnect) {
    clearTimeout(reconnect)
    reconnect = null
  }
  let current: any
  try {
    current = chrome.runtime.connectNative(CHROME_HOST_NAME)
  } catch {
    schedule()
    return
  }
  port = current
  state.epoch = crypto.randomUUID()
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    if (port !== current) return
    port = null
    wire = null
    void showCompatibility(null)
    for (const id of [...state.grants.keys()]) void state.revoke(id, 'bridgeDisconnected')
    schedule()
  })
  current.onMessage.addListener((message: ChromeRequest | ChromeWelcome) => {
    if (message?.kind === 'welcome') {
      wire = message.protocol
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
    void execute(state, message).then(
      (result) => respond(current, { kind: 'result', id: message.id, result }),
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
  })
  const saved = await chrome.storage.local.get('litchInstanceId')
  const instanceId =
    typeof saved.litchInstanceId === 'string' ? saved.litchInstanceId : crypto.randomUUID()
  await chrome.storage.local.set({ litchInstanceId: instanceId })
  if (port === current) {
    state.send({
      kind: 'hello',
      protocol: CHROME_WIRE_VERSION,
      minProtocol: CHROME_WIRE_MIN,
      source: await installSource(),
      version: chrome.runtime.getManifest().version,
      instanceId,
      epoch: state.epoch,
      name: 'Chrome',
      stopped: state.stopped,
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
      ? `Litch — Update Litch (${welcome.litchVersion}) to use this extension`
      : welcome?.incompatible === 'extensionOutdated'
        ? `Litch — Update this extension for Litch ${welcome.litchVersion}`
        : 'Litch — Stop browser control'
  await chrome.action.setBadgeText({ text: welcome?.incompatible ? '!' : '' })
  await chrome.action.setTitle({ title })
}

function respond(current: any, reply: ChromeReply): void {
  if (current !== port) return
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
  if (!reconnect)
    reconnect = setTimeout(
      () => {
        reconnect = null
        void connect()
      },
      Math.min(5000, 250 * 2 ** attempt++),
    )
}

async function start(): Promise<void> {
  state.stopped =
    (await chrome.storage.local.get('litchControlStopped')).litchControlStopped === true
  await controlLabel()
  await state.presentation.recover()
  const saved = await chrome.storage.session.get([
    'litchAttached',
    'litchStoppedTurns',
    'litchPointerLeases',
  ])
  for (const prior of saved.litchPointerLeases ?? [])
    if (typeof prior.tabId === 'number' && typeof prior.leaseId === 'string')
      await cleanupPointer(state, prior.tabId, prior.leaseId)
  // 仅撤本扩展登记过的标签，不扫描或接管用户其他调试器。
  for (const tabId of saved.litchAttached ?? [])
    await chrome.debugger.detach({ tabId }).catch(() => {})
  await chrome.storage.session.remove(['litchAttached', 'litchPointerLeases'])
  for (const key of saved.litchStoppedTurns ?? [])
    if (typeof key === 'string') state.stoppedTurns.add(key)
  ready = true
  await connect()
  setInterval(() => {
    for (const grant of state.grants.values())
      if (grant.expiresAt <= Date.now()) void state.revoke(grant.leaseId, 'expired')
    void state.presentation.retry(new Set(state.grants.keys())).catch(() => {})
  }, 1000)
}
async function initialize(): Promise<void> {
  try {
    await start()
  } catch {
    setTimeout(() => {
      void initialize()
    }, 1000)
  }
}
void initialize()
