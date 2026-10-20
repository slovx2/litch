// 桌面外壳的预加载脚本挂在 window.litchBrowser 上的内置浏览器接口（apps/desktop/src/browser/bridge.mts），
// 这里是界面这边的类型，改一边要改另一边。普通浏览器里没有外壳，就没有它：浏览器标签只显示一句说明。
//
// 网页不在界面里：界面只占一块矩形、把它的位置大小报给外壳，网页由外壳在主进程里叠上去。

/** 标签归哪个会话。新建对话页上（会话还没建）threadId 是空字符串 */
export interface BrowserOwner {
  deviceId: string
  threadId: string
}

/** 外壳报来的一个标签的样子 */
export interface BrowserTabInfo {
  id: string
  owner: BrowserOwner
  /** agent：代理开的；user：用户自己开的 */
  kind: 'agent' | 'user'
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 代理这个回合正在用它 */
  agentActive: boolean
  /** 代理标了留给用户 */
  keep: boolean
}

/** 设置页里一条“一直允许”的网站 */
export interface BrowserSavedSite {
  origin: string
  /** 什么时候允许的，毫秒 */
  at: number
}

/** 信任所有网站的开关和黑名单 */
export interface BrowserSitePolicy {
  /** 开着时代理打开网站一律不问，只有黑名单里的不许开 */
  trustAll: boolean
  /** 黑名单里的主机名（含子域名），排好序 */
  blocked: string[]
}

/** 设置页里一条已保存的密码：只有站点、用户名、来源、时间，从不带密码 */
export interface BrowserSavedPassword {
  id: string
  /** 站点的源，`https://accounts.example.com` */
  origin: string
  username: string
  /** 从哪儿导进来的，比如 `chrome:Default` */
  source: string
  /** 毫秒 */
  createdAt: number
  /** 毫秒：最近一次在内置浏览器里填过；没填过不给 */
  lastUsedAt?: number
}

/** “这个网站永不保存”的一条 */
export interface BrowserNeverSite {
  origin: string
  /** 毫秒 */
  at: number
}

/** 登录之后的保存提示：没有密码，只给人看 */
export interface BrowserSavePrompt {
  id: string
  /** 哪个会话的哪个标签里登录的 */
  deviceId: string
  threadId: string
  tabId: string
  origin: string
  username: string
  /** save：没存过这个用户名；update：存过，但密码不一样 */
  kind: 'save' | 'update'
  /** 毫秒 */
  at: number
}

export type BrowserSaveAnswer = 'save' | 'dismiss' | 'never'

/** 已保存的密码和保存提示：只能列、删、答，看不到明文 */
export interface BrowserPasswordsBridge {
  list(): Promise<BrowserSavedPassword[]>
  /** 删一条，回删没删到 */
  remove(id: string): Promise<boolean>
  /** 全删，回删了几条（不动“永不保存”的名单） */
  removeAll(): Promise<number>
  /** 密码库变了（导入了、保存了、别处删了、永不名单变了） */
  onChanged(handler: () => void): () => void
  /** “这个网站永不保存”的名单 */
  never(): Promise<BrowserNeverSite[]>
  /** 从名单里去掉，回去没去掉 */
  allowSite(origin: string): Promise<boolean>
  /** 现在挂着的保存提示 */
  prompts(): Promise<BrowserSavePrompt[]>
  /** 答一条，回答没答到（已经没了） */
  answer(id: string, answer: BrowserSaveAnswer): Promise<boolean>
  /** 保存提示变了，带着现在所有的 */
  onPrompts(handler: (prompts: BrowserSavePrompt[]) => void): () => void
}

export interface BrowserBridge {
  /** 这个窗口里、这块矩形（页面里的 CSS 像素）上显示哪个标签。都给 null 就是什么都不显示 */
  place(
    tabId: string | null,
    rect: { x: number; y: number; width: number; height: number } | null,
  ): void
  /** 用户开一个新标签；url 是地址栏里打的字（空的就是空白页） */
  open(owner: BrowserOwner, url: string): Promise<BrowserTabInfo | null>
  /** 地址栏里打的字，或者 back、forward、reload、stop */
  navigate(tabId: string, to: string): void
  close(tabId: string): void
  /** 用系统的浏览器打开这个标签现在的地址 */
  openExternal(tabId: string): void
  tabs(): Promise<BrowserTabInfo[]>
  onState(handler: (tabs: BrowserTabInfo[]) => void): () => void
  /** 代理要给用户看一个标签 */
  onShow(handler: (tab: BrowserTabInfo) => void): () => void
  /** 设置页用：“一直允许”的网站 */
  sites(): Promise<BrowserSavedSite[]>
  /** 删掉一条“一直允许”；给 null 全删。回删了几条 */
  forgetSite(origin: string | null): Promise<number>
  /** 清除浏览数据（cookie、站点存储、缓存） */
  clearData(): Promise<boolean>
  policy(): Promise<BrowserSitePolicy | null>
  /** 开关信任所有网站，回新的样子 */
  setTrustAll(on: boolean): Promise<BrowserSitePolicy | null>
  /** 加一项黑名单（网址、域名都行，子域名一起算）；认不出是 null */
  block(site: string): Promise<BrowserSitePolicy | null>
  /** 去掉一项黑名单；给 null 全去掉 */
  unblock(host: string | null): Promise<BrowserSitePolicy | null>
  /** 开关或黑名单在别处改了（审批卡片上、litch config） */
  onPolicy(handler: (policy: BrowserSitePolicy) => void): () => void
  /** 已保存的密码（设置页用） */
  passwords: BrowserPasswordsBridge
}

declare global {
  interface Window {
    litchBrowser?: BrowserBridge
  }
}

/** 外壳给的接口。普通浏览器里、不在页面里（界面的单元测试直接在 Node 里读源文件）时没有 */
export const browserBridge = (): BrowserBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.litchBrowser

/** 会话的键 */
export const ownerKey = (owner: BrowserOwner): string => `${owner.deviceId}\u0000${owner.threadId}`
