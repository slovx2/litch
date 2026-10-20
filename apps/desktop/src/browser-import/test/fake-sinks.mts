// 内存里的假密码库、假浏览记录库：管线的测试用；样本模式下真的库还没接上时也用它们，让界面走得通。
// 去重规则照 3.2、3.3 节：密码同源同用户名不覆盖；浏览记录按（地址，访问时间）去重，超过 90 天的算无效。
import type { ImportedPassword } from '../protected-types.mjs'
import type { HistorySink, HistoryVisit, ImportCounts, PasswordSink } from '../sinks.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

export interface MemoryPasswordSink extends PasswordSink {
  /** 存下来的（测试看），带来源 */
  readonly saved: (ImportedPassword & { source: string })[]
}

export interface MemoryHistorySink extends HistorySink {
  readonly saved: (HistoryVisit & { source: string })[]
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

export function memoryHistorySink(now: () => number = Date.now): MemoryHistorySink {
  const saved: (HistoryVisit & { source: string })[] = []
  return {
    saved,
    async importMany(items, source) {
      const counts: ImportCounts = { imported: 0, skippedExisting: 0, skippedInvalid: 0, failed: 0 }
      const since = now() - 90 * DAY_MS
      for (const item of items) {
        if (item.visitedAt < since) counts.skippedInvalid += 1
        else if (saved.some((one) => one.url === item.url && one.visitedAt === item.visitedAt)) {
          counts.skippedExisting += 1
        } else {
          saved.push({ ...item, source })
          counts.imported += 1
        }
      }
      return counts
    },
  }
}
