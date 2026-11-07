import type { JsonFile } from '../shell/json-file'
import type { ConsentRecords } from './consent'

const CHOICE = '@permission'
export type ConsentView = 'notice' | 'required' | null

// 用户要求沿用 0.35.x 已保存的许可。只接受旧格式的真实目标记录，空文件不是同意。
function choice(records: ConsentRecords | null): 'allowed' | 'declined' | null {
  if (!records || typeof records !== 'object' || Array.isArray(records)) return null
  if (records[CHOICE] === 'allowed' || records[CHOICE] === 'declined') return records[CHOICE]
  for (const [key, revision] of Object.entries(records)) {
    if (typeof revision !== 'string' || !revision) continue
    try {
      const target: unknown = JSON.parse(key)
      if (
        Array.isArray(target) &&
        target.length === 3 &&
        target[2] !== 'attachment-upload' &&
        target.every((v) => typeof v === 'string' && v)
      )
        return 'allowed'
    } catch {
      // 其他键不是旧版已保存的服务许可。
    }
  }
  return null
}

export function createConsentAccess(records: JsonFile<ConsentRecords>) {
  let view: ConsentView = null
  const listeners = new Set<() => void>()
  const show = (next: ConsentView) => {
    view = next
    for (const listener of listeners) listener()
  }
  return {
    current: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    allowed: () => choice(records.read()) === 'allowed',
    launch(platform: string) {
      if (platform !== 'ios') return
      const saved = choice(records.read())
      if (saved === null) show('notice')
    },
    open: () => show('notice'),
    require() {
      if (view !== 'notice') show('required')
    },
    close: () => show(null),
    answer(allow: boolean) {
      // 写盘成功后才关闭告知；不能只在内存里假装保存过许可。
      records.write({ [CHOICE]: allow ? 'allowed' : 'declined' })
      show(null)
    },
    withdraw() {
      // 明确拒绝也要保存，撤回/重启不能再次自动弹出首次告知。
      records.write({ [CHOICE]: 'declined' })
      show(null)
    },
  }
}

export type ConsentAccess = ReturnType<typeof createConsentAccess>
