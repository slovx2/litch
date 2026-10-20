// 导入管线把密码和浏览记录交出去的接口：密码库（browser/passwords/）、浏览记录库（browser/history/）照着实现。
// 管线只对这两个接口编程，不认识它们怎么存。
import type { ImportedPassword } from './protected-types.mjs'

export interface ImportCounts {
  imported: number
  skippedExisting: number
  skippedInvalid: number
  failed: number
}

/** source 是来源的标识，比如 `chrome:Default`，存进记录里方便以后看来源 */
export interface PasswordSink {
  importMany(items: ImportedPassword[], source: string): Promise<ImportCounts>
}

export interface HistoryVisit {
  url: string
  title: string
  /** Unix 毫秒 */
  visitedAt: number
}

export interface HistorySink {
  importMany(items: HistoryVisit[], source: string): Promise<ImportCounts>
}
