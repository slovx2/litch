// 草稿图片的共同存储边界。外壳提供应用私有目录中的持久化文件；浏览器预览可用本地存储。
import type { ImageAttachment } from './model.mjs'

/** 按序列化后的 UTF-8 字节计，包含 base64 膨胀；不自动淘汰其他未发送草稿。 */
export const DRAFT_IMAGE_LIMIT = 128 * 1024 * 1024
export type DraftImageError = 'limit' | 'write' | null
export type DraftImageEntries = [string, ImageAttachment[]][]
export interface DraftImageStorage {
  read(): unknown
  write(entries: DraftImageEntries): void
  remove(): void
}

const valid = (image: unknown): image is ImageAttachment => {
  const value = image as ImageAttachment | null
  return (
    !!value &&
    typeof value.url === 'string' &&
    /^data:image\/(png|jpeg|webp|gif);base64,/.test(value.url) &&
    (value.name === null || typeof value.name === 'string')
  )
}

export class DraftImages {
  private readonly storage: DraftImageStorage
  private readonly memory = new Map<string, ImageAttachment[]>()
  private readonly saved = new Map<string, ImageAttachment[]>()
  constructor(storage: DraftImageStorage) {
    this.storage = storage
    try {
      const entries = storage.read()
      if (Array.isArray(entries))
        for (const entry of entries) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            Array.isArray(entry[1]) &&
            entry[1].every(valid)
          ) {
            this.memory.set(entry[0], entry[1])
            this.saved.set(entry[0], entry[1])
          }
        }
    } catch {
      // 缺失或损坏的文件不阻止打开输入区。
    }
  }
  load(key: string): ImageAttachment[] {
    return this.memory.get(key) ?? []
  }
  save(key: string, images: ImageAttachment[]): DraftImageError {
    if (this.memory.get(key) === images && this.saved.get(key) === images) return null
    if (images.length) this.memory.set(key, images)
    else this.memory.delete(key)
    const next = new Map(this.saved)
    next.delete(key)
    if (images.length) next.set(key, images)
    // 图片 URL 是 ASCII；文件名与键按 Unicode 码点计算 UTF-8 字节。
    let bytes = 0
    for (const char of JSON.stringify([...next])) {
      const code = char.codePointAt(0) as number
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
      if (bytes > DRAFT_IMAGE_LIMIT) break
    }
    const tooLarge = bytes > DRAFT_IMAGE_LIMIT
    if (tooLarge) next.delete(key)
    try {
      if (next.size) this.storage.write([...next])
      else this.storage.remove()
      this.saved.clear()
      for (const [id, list] of next) this.saved.set(id, list)
      return tooLarge ? 'limit' : null
    } catch {
      return 'write'
    }
  }
}
