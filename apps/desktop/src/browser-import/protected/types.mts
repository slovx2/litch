// 临时接口副本。管线合入后换成 ../protected-types.mts 的类型并删除本文件。
export type BrowserId = 'chrome' | 'edge' | 'brave' | 'arc' | 'chromium' | 'vivaldi' | 'firefox'
export type ProtectedKind = 'cookies' | 'passwords'
export interface ProtectedCapabilities {
  promptsSystemAuth: boolean
  needsElevation: boolean
  kinds: ProtectedKind[]
}
export interface ProtectedReadInput {
  browser: BrowserId
  family: 'chromium' | 'firefox'
  root: string
  profileDir: string
  kinds: ProtectedKind[]
  cookieDomains?: string[]
  allowElevated: boolean
  signal: AbortSignal
}
export type ProtectedStatus =
  | 'ok'
  | 'partial'
  | 'missing'
  | 'locked'
  | 'denied'
  | 'needs-elevation'
  | 'unsupported'
  | 'cancelled'
  | 'failed'
export interface ProtectedKindResult<T> {
  status: ProtectedStatus
  discovered: number
  items: T[]
  failed: number
  error?: string
}
export interface ImportedCookie {
  host: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expires?: number
  created?: number
  lastAccessed?: number
  partitionTopSite?: string
}
export interface ImportedPassword {
  origin: string
  url?: string
  actionOrigin?: string
  username: string
  password: string
  usernameField?: string
  passwordField?: string
  created?: number
  lastUsed?: number
  store: 'profile' | 'account'
}
export interface ProtectedReadResult {
  cookies?: ProtectedKindResult<ImportedCookie>
  passwords?: ProtectedKindResult<ImportedPassword>
}
export interface ProtectedReader {
  capabilities(browser: BrowserId): ProtectedCapabilities
  read(input: ProtectedReadInput): Promise<ProtectedReadResult>
}
