// 从别的浏览器导入：主进程和界面之间的数据形状（界面那边的类型在 packages/ui/src/side/browser/bridge.ts，改一边改另一边）。
// 这里只有能放心交给界面的东西：条数、状态、资料名，没有 Cookie 的值、密码、密钥。

import type { ProtectedStatus } from './protected-types.mjs'
import type { ImportCounts } from './sinks.mjs'

/** 认得的来源 */
export const BROWSER_IDS = [
  'chrome',
  'edge',
  'brave',
  'arc',
  'chromium',
  'vivaldi',
  'firefox',
] as const
export type BrowserId = (typeof BROWSER_IDS)[number]

export type BrowserFamily = 'chromium' | 'firefox'

export const IMPORT_KINDS = ['cookies', 'passwords'] as const
export type ImportKind = (typeof IMPORT_KINDS)[number]

export interface ImportProfile {
  /** Chromium 系是资料目录名（`Default`、`Profile 1`），Firefox 是 profiles.ini 里的 Path */
  id: string
  name: string
  account?: string
  isDefault: boolean
  /** 这份资料里有哪几类数据（只看文件在不在，不打开 Cookie 和密码库） */
  has: Record<ImportKind, boolean>
}

export interface ImportSource {
  browser: BrowserId
  /** 产品名，不翻译 */
  name: string
  /** 读取器在这台机器上能读的（密码还要密码库接上） */
  kinds: ImportKind[]
  promptsSystemAuth: boolean
  needsElevation: boolean
  profiles: ImportProfile[]
}

export interface ImportRequest {
  browser: BrowserId
  profileId: string
  kinds: ImportKind[]
  cookieDomains?: string[]
  allowElevated: boolean
}

/** skipped：写 Cookie 的时候取消了，密码读到了但没轮上写 */
export type ImportKindStatus = ProtectedStatus | 'skipped'

export interface ImportKindOutcome extends ImportCounts {
  status: ImportKindStatus
  discovered: number
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

export interface ImportState {
  lastImportAt?: number
  bannerDismissedAt?: number
}

/** 挂在 window.litchBrowser.import 上（预加载 browser-import/bridge.mts） */
export interface BrowserImportBridge {
  sources(): Promise<ImportSource[]>
  start(request: ImportRequest): Promise<ImportOutcome>
  cancel(): Promise<void>
  onProgress(listener: (progress: ImportProgress) => void): () => void
  state(): Promise<ImportState>
  dismissBanner(): Promise<void>
}
