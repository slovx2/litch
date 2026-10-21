// 内存里的假密码库：管线的测试和样本模式用（样本模式不碰真的密码库）。
// 去重规则照 3.2 节：同源同用户名不覆盖。
import type { ImportedPassword } from '../protected-types.mjs'
import type { ImportCounts, PasswordSink } from '../sinks.mjs'

export interface MemoryPasswordSink extends PasswordSink {
  /** 存下来的（测试看），带来源 */
  readonly saved: (ImportedPassword & { source: string })[]
}

export function memoryPasswordSink(): MemoryPasswordSink {
  const saved: (ImportedPassword & { source: string })[] = []
  return {
    saved,
    async importMany(items, source) {
      const counts: ImportCounts = { imported: 0, skippedExisting: 0, skippedInvalid: 0, failed: 0 }
      for (const item of items) {
        const exists = saved.some(
          (one) => one.origin === item.origin && one.username === item.username,
        )
        if (exists) counts.skippedExisting += 1
        else {
          saved.push({ ...item, source })
          counts.imported += 1
        }
      }
      return counts
    },
  }
}
