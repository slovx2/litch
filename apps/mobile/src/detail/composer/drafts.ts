// 没发出去的草稿，按会话记：文字存进应用文档目录的 drafts.json（离开再进、杀掉应用重开都还在），
// 图片只记在内存里（data URL 太大，不往文件里放；重开应用就没了，和桌面端一样）。
// 写文件攒一下再写：每敲一个字同步写一次文件会占 JS 线程。离开页面时当场写（flushDrafts）。
import type { ImageAttachment } from '@litch/core'
import { jsonFile } from '../../shell/json-file'

/** 最多留这么多个会话的草稿，超出时丢掉最早写的 */
const LIMIT = 200
const WRITE_DELAY_MS = 600

const file = jsonFile<[string, string][]>('drafts.json')
let texts: Map<string, string> | null = null
const images = new Map<string, ImageAttachment[]>()
let timer: ReturnType<typeof setTimeout> | null = null

function all(): Map<string, string> {
  if (texts) return texts
  texts = new Map()
  const stored = file.read()
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
        texts.set(entry[0], entry[1])
    }
  }
  return texts
}

/** 草稿的键：哪台设备上的哪个会话。新建会话页用 `new:<设备>` */
export const draftKey = (deviceId: string, sessionId: string): string => `${deviceId}\n${sessionId}`

export const loadDraft = (key: string): string => all().get(key) ?? ''

export function saveDraft(key: string, text: string): void {
  const map = all()
  if ((map.get(key) ?? '') === text) return
  // 删了再放，最近写的排在最后
  map.delete(key)
  if (text) map.set(key, text)
  while (map.size > LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  if (timer === null) timer = setTimeout(flushDrafts, WRITE_DELAY_MS)
}

/** 攒着没写的现在写进文件 */
export function flushDrafts(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (!texts) return
  try {
    file.write([...texts])
  } catch {
    // 写不进去不影响这次使用
  }
}

export const loadDraftImages = (key: string): ImageAttachment[] => images.get(key) ?? []

export function saveDraftImages(key: string, list: ImageAttachment[]): void {
  if (list.length) images.set(key, list)
  else images.delete(key)
}

export function dropDraft(key: string): void {
  saveDraft(key, '')
  images.delete(key)
}
