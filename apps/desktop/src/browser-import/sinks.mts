// 导入管线把密码交出去的接口：密码库（browser/passwords/）照着实现。管线只对这个接口编程，不认识它怎么存。
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
