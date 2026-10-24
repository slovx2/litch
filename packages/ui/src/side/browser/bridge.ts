// 桌面外壳的预加载脚本挂在 window.litchBrowser 上的内置浏览器接口（apps/desktop/src/browser/bridge.mts），
// 这里是界面这边的类型，改一边要改另一边。普通浏览器里没有外壳，就没有它：浏览器标签只显示一句说明。
//
// 网页不在界面里：界面只占一块矩形、把它的位置大小报给外壳，网页由外壳在主进程里叠上去。

import { previewBridge } from './preview-bridge.ts'

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
  /** save：没存过这个用户名；update：存过，但密码不一样；unavailable：系统钥匙串不可用，存不了（只能关掉） */
  kind: 'save' | 'update' | 'unavailable'
  /** 毫秒 */
  at: number
}

export type BrowserSaveAnswer = 'save' | 'dismiss' | 'never'

/** 代填前的 Touch ID 开关 */
export interface BrowserTouchId {
  /** 这台电脑能用（macOS 且有指纹） */
  available: boolean
  on: boolean
}

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
  /** 答一条，回答没答到（已经没了）；写库失败时抛（code 是 file-unavailable 的是密码库文件读写不了），提示留着 */
  answer(id: string, answer: BrowserSaveAnswer): Promise<boolean>
  /** 保存提示变了，带着现在所有的 */
  onPrompts(handler: (prompts: BrowserSavePrompt[]) => void): () => void
}

/** 代理请人登录（request_sign_in）：面板上的卡片，里面没有人输入的东西 */
export interface BrowserSignInRequest {
  id: string
  deviceId: string
  threadId: string
  tabId: string
  /** 外壳取到的这个标签现在的真实来源，随导航更新；不是网页的是空的 */
  origin: string
  /** 代理说的要登录什么（只作附注） */
  site: string
  /** 代理说的为什么（只作附注） */
  reason: string
  /**
   * waiting：等人登录；withdrawn：代理不等了，标签已重新打开，提醒人别再在这里输入；
   * closed：没能安全地重新打开，标签已关掉，卡片不再指向标签
   */
  state: 'waiting' | 'withdrawn' | 'closed'
  /** 毫秒 */
  at: number
  /**
   * waiting 时卡片在哪一步。choose：等人选（用账号登录 / 我自己登录 / 拒绝）；
   * manual：人选了自己登录，等人点“完成，交还”或“取消”；filling：Litch 正在代填，没有按钮
   */
  stage: 'choose' | 'manual' | 'filling'
  /** 密码库里和 origin 完全一样的账号，最近用过的在前；没有就是空的，只能人自己登录 */
  accounts: BrowserSignInAccount[]
  /**
   * 预检不过、Litch 不能代填的原因（no_form、not_user_visible、locator_invalid、insecure、verification、
   * unavailable、origin_changed），能代填是 null。不过时账号还列着，只是点不了
   */
  fillBlocked: string | null
  /** 定时任务的回合才有：卡片上多一个“以后直接用这个账号”的勾选 */
  taskId: string | null
  /** 定时任务的回合才有：到这个时候（毫秒）没人答就过期 */
  expiresAt: number | null
  /** 桌面端出的随机数（转给手机签名用），界面不用 */
  nonce: string
  /** 谁选的代填（filling 时有）：桌面端，或者某台手机（name 是给人看的手机名，可能没有）；还没人答是 null */
  by: 'desktop' | { phoneId: string; name?: string } | null
}

/** 卡片上的一个已存账号。ref 是这张卡片里随机的编号，不是密码库的条目号 */
export interface BrowserSignInAccount {
  ref: string
  username: string
  /** 打了码的用户名（手机上用的那份） */
  masked: string
  /** 毫秒，没用过是 null */
  lastUsed: number | null
}

/**
 * done：人登录完、交还给代理；cancel：不登录了（卡片上的“拒绝”）；dismiss：“代理已收回”看过了；
 * self：我自己登录（choose → manual）；fill：用卡片上的这个账号由 Litch 代填代提交，
 * remember 是定时任务的“以后直接用这个账号”
 */
export type BrowserSignInAnswer =
  | 'done'
  | 'cancel'
  | 'dismiss'
  | 'self'
  | { fill: string; remember: boolean }

export interface BrowserSignInBridge {
  /** 现在挂着的 */
  list(): Promise<BrowserSignInRequest[]>
  /** 答一条，回答没答到（已经没了） */
  answer(id: string, answer: BrowserSignInAnswer): Promise<boolean>
  /** 变了，带着现在所有的 */
  onChanged(handler: (requests: BrowserSignInRequest[]) => void): () => void
  /** Litch 代填前要不要过 Touch ID。只有 macOS 有（available 为假时设置里不显示这个开关），默认关 */
  touchId(): Promise<BrowserTouchId>
  /** 开关，回新的样子 */
  setTouchId(on: boolean): Promise<BrowserTouchId>
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
  /** 代理请人登录的卡片（浏览器面板用） */
  signIn: BrowserSignInBridge
  /** 从别的浏览器导入 */
  import: BrowserImportBridge
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
  /** Windows 上有应用绑定的数据（多为 Cookie），这一版导不了那一部分 */
  needsElevation: boolean
  profiles: ImportProfile[]
}

export interface ImportRequest {
  browser: BrowserId
  profileId: string
  kinds: ImportKind[]
  /** 只导这些网站（含子域）的 Cookie；不给是全部。小写、无前导点 */
  cookieDomains?: string[]
  /** 这一版界面一律发 false */
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

/**
 * 外壳给的接口。普通浏览器里、不在页面里（界面的单元测试直接在 Node 里读源文件）时没有；
 * 普通浏览器里地址带 ?browser=preview 时是预览用的假外壳（preview-bridge.ts）
 */
export const browserBridge = (): BrowserBridge | undefined =>
  typeof window === 'undefined' ? undefined : (window.litchBrowser ?? previewBridge())

/** 会话的键 */
export const ownerKey = (owner: BrowserOwner): string => `${owner.deviceId}\u0000${owner.threadId}`

/** 外壳给的导入接口。没有外壳时没有 */
export const importBridge = (): BrowserImportBridge | undefined => browserBridge()?.import
