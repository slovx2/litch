import type { FilePreview, PreviewKind } from '@litch/core'
import type { PreviewScope } from './contract.ts'

type Read = (scope: PreviewScope, format: PreviewKind, signal: AbortSignal) => Promise<FilePreview>
/** 缓存只属于打开的预览会话，不进入持久化；按 base64 与解码副本估算字节。 */
export class PreviewResources {
  private cache = new Map<string, FilePreview>()
  private pending = new Map<string, Promise<FilePreview>>()
  private used = 0
  private running = 0
  private queue: (() => void)[] = []
  private images = new Set<string>()
  private imageBytes = 0
  private pixels = new Map<string, number>()
  /** 同一文档的解码像素总额，防止小压缩图累计占用大量显存。 */
  claimPixels(key: string, count: number): boolean {
    if (this.pixels.has(key)) return true
    if (count + [...this.pixels.values()].reduce((sum, n) => sum + n, 0) > 40_000_000) return false
    this.pixels.set(key, count)
    return true
  }
  readonly abort = new AbortController()

  constructor(privateRead: Read) {
    this.read = privateRead
  }
  private read: Read

  async load(scope: PreviewScope, format: PreviewKind, image = false): Promise<FilePreview> {
    const key = JSON.stringify([scope.deviceId, scope.root, scope.path, format])
    const pending = this.pending.get(key)
    if (pending) return pending
    const work = this.readOne(scope, format, image, key)
    this.pending.set(key, work)
    try {
      return await work
    } finally {
      if (this.pending.get(key) === work) this.pending.delete(key)
    }
  }

  private async readOne(
    scope: PreviewScope,
    format: PreviewKind,
    image: boolean,
    key: string,
  ): Promise<FilePreview> {
    if (this.abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const cached = this.cache.get(key)
    if (cached) return cached
    if (image && !this.images.has(key)) {
      if (this.images.size >= 16)
        return { kind: 'tooLarge', path: scope.path, bytes: 17, limit: 16 }
      this.images.add(key)
    }
    if (this.running >= 2) await new Promise<void>((resolve) => this.queue.push(resolve))
    else this.running++
    if (this.abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    try {
      if (image && this.imageBytes >= 16 * 1024 * 1024)
        return {
          kind: 'tooLarge',
          path: scope.path,
          bytes: this.imageBytes,
          limit: 16 * 1024 * 1024,
        }
      const content = await this.read(scope, format, this.abort.signal)
      if (this.abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      if (content.kind === 'ready') {
        if (image) {
          this.imageBytes += content.bytes
          if (this.imageBytes > 16 * 1024 * 1024)
            return {
              kind: 'tooLarge',
              path: scope.path,
              bytes: this.imageBytes,
              limit: 16 * 1024 * 1024,
            }
        }
        const cost = content.bytes + content.dataBase64.length * 2
        while (this.used + cost > 32 * 1024 * 1024 && this.cache.size) {
          const oldest = this.cache.keys().next().value
          if (oldest === undefined) break
          const previous = this.cache.get(oldest)
          if (previous?.kind === 'ready')
            this.used -= previous.bytes + previous.dataBase64.length * 2
          this.cache.delete(oldest)
        }
        if (cost <= 32 * 1024 * 1024) {
          this.cache.set(key, content)
          this.used += cost
        }
      }
      return content
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.running--
    }
  }

  dispose(): void {
    this.abort.abort()
    for (const next of this.queue.splice(0)) next()
    this.cache.clear()
    this.pending.clear()
    this.pixels.clear()
    this.used = 0
  }
}
