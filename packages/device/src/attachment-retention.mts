import { lstat, lutimes, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ATTACHMENT_ID,
  ATTACHMENT_RETENTION_MS,
  type AttachmentState,
  parseFileAttachments,
} from '../../protocol/src/file-attachments.mjs'
import { parseSessionMentions } from '../../protocol/src/session-mentions.mjs'
import {
  attachmentDirectory,
  attachmentId,
  attachmentRoot,
  safeAttachmentTree,
} from './attachment-paths.mjs'
import {
  type AttachmentOwner,
  AttachmentRetentionStore,
  ownerKey,
} from './attachment-retention-store.mjs'

export const ATTACHMENT_SWEEP_MS = 24 * 60 * 60 * 1000
interface Options {
  home: string
  stateDir: string
  inUse(owner: AttachmentOwner): boolean
  /** 引擎状态不确定的会话也应加入返回集合。 */
  protectedOwners(owners: AttachmentOwner[]): Promise<Set<string>>
  now?: () => number
  interval?: (fn: () => void, ms: number) => () => void
  log?(text: string): void
}

export class AttachmentRetention {
  private readonly store: AttachmentRetentionStore
  private readonly now: () => number
  private work: Promise<void> | null = null
  private stopTimer: (() => void) | null = null
  private closed = false
  private views = new Map<string, Set<string>>()
  private touches = new Set<Promise<void>>()
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
    this.store = new AttachmentRetentionStore(options.stateDir)
    this.now = options.now ?? Date.now
  }

  /** 客户端视图包括只读归档会话；引用归属仍从实际历史读取。 */
  watch(peer: string, threadId: string, open: boolean): void {
    if (this.closed) return
    const peers = this.views.get(threadId) ?? new Set<string>()
    if (open) peers.add(peer)
    else peers.delete(peer)
    if (peers.size) this.views.set(threadId, peers)
    else this.views.delete(threadId)
  }
  left(peer: string): void {
    for (const [threadId, peers] of this.views) {
      peers.delete(peer)
      if (!peers.size) this.views.delete(threadId)
    }
  }
  private inUse(owner: AttachmentOwner): boolean {
    return this.views.has(owner.threadId) || this.options.inUse(owner)
  }

  /** 显式启动，测试构建设备对象不会扫描用户主目录。 */
  start(): Promise<void> {
    if (this.closed || this.stopTimer) return this.work ?? Promise.resolve()
    const interval =
      this.options.interval ??
      ((fn, ms) => {
        const timer = setInterval(fn, ms)
        timer.unref()
        return () => clearInterval(timer)
      })
    this.stopTimer = interval(() => void this.sweep(), ATTACHMENT_SWEEP_MS)
    return this.sweep()
  }

  /** 新输入和历史快照都登记；多会话引用同一个附件时，任一会话在用就保留。 */
  observe(harness: string, value: unknown): void {
    if (this.closed || !value || typeof value !== 'object') return
    const params = value as Record<string, unknown>
    const thread =
      params.thread && typeof params.thread === 'object'
        ? (params.thread as Record<string, unknown>)
        : null
    const threadId = thread?.id ?? params.threadId
    if (typeof threadId !== 'string') return
    const pending: unknown[] = [thread ?? params]
    const ids = new Set<string>()
    while (pending.length) {
      const next = pending.pop()
      if (!next || typeof next !== 'object') continue
      if (Array.isArray(next)) {
        for (const part of next) pending.push(part)
        continue
      }
      for (const [key, part] of Object.entries(next)) {
        if (key === 'text' && typeof part === 'string') {
          const body = parseSessionMentions(part)?.rest ?? part
          for (const file of parseFileAttachments(body)?.files ?? []) {
            if (file.location !== 'device') continue
            const id = attachmentId(this.options.home, file.path)
            if (id) ids.add(id)
          }
        } else if (part && typeof part === 'object') pending.push(part)
      }
    }
    for (const id of ids) {
      this.store.reference(id, { harness, threadId }, this.now())
      const touch = this.touch(id)
        .catch(() => {})
        .finally(() => this.touches.delete(touch))
      this.touches.add(touch)
    }
  }

  private async touch(id: string): Promise<void> {
    const root = await attachmentRoot(this.options.home)
    const dir = root ? await attachmentDirectory(root, id) : null
    if (!dir) return
    if ((await attachmentRoot(this.options.home)) !== root) return
    // lutimes 不跟随末段软链，避免核对后发生替换时修改链接目标。
    await lutimes(dir.path, new Date(this.now()), new Date(this.now()))
  }

  async status(path: string): Promise<{ state: AttachmentState }> {
    const id = attachmentId(this.options.home, path)
    if (!id || this.closed) return { state: 'unknown' }
    // 清理过程完成后再查询，不把正在删除的目录暂时画成可打开。
    await this.work
    const root = await attachmentRoot(this.options.home)
    if (!root) return { state: 'unknown' }
    const dir = await attachmentDirectory(root, id)
    if (!dir) return { state: this.store.cleaned(id) ? 'cleaned' : 'unknown' }
    const name = path.split(/[\\/]/).pop() ?? ''
    const file = join(dir.path, name)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file)
        return { state: 'unknown' }
      await this.touch(id)
      this.store.retained(id)
      return { state: 'available' }
    } catch {
      return { state: 'unknown' }
    }
  }

  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.work) return this.work
    this.work = this.collect()
      .catch((error: unknown) => {
        this.options.log?.(`附件清理失败：${String(error)}`)
      })
      .finally(() => {
        this.work = null
      })
    return this.work
  }

  private async collect(): Promise<void> {
    await Promise.all(this.touches)
    const root = await attachmentRoot(this.options.home)
    if (!root || this.closed) return
    const cutoff = this.now() - ATTACHMENT_RETENTION_MS
    const candidates: { id: string; owners: AttachmentOwner[] }[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !ATTACHMENT_ID.test(entry.name))
        continue
      const dir = await attachmentDirectory(root, entry.name)
      if (dir && dir.info.mtimeMs < cutoff && this.store.used(entry.name) < cutoff)
        candidates.push({ id: entry.name, owners: this.store.owners(entry.name) })
    }
    const owners = [
      ...new Map(candidates.flatMap((c) => c.owners).map((o) => [ownerKey(o), o])).values(),
    ]
    const protectedOwners = owners.length
      ? await this.options.protectedOwners(owners)
      : new Set<string>()
    for (const { id, owners } of candidates) {
      if (this.closed) return
      if (owners.some((o) => protectedOwners.has(ownerKey(o)) || this.inUse(o))) {
        await this.touch(id)
        continue
      }
      try {
        const dir = await attachmentDirectory(root, id)
        if (!dir || !(await safeAttachmentTree(root, dir.path))) continue
        // 路径、文件身份、修改时间和活跃状态在删除前重新确认，拒绝扫描期间的替换。
        if ((await attachmentRoot(this.options.home)) !== root) continue
        const fresh = await attachmentDirectory(root, id)
        if (
          !fresh ||
          fresh.info.dev !== dir.info.dev ||
          fresh.info.ino !== dir.info.ino ||
          fresh.info.mtimeMs >= cutoff ||
          this.store.used(id) >= cutoff ||
          owners.some((o) => this.inUse(o))
        )
          continue
        this.store.deleting(id, this.now())
        try {
          await rm(fresh.path, { recursive: true, force: false })
        } catch (error) {
          this.store.retained(id)
          throw error
        }
      } catch (error) {
        this.options.log?.(`跳过附件清理：${String(error)}`)
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.stopTimer?.()
    this.stopTimer = null
    await this.work
    await Promise.all(this.touches)
    this.store.close()
  }
}
