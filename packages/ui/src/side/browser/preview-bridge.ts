// 手动登录面板预览：普通交接与 task 定时任务过期提示。
import type {
  BrowserBridge,
  BrowserOwner,
  BrowserSavedPassword,
  BrowserSignInRequest,
  BrowserTabInfo,
} from './bridge.ts'

let made: BrowserBridge | null = null

/** 该不该用假外壳：不在桌面外壳里，地址里带着 browser=preview */
export function previewBridge(): BrowserBridge | undefined {
  if (made) return made
  if (window.litchShell || new URLSearchParams(location.search).get('browser') !== 'preview')
    return undefined
  made = createPreviewBridge(new URLSearchParams(location.search).get('signIn') ?? 'manual')
  return made
}

const DAY = 86_400_000

const PASSWORDS: BrowserSavedPassword[] = [
  {
    id: 'p1',
    origin: 'https://accounts.github.com',
    username: 'dev@example.com',
    source: 'chrome:Default',
    createdAt: Date.now() - 40 * DAY,
    lastUsedAt: Date.now() - 3 * DAY,
  },
  {
    id: 'p2',
    origin: 'https://accounts.github.com',
    username: 'ops-bot',
    source: 'chrome:Default',
    createdAt: Date.now() - 12 * DAY,
  },
]

function createPreviewBridge(variant: string): BrowserBridge {
  let tabs: BrowserTabInfo[] = []
  let signIns: BrowserSignInRequest[] = []
  let seq = 0
  const stateListeners = new Set<(tabs: BrowserTabInfo[]) => void>()
  const signInListeners = new Set<(list: BrowserSignInRequest[]) => void>()
  const listen = <T>(set: Set<T>, handler: T) => {
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }
  const tabsChanged = () => {
    for (const listener of stateListeners) listener(tabs)
  }
  const signInsChanged = () => {
    for (const listener of signInListeners) listener(signIns)
  }

  const cardFor = (tab: BrowserTabInfo): BrowserSignInRequest => ({
    id: `${tab.id}-sign-in`,
    deviceId: tab.owner.deviceId,
    threadId: tab.owner.threadId,
    tabId: tab.id,
    origin: variant === 'blocked' ? 'http://login.example.com' : 'https://accounts.github.com',
    site: 'GitHub',
    reason: 'Need to open the repository settings.',
    state: 'waiting',
    at: Date.now(),
    accounts: [],
    fillBlocked: null,
    taskId: variant === 'task' ? 'task-nightly' : null,
    expiresAt: variant === 'task' ? Date.now() + 30 * 60_000 : null,
    nonce: `${tab.id}-nonce`,
    stage: 'choose',
    by: null,
  })

  const open = async (owner: BrowserOwner, url: string) => {
    seq++
    const tab: BrowserTabInfo = {
      id: `preview-${seq}`,
      owner,
      kind: 'agent',
      url: url || 'https://accounts.github.com/login',
      title: 'Sign in · GitHub',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      agentActive: false,
      keep: false,
    }
    tabs = [...tabs, tab]
    signIns = [...signIns, cardFor(tab)]
    tabsChanged()
    signInsChanged()
    return tab
  }

  return {
    place() {},
    open,
    navigate() {},
    close(tabId) {
      tabs = tabs.filter((tab) => tab.id !== tabId)
      signIns = signIns.filter((one) => one.tabId !== tabId)
      tabsChanged()
      signInsChanged()
    },
    openExternal() {},
    tabs: async () => tabs,
    onState: (handler) => listen(stateListeners, handler),
    onShow: () => () => {},
    sites: async () => [],
    forgetSite: async () => 0,
    clearData: async () => true,
    policy: async () => ({ trustAll: false, blocked: [] }),
    setTrustAll: async (on) => ({ trustAll: on, blocked: [] }),
    block: async () => null,
    unblock: async () => ({ trustAll: false, blocked: [] }),
    onPolicy: () => () => {},
    passwords: {
      list: async () => PASSWORDS,
      remove: async () => false,
      removeAll: async () => 0,
      onChanged: () => () => {},
      never: async () => [],
      allowSite: async () => false,
      prompts: async () => [],
      answer: async () => false,
      onPrompts: () => () => {},
    },
    signIn: {
      list: async () => signIns,
      async answer(id, answer) {
        const one = signIns.find((each) => each.id === id)
        if (!one) return false
        const swap = (next: BrowserSignInRequest | null) => {
          signIns = signIns.flatMap((each) => (each.id !== id ? [each] : next ? [next] : []))
          signInsChanged()
        }
        if (answer === 'self') swap({ ...one, stage: 'manual' })
        else if (typeof answer === 'object') return false
        else swap(null)
        return true
      },
      onChanged: (handler) => listen(signInListeners, handler),
    },
    import: {
      sources: async () => [],
      start: async () => ({ kinds: {} }),
      cancel: async () => {},
      onProgress: () => () => {},
      // 导入的横幅不出，免得挡着卡片
      state: async () => ({ bannerDismissedAt: Date.now() }),
      dismissBanner: async () => {},
    },
  }
}
