import {
  CHROME_HOST_NAME,
  CHROME_WIRE_VERSION,
  type ChromeReply,
  type ChromeRequest,
} from '../../../packages/protocol/src/chrome-browser.mjs'
import { execute } from './requests.mjs'
import {
  ChromeFault,
  type ExtensionState,
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
const state: ExtensionState = {
  chrome,
  epoch: crypto.randomUUID(),
  grants: new Map(),
  paused: new Set(),
  generations: new Map(),
  stoppedTurns: new Set(),
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
    state.grants.delete(leaseId)
    state.paused.delete(leaseId)
    state.console.delete(grant.tabId)
    await chrome.debugger.detach({ tabId: grant.tabId }).catch(() => {})
    await saveAttached(state)
    state.send({ kind: 'revoked', leaseId, reason })
  },
}

async function stopAll(): Promise<void> {
  for (const grant of state.grants.values()) state.stoppedTurns.add(ownerKey(grant.owner))
  await chrome.storage.session.set({ litchStoppedTurns: [...state.stoppedTurns].slice(-100) })
  await Promise.all([...state.grants.keys()].map((id) => state.revoke(id, 'userStopped')))
}

chrome.action.onClicked.addListener(() => {
  void stopAll()
})
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
        claimed: state.grants.size,
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
            state.paused.has(grant.leaseId) ||
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
    for (const id of [...state.grants.keys()]) void state.revoke(id, 'bridgeDisconnected')
    schedule()
  })
  current.onMessage.addListener((message: ChromeRequest) => {
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
      version: chrome.runtime.getManifest().version,
      instanceId,
      epoch: state.epoch,
      name: 'Chrome',
    })
    attempt = 0
  }
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
  const saved = await chrome.storage.session.get(['litchAttached', 'litchStoppedTurns'])
  // 仅撤本扩展登记过的标签，不扫描或接管用户其他调试器。
  for (const tabId of saved.litchAttached ?? [])
    await chrome.debugger.detach({ tabId }).catch(() => {})
  await chrome.storage.session.remove('litchAttached')
  for (const key of saved.litchStoppedTurns ?? [])
    if (typeof key === 'string') state.stoppedTurns.add(key)
  ready = true
  await connect()
  setInterval(() => {
    for (const grant of state.grants.values())
      if (grant.expiresAt <= Date.now()) void state.revoke(grant.leaseId, 'expired')
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
