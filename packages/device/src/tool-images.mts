import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { IMAGE_BYTES, type ImageReadResult } from '../../protocol/src/media-images.mjs'
import {
  TOOL_IMAGE_LIMIT,
  TOOL_IMAGE_PREFIX,
  type ToolImage,
} from '../../protocol/src/tool-images.mjs'
import { MediaImages } from './media-images.mjs'
import { isObject } from './wire.mjs'

const MAX_BYTES = 512 * 1024 * 1024
const MAX_AGE = 30 * 86400_000
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const picture = (block: unknown): boolean =>
  isObject(block) && ['image', 'inputImage', 'input_image'].includes(String(block.type))

/** 原始图片只存设备私有数据库；只接工具结果，不遍历参数、用户附件或任意 JSON。 */
export class ToolImages {
  private readonly db: DatabaseSync
  private readonly media = new MediaImages()
  private readonly pending = new Map<string, Promise<ToolImage | null>>()
  private savedImages(value: unknown): ToolImage[] {
    return JSON.parse(String(value)).flatMap((ref: { id: string; tool: string }) => {
      const row = this.db.prepare('SELECT meta FROM images WHERE id = ?').get(ref.id)
      return row ? [{ ...JSON.parse(String(row.meta)), tool: ref.tool }] : []
    })
  }
  private decodeJobs = 0
  private activeReads = 0
  private closed = false
  private workers = new Set<Worker>()
  private readonly cleanup: NodeJS.Timeout
  readonly enabled: () => boolean
  constructor(directory: string, enabled: () => boolean) {
    this.enabled = () => !this.closed && enabled()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'tool-images.sqlite')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL;
      CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, data BLOB NOT NULL, meta TEXT NOT NULL, used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS items(key TEXT PRIMARY KEY, refs TEXT NOT NULL, used INTEGER NOT NULL);`)
    this.prune()
    this.cleanup = setInterval(() => this.prune(), 3600_000).unref()
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.cleanup)
    this.media.close()
    for (const worker of this.workers) void worker.terminate()
    this.db.close()
  }
  private prune(): void {
    const cutoff = Date.now() - MAX_AGE
    this.db.prepare('DELETE FROM images WHERE used < ?').run(cutoff)
    this.db.prepare('DELETE FROM items WHERE used < ?').run(cutoff)
    let size = Number(
      this.db.prepare('SELECT coalesce(sum(length(data) + length(meta)),0) AS n FROM images').get()
        ?.n,
    )
    for (const row of this.db
      .prepare('SELECT id, length(data) + length(meta) AS n FROM images ORDER BY used')
      .iterate()) {
      if (size <= MAX_BYTES) break
      this.db.prepare('DELETE FROM images WHERE id = ?').run(String(row.id))
      size -= Number(row.n)
    }
    this.db.exec(
      'DELETE FROM items WHERE key IN (SELECT key FROM items ORDER BY used DESC LIMIT -1 OFFSET 10000); PRAGMA incremental_vacuum(256)',
    )
  }
  async read(source: string): Promise<ImageReadResult> {
    if (!this.enabled()) return { kind: 'unsupported' }
    if (this.activeReads >= 4) return { kind: 'busy' }
    this.activeReads++
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      return this.readSaved(source)
    } finally {
      this.activeReads--
    }
  }
  private readSaved(source: string): ImageReadResult {
    if (!this.enabled()) return { kind: 'unsupported' }
    const id = source.slice(TOOL_IMAGE_PREFIX.length)
    if (!/^[a-f0-9]{64}$/.test(id)) return { kind: 'invalid' }
    const row = this.db
      .prepare('SELECT data FROM images WHERE id = ? AND used >= ?')
      .get(id, Date.now() - MAX_AGE)
    if (!row || !(row.data instanceof Uint8Array)) return { kind: 'missing' }
    this.db.prepare('UPDATE images SET used = ? WHERE id = ?').run(Date.now(), id)
    const data = Buffer.from(row.data)
    return {
      kind: 'ready',
      format: 'image',
      bytes: data.length,
      dataBase64: data.toString('base64'),
    }
  }
  private async asset(bytes: Buffer, tool: string): Promise<ToolImage | null> {
    if (!this.enabled() || bytes.length < 24 || bytes.length > IMAGE_BYTES) return null
    const id = hash(bytes)
    const row = this.db.prepare('SELECT meta FROM images WHERE id = ?').get(id)
    if (row) return { ...JSON.parse(String(row.meta)), tool }
    const waiting = this.pending.get(id)
    if (waiting) {
      const found = await waiting
      return found ? { ...found, tool } : null
    }
    if (this.decodeJobs >= 2) {
      await Promise.race(this.pending.values())
      return this.asset(bytes, tool)
    }
    this.decodeJobs++
    const job = new Promise<ToolImage | null>((resolve) => {
      const worker = new Worker(new URL('./tool-image-thumbnail.mjs', import.meta.url), {
        workerData: bytes,
        resourceLimits: { maxOldGenerationSizeMb: 160 },
      })
      this.workers.add(worker)
      const timer = setTimeout(() => {
        void worker.terminate()
        resolve(null)
      }, 5000)
      worker.once('message', (meta: Omit<ToolImage, 'id' | 'tool'> | null) => {
        clearTimeout(timer)
        if (!meta || !this.enabled()) return resolve(null)
        const image = { ...meta, id, tool }
        this.db
          .prepare('INSERT OR IGNORE INTO images VALUES (?, ?, ?, ?)')
          .run(id, bytes, JSON.stringify(image), Date.now())
        this.prune()
        resolve(image)
      })
      worker.once('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      worker.once('exit', () => {
        this.workers.delete(worker)
        clearTimeout(timer)
        resolve(null)
      })
    }).finally(() => {
      this.pending.delete(id)
      this.decodeJobs--
    })
    this.pending.set(id, job)
    return job
  }
  private async blockImage(block: unknown, tool: string): Promise<ToolImage | null> {
    if (!isObject(block)) return null
    const source = isObject(block.source) ? block.source : block
    let data = typeof source.data === 'string' ? source.data : null
    if (!data) {
      const url = block.imageUrl ?? block.image_url
      if (typeof url !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(url))
        return null
      data = url.slice(url.indexOf(',') + 1)
    }
    if (
      data.length > Math.ceil(IMAGE_BYTES / 3) * 4 ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      return null
    return this.asset(Buffer.from(data, 'base64'), tool)
  }
  /** 同一条目首次得到的图片稳定绑定；历史重开不因源文件后来改变而换图。 */
  private async item(item: Record<string, unknown>, owner: string): Promise<boolean> {
    if (
      !['mcpToolCall', 'dynamicToolCall', 'functionCallOutput', 'imageView'].includes(
        String(item.type),
      )
    )
      return false
    const tool = String(item.tool ?? item.name ?? 'view_image').slice(0, 256)
    const result = isObject(item.result) ? item.result : null
    const blocks =
      item.type === 'mcpToolCall'
        ? result?.content
        : item.type === 'dynamicToolCall'
          ? item.contentItems
          : item.output
    const images = Array.isArray(blocks) ? blocks.filter(picture) : []
    const key = hash(`${owner}:${String(item.id)}`)
    let refs: ToolImage[] = []
    if (this.enabled()) {
      const saved = this.db.prepare('SELECT refs FROM items WHERE key = ?').get(key)
      if (saved) refs = this.savedImages(saved.refs)
      for (const block of images.slice(0, TOOL_IMAGE_LIMIT)) {
        const image = await this.blockImage(block, tool)
        if (image && !refs.some((ref) => ref.id === image.id)) refs.push(image)
      }
      if (!refs.length && item.type === 'imageView' && String(item.id).endsWith(':image')) {
        const original = this.db
          .prepare('SELECT refs FROM items WHERE key = ?')
          .get(hash(`${owner}:${String(item.id).slice(0, -6)}`))
        if (original) refs = this.savedImages(original.refs)
      }
      if (!saved && !refs.length && item.type === 'imageView' && typeof item.path === 'string') {
        const read = await this.media.read('tool-images', item.path)
        if (read.kind === 'ready') {
          const image = await this.asset(Buffer.from(read.dataBase64, 'base64'), tool)
          if (image) refs.push(image)
        }
      }
      refs = refs.slice(0, TOOL_IMAGE_LIMIT)
      if (refs.length && this.enabled())
        this.db
          .prepare('INSERT OR REPLACE INTO items VALUES (?, ?, ?)')
          .run(key, JSON.stringify(refs.map(({ id, tool }) => ({ id, tool }))), Date.now())
    }
    // 面向声明过能力的 UI，原始大图一律摘下；不能让关闭开关绕回旧的内联显示路径。
    if (Array.isArray(blocks) && images.length) {
      const clean = blocks.filter((block) => !picture(block))
      if (item.type === 'mcpToolCall' && result) item.result = { ...result, content: clean }
      else if (item.type === 'dynamicToolCall') item.contentItems = clean
      else item.output = clean
    }
    delete item.litchToolImages
    if (this.enabled() && refs.length) item.litchToolImages = refs
    return images.length > 0 || item.type === 'imageView' || refs.length > 0
  }
  /** 仅沿标准条目容器前进，不误读用户消息/工具参数里的路径或图片。 */
  async decorate(value: unknown, owner: string): Promise<boolean> {
    if (!isObject(value)) return false
    // experimental rawResponseItem 通知也可能含原始工具图片。客户端不用它恢复图，仍须剥离大图。
    if (
      ['function_call_output', 'custom_tool_call_output'].includes(String(value.type)) &&
      Array.isArray(value.output)
    ) {
      const clean = value.output.filter((block) => !picture(block))
      if (clean.length === value.output.length) return false
      value.output = clean
      return true
    }
    if (typeof value.type === 'string' && typeof value.id === 'string')
      return this.item(value, owner)
    let changed = false
    const thread = isObject(value.thread) ? value.thread : null
    const nextOwner =
      thread && typeof thread.id === 'string'
        ? `${owner.split(':')[0]}:${thread.id}`
        : typeof value.threadId === 'string'
          ? `${owner.split(':')[0]}:${value.threadId}`
          : owner
    // 恢复首屏放在内嵌分页里；沿用本次应答确定的会话归属和外层连接能力闸。
    for (const key of ['thread', 'turn', 'item', 'initialTurnsPage'])
      if (isObject(value[key])) changed = (await this.decorate(value[key], nextOwner)) || changed
    for (const key of ['turns', 'items', 'data'])
      if (Array.isArray(value[key]))
        for (const child of value[key]) changed = (await this.decorate(child, nextOwner)) || changed
    return changed
  }
}
