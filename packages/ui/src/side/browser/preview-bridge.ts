// 界面预览用的假外壳：普通浏览器里（模拟核心）没有 window.litchBrowser，浏览器标签和设置页只有一句说明。
// 地址里带 ?browser=preview 时换成这个，看得到浏览器面板上的卡片和设置页里经外壳的那几块。没有真的网页。
// 在面板里新开一个标签就出一张登录卡片，样子按 ?signIn= 选：accounts（有已存账号，默认）、none（库里没有）、
// blocked（预检不过）、task（定时任务的回合）。在桌面外壳里、地址里没带这一项时不起作用。
import type {
  BrowserBridge,
  BrowserOwner,
  BrowserSavedPassword,
  BrowserSignInRequest,
  BrowserTabInfo,
  BrowserTouchId,
} from './bridge.ts'

let made: BrowserBridge | null = null

/** 该不该用假外壳：不在桌面外壳里，地址里带着 browser=preview */
export function previewBridge(): BrowserBridge | undefined {
  if (made) return made
  if (window.litchShell || new URLSearchParams(location.search).get('browser') !== 'preview')
    return undefined
  made = createPreviewBridge(new URLSearchParams(location.search).get('signIn') ?? 'accounts')
  return made
}

const DAY = 86_400_000

const PASSWORDS: BrowserSavedPassword[] = [
  {
    id: 'p1',
    origin: 'https://accounts.github.com',
    username: 'song@example.com',
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
  let touchId: BrowserTouchId = { available: true, on: false }
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
    accounts:
      variant === 'none'
        ? []
        : [
            {
              ref: `${tab.id}-a1`,
              username: 'song@example.com',
              masked: 'so•••@example.com',
              lastUsed: Date.now() - 3 * DAY,
            },
            { ref: `${tab.id}-a2`, username: 'ops-bot', masked: 'op•••', lastUsed: null },
          ],
    fillBlocked: variant === 'blocked' ? 'insecure' : null,
    ...(variant === 'task' ? { taskId: 'task-nightly', expiresAt: Date.now() + 30 * 60_000 } : {}),
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
      touchId: async () => touchId,
      async setTouchId(on) {
        touchId = { ...touchId, on }
        return touchId
      },
      never: async () => [],
      allowSite: async () => false,
      prompts: async () => [],
      answer: async () => false,
      onPrompts: () => () => {},
    },
    signIn: {
      list: async () => signIns,
      async answer(id, answer) {
        if (!signIns.some((one) => one.id === id)) return false
        // 代填要一会儿：卡片上先看得到“正在登录…”
        if (typeof answer === 'object') await new Promise((done) => setTimeout(done, 1500))
        signIns = signIns.filter((one) => one.id !== id)
        signInsChanged()
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
