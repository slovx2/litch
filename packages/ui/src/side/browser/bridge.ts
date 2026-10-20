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
  /** 从别的浏览器导入。外壳的主进程旧、还没有这一块时没有 */
  import?: BrowserImportBridge
}

// ---------- 从别的浏览器导入（主进程 apps/desktop/src/browser-import/types.mts，改一边改另一边） ----------
// 界面只拿到来源、资料名、条数和状态，拿不到 Cookie 的值和密码。

/** 认得的来源 */
export type BrowserId = 'chrome' | 'edge' | 'brave' | 'arc' | 'chromium' | 'vivaldi' | 'firefox'

export type ImportKind = 'cookies' | 'passwords'

export interface ImportProfile {
  /** Chromium 系是资料目录名（Default、Profile 1），Firefox 是 profiles.ini 里的 Path */
  id: string
  name: string
  account?: string
  isDefault: boolean
  /** 这份资料里有哪几类数据 */
  has: Record<ImportKind, boolean>
}

export interface ImportSource {
  browser: BrowserId
  /** 产品名，不翻译 */
  name: string
  /** 读取器在这台机器上能读的 */
  kinds: ImportKind[]
  /** 读之前系统会弹授权框（Mac 的钥匙串） */
  promptsSystemAuth: boolean
  /** Windows 上要管理员同意才能读 Cookie 和密码 */
  needsElevation: boolean
  profiles: ImportProfile[]
}

export interface ImportRequest {
  browser: BrowserId
  profileId: string
  kinds: ImportKind[]
  /** 只导这些网站（含子域）的 Cookie；不给是全部。小写、无前导点 */
  cookieDomains?: string[]
  allowElevated: boolean
}

/** 读取器报的状态，加上 skipped（前面一类被取消了，这一类没轮上） */
export type ImportKindStatus =
  | 'ok'
  | 'partial'
  | 'missing'
  | 'locked'
  | 'denied'
  | 'needs-elevation'
  | 'unsupported'
  | 'cancelled'
  | 'failed'
  | 'skipped'

export interface ImportKindOutcome {
  status: ImportKindStatus
  /** 来源里一共多少条 */
  discovered: number
  imported: number
  skippedExisting: number
  skippedInvalid: number
  failed: number
  /** 英文的一句话，界面按 status 出自己的说法，这句只放进“详情” */
  error?: string
}

export interface ImportOutcome {
  /** 资料已不在、另一个导入正在进行等整体性的失败 */
  error?: 'profile-gone' | 'busy'
  kinds: Partial<Record<ImportKind, ImportKindOutcome>>
}

export interface ImportProgress {
  kind: ImportKind
  phase: 'reading' | 'writing' | 'done'
}

/** 导过没有、横幅关过没有，毫秒 */
export interface ImportState {
  lastImportAt?: number
  bannerDismissedAt?: number
}

export interface BrowserImportBridge {
  /** 这台电脑上找得到的来源和资料 */
  sources(): Promise<ImportSource[]>
  /** 一次只一个导入；做完（含取消、失败）才回 */
  start(request: ImportRequest): Promise<ImportOutcome>
  cancel(): Promise<void>
  onProgress(listener: (progress: ImportProgress) => void): () => void
  state(): Promise<ImportState>
  dismissBanner(): Promise<void>
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

/** 外壳给的导入接口。没有外壳、主进程还没有这一块时没有 */
export const importBridge = (): BrowserImportBridge | undefined => browserBridge()?.import
