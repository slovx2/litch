// “导过没有”：<用户数据>/browser/import.json 记每类最后一次成功导入的时间和横幅关掉的时间，界面据此决定出不出横幅。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IMPORT_KINDS, type ImportKind, type ImportState } from './types.mjs'

interface ImportFile {
  version: 1
  /** 每类最后一次成功导入的时间，Unix 毫秒（什么算成功见 pipeline.mts） */
  kinds: Partial<Record<ImportKind, number>>
  bannerDismissedAt?: number
}

export const importStateFile = (userData: string): string =>
  join(userData, 'browser', 'import.json')

export interface ImportStateBook {
  state(): ImportState
  imported(kinds: ImportKind[], at: number): void
  dismissBanner(at: number): void
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

function load(file: string): ImportFile {
  const empty: ImportFile = { version: 1, kinds: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ImportFile>
    const kinds: ImportFile['kinds'] = {}
    for (const kind of IMPORT_KINDS) {
      const at = parsed.kinds?.[kind]
      if (isTime(at)) kinds[kind] = at
    }
    const out: ImportFile = { version: 1, kinds }
    if (isTime(parsed.bannerDismissedAt)) out.bannerDismissedAt = parsed.bannerDismissedAt
    return out
  } catch {
    // 没有或坏了：当作从没导过
    return empty
  }
}

/** file：存的地方；null 只放内存（测试用） */
export function createImportStateBook(file: string | null): ImportStateBook {
  let data = file ? load(file) : { version: 1 as const, kinds: {} }
  const save = () => {
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(temp, file)
  }
  return {
    state() {
      const out: ImportState = {}
      const times = Object.values(data.kinds).filter(isTime)
      if (times.length > 0) out.lastImportAt = Math.max(...times)
      if (data.bannerDismissedAt) out.bannerDismissedAt = data.bannerDismissedAt
      return out
    },
    imported(kinds, at) {
      if (kinds.length === 0) return
      data = { ...data, kinds: { ...data.kinds } }
      for (const kind of kinds) data.kinds[kind] = at
      save()
    },
    dismissBanner(at) {
      data = { ...data, bannerDismissedAt: at }
      save()
    },
  }
}
