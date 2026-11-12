import { opendir } from 'node:fs/promises'
import { FILE_BROWSER_ENTRIES } from '../../protocol/src/file-browser.mjs'
import { ProtocolError } from './protocol-contract.mjs'

/** 在设备枚举时截断：内存、传输和排序都不随整个目录增长。 */
export async function readDirectoryBounded(path: string, raw: unknown) {
  const budget = raw as { maxEntries?: number } | null
  const limit = budget?.maxEntries
  if (
    !budget ||
    typeof budget !== 'object' ||
    Object.keys(budget).some((key) => key !== 'maxEntries') ||
    !Number.isSafeInteger(limit) ||
    (limit ?? 0) < 1 ||
    (limit ?? 0) > FILE_BROWSER_ENTRIES
  )
    throw new ProtocolError(-32602, '目录枚举预算无效')
  const entries: { fileName: string; isDirectory: boolean; isFile: boolean }[] = []
  const directory = await opendir(path, { bufferSize: 32 })
  let truncated = false
  try {
    while (true) {
      const entry = await directory.read()
      if (!entry) break
      if (entries.length === limit) {
        truncated = true
        break
      }
      entries.push({
        fileName: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      })
    }
  } finally {
    await directory.close()
  }
  return { entries, litchDirectory: { truncated } }
}
