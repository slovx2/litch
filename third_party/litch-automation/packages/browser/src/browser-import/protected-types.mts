// 读取器（protected/，归用户）和管线之间的接口：读来源浏览器里受保护的两类数据，Cookie 和已保存的密码。
// 改这份要和读取器那边商量。
import type { BrowserId } from './types.mjs'

export type ProtectedKind = 'cookies' | 'passwords'

/** 读取器在这台机器上能读哪几类（不看资料，只看平台和来源），界面据此置灰 */
export interface ProtectedCapabilities {
  /** 读之前会不会弹系统授权（Mac 钥匙串之类），界面提前告诉用户 */
  promptsSystemAuth: boolean
  /** Windows 上这个来源要不要管理员同意才能读 */
  needsElevation: boolean
  kinds: ProtectedKind[]
}

export interface ProtectedReadInput {
  browser: BrowserId
  family: 'chromium' | 'firefox'
  /** 资料根目录：Chromium 系是 User Data 那层（含 Local State），Firefox 是 profiles.ini 所在的目录。主进程已重新发现、校验过 */
  root: string
  /** 这份资料目录的绝对路径 */
  profileDir: string
  kinds: ProtectedKind[]
  /** 只要这些域名（含子域）的 Cookie；不给或空 = 全部。规范化过：小写、无前导点 */
  cookieDomains?: string[]
  /** 用户勾了“允许管理员权限”才是 true；false 时遇到需要提权的，返回 needs-elevation，不许自己提权 */
  allowElevated: boolean
  signal: AbortSignal
}

export type ProtectedStatus =
  | 'ok' // 全读到了
  | 'partial' // 读到一部分，failed > 0
  | 'missing' // 这份资料里没有这类数据
  | 'locked' // 来源浏览器开着、文件被占用
  | 'denied' // 系统授权被用户拒了（钥匙串弹框点了拒绝等）
  | 'needs-elevation' // 要管理员同意但 allowElevated 是 false
  | 'unsupported' // 这个平台或来源读不了
  | 'cancelled'
  | 'failed'

export interface ProtectedKindResult<T> {
  status: ProtectedStatus
  /** 来源里一共多少条（含读失败的） */
  discovered: number
  items: T[]
  /** 读或解不出来的条数 */
  failed: number
  /** 给人看的一句话（英文，界面另有翻译的说法），不许含任何 Cookie 值、密码、密钥 */
  error?: string
}

export interface ImportedCookie {
  /** 来源里的主机键原样：`.example.com` 表示含子域，`example.com` 表示只这台主机 */
  host: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  /** Unix 秒；会话 Cookie 不给 */
  expires?: number
  /** Unix 秒 */
  created?: number
  lastAccessed?: number
  /** 分区 Cookie（CHIPS）的顶层站点，比如 `https://example.com`；普通 Cookie 不给 */
  partitionTopSite?: string
}

export interface ImportedPassword {
  /** 登录页的源，`https://accounts.example.com`；安卓应用等非网页的条目不给，计入 failed 以外的“跳过”由管线处理 */
  origin: string
  /** 完整的登录页地址（来源有就给） */
  url?: string
  /** 表单提交去的源（来源有就给） */
  actionOrigin?: string
  username: string
  password: string
  usernameField?: string
  passwordField?: string
  /** Unix 秒 */
  created?: number
  lastUsed?: number
  /** Chromium 系分本地资料和登录账号两份，Firefox 一律 profile */
  store: 'profile' | 'account'
}

export interface ProtectedReadResult {
  cookies?: ProtectedKindResult<ImportedCookie>
  passwords?: ProtectedKindResult<ImportedPassword>
}

export interface ProtectedReader {
  capabilities(browser: BrowserId): ProtectedCapabilities
  /** 只为 input.kinds 里的类别返回结果。不许抛：一切出错都进各类的 status */
  read(input: ProtectedReadInput): Promise<ProtectedReadResult>
}
