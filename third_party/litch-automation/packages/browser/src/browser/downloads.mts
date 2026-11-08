// 一次请求接收至私有目录，审批只决定是否发布；不暂停、续传或重放一次性下载。
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ClientToolContext } from '../tool-port.mjs'
import { publishDownloadFile } from './download-files.mjs'
import type { TabInfo, TabOwner } from './model.mjs'

export interface BrowserDownload {
  id: string
  owner: TabOwner
  tabId: string
  filename: string
  origin: string
  totalBytes: number | null
  receivedBytes: number
  status: 'pending' | 'receiving' | 'completed' | 'declined' | 'failed'
  path?: string
  error?: string
}

/** Electron DownloadItem 用到的那几项；按结构写，不让包的 Node 入口带上 electron 类型。 */
interface Item {
  getFilename(): string
  getURL(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  setSavePath(path: string): void
  cancel(): void
  on(
    event: 'updated',
    listener: (event: unknown, state: 'progressing' | 'interrupted') => void,
  ): unknown
  once(
    event: 'done',
    listener: (event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void,
  ): unknown
}
interface Transfer {
  view: BrowserDownload
  item: Item
  file: string
  directory: string
  approved: boolean
  received: boolean
  publishing: boolean
  prompting: boolean
  timer: ReturnType<typeof setTimeout>
  decisions: Set<() => void>
  agent: boolean
}

interface DownloadOptions {
  stagingRoot: string
  downloadsDirectory: string
  maxBytes?: number
  maxTotalBytes?: number
  timeoutMs?: number
}

export function safeDownloadName(name: string): string {
  // 两种系统的路径分隔符、控制字符和 Windows 保留名都处理，避免跨平台逃出下载目录。
  let clean = basename(name.replaceAll('\\', '/'))
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180)
  const characters = [...clean]
  while (Buffer.byteLength(characters.join('')) > 180) characters.pop()
  clean = characters.join('').replace(/[. ]+$/g, '')
  if (!clean || /^\.+$/.test(clean)) clean = 'download'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `_${clean}`
  return clean
}

export class BrowserDownloads {
  private readonly transfers = new Map<string, Transfer>()
  private readonly listeners = new Set<() => void>()
  private disposed = false
  readonly maxBytes: number
  readonly maxTotalBytes: number
  private readonly timeoutMs: number
  private readonly options: DownloadOptions
  private readonly canonicalRoot: string

  constructor(options: DownloadOptions) {
    this.options = options
    this.maxBytes = options.maxBytes ?? 1024 ** 3
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 ** 3
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000
    // 此目录仅由下载管理器管理；重启后绝不恢复旧审批或重试旧 URL。
    rmSync(options.stagingRoot, { recursive: true, force: true })
    mkdirSync(options.stagingRoot, { recursive: true, mode: 0o700 })
    this.canonicalRoot = realpathSync(options.stagingRoot)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  list(owner?: TabOwner, agentOnly = false): BrowserDownload[] {
    return [...this.transfers.values()]
      .filter(
        ({ view, agent }) =>
          (!agentOnly || agent) &&
          (!owner ||
            (view.owner.deviceId === owner.deviceId && view.owner.threadId === owner.threadId)),
      )
      .map(({ view }) => ({ ...view, owner: { ...view.owner } }))
  }
  blocksPath(path: string): boolean {
    // macOS 的 /var 和 /private/var 可能指向同一个目录，必须同时检查实际路径。
    return [resolve(this.options.stagingRoot), this.canonicalRoot].some((root) => {
      const part = relative(root, resolve(path))
      return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
    })
  }
  private active(t: Transfer): boolean {
    return ['pending', 'receiving'].includes(t.view.status)
  }
  private cleanup(t: Transfer): void {
    clearTimeout(t.timer)
    rmSync(t.directory, { recursive: true, force: true })
  }
  private finish(t: Transfer, status: 'declined' | 'failed', error?: string): void {
    if (!this.active(t) || t.publishing) return
    t.view.status = status
    if (error) t.view.error = error
    try {
      t.item.cancel()
    } catch {
      /* 已完成或已销毁的 DownloadItem 不再接收 cancel。 */
    }
    this.cleanup(t)
    for (const done of t.decisions) done()
    this.changed()
  }
  capture(item: Item, tab: TabInfo): void {
    if (this.disposed) {
      item.cancel()
      return
    }
    const directory = mkdtempSync(join(this.options.stagingRoot, 'transfer-'))
    const id = randomUUID()
    let origin = 'unknown'
    try {
      const url = new URL(item.getURL())
      origin = url.origin === 'null' ? new URL(tab.url).origin : url.origin
    } catch {}
    const total = item.getTotalBytes()
    const approved = tab.kind === 'user'
    const t: Transfer = {
      view: {
        id,
        tabId: tab.id,
        owner: { ...tab.owner },
        filename: safeDownloadName(item.getFilename()),
        origin,
        totalBytes: total > 0 ? total : null,
        receivedBytes: 0,
        status: approved ? 'receiving' : 'pending',
      },
      item,
      directory,
      file: join(directory, 'payload'),
      approved,
      received: false,
      publishing: false,
      prompting: false,
      decisions: new Set(),
      agent: !approved,
      timer: setTimeout(
        () => this.finish(t, 'failed', 'Download or approval timed out; no automatic retry.'),
        this.timeoutMs,
      ),
    }
    this.transfers.set(id, t)
    // setSavePath 必须同步调用。所有文件都先暂存，完成后才以排他创建发布，避免重名覆盖。
    item.setSavePath(t.file)
    item.on('updated', (_event, state) => {
      if (!this.active(t)) return
      if (state === 'interrupted') {
        this.finish(t, 'failed', 'Download was interrupted; no automatic retry.')
        return
      }
      t.view.receivedBytes = item.getReceivedBytes()
      const size = item.getTotalBytes()
      if (size > 0) t.view.totalBytes = size
      const sum = [...this.transfers.values()]
        .filter((one) => this.active(one))
        .reduce((n, one) => n + one.view.receivedBytes, 0)
      if (
        t.view.receivedBytes > this.maxBytes ||
        (t.view.totalBytes ?? 0) > this.maxBytes ||
        sum > this.maxTotalBytes
      )
        this.finish(t, 'failed', 'Download size limit exceeded; no automatic retry.')
      else this.changed()
    })
    item.once('done', (_event, state) => {
      if (!this.active(t)) {
        this.cleanup(t)
        return
      }
      if (state !== 'completed') {
        this.finish(t, 'failed', `Download ${state}; no automatic retry.`)
        return
      }
      t.view.receivedBytes = item.getReceivedBytes()
      t.received = true
      const sum = [...this.transfers.values()]
        .filter((one) => this.active(one))
        .reduce((n, one) => n + one.view.receivedBytes, 0)
      if (t.view.receivedBytes > this.maxBytes || sum > this.maxTotalBytes)
        this.finish(t, 'failed', 'Download size limit exceeded.')
      else if (t.approved) void this.publish(t)
      this.changed()
    })
    const active = [...this.transfers.values()].filter((one) => this.active(one))
    // 未知大小按单文件上限预留，不能同时启动四个未知长度流把总量限制架空。
    const reserved = active.reduce(
      (sum, one) =>
        sum + (one.received ? one.view.receivedBytes : (one.view.totalBytes ?? this.maxBytes)),
      0,
    )
    if (active.length > 4 || total > this.maxBytes || reserved > this.maxTotalBytes)
      this.finish(
        t,
        'failed',
        'Download limit exceeded (1 GiB per file, 2 GiB temporary data, 4 active files); no automatic retry.',
      )
    // 已完成记录仅保留最近 100 条，临时目录不跟随历史保留。
    for (const [key, old] of this.transfers) {
      if (this.transfers.size <= 100) break
      if (!this.active(old)) this.transfers.delete(key)
    }
    this.changed()
  }

  answer(id: string, allow: boolean): boolean {
    const t = this.transfers.get(id)
    if (t?.view.status !== 'pending') return false
    if (!allow) this.finish(t, 'declined')
    else {
      t.approved = true
      t.view.status = 'receiving'
      for (const done of t.decisions) done()
      if (t.received) void this.publish(t)
      this.changed()
    }
    return true
  }

  private async publish(t: Transfer): Promise<void> {
    if (t.publishing || !this.active(t) || this.disposed) return
    t.publishing = true
    clearTimeout(t.timer)
    try {
      mkdirSync(this.options.downloadsDirectory, { recursive: true })
      const extension = extname(t.view.filename)
      const stem = t.view.filename.slice(0, t.view.filename.length - extension.length)
      for (let index = 0; index < 10_000; index++) {
        const name = index ? `${stem} (${index})${extension}` : t.view.filename
        const path = join(this.options.downloadsDirectory, name)
        try {
          await publishDownloadFile(t.file, path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw error
        }
        t.view.filename = name
        t.view.path = path
        t.view.status = 'completed'
        return
      }
      throw new Error('Too many files with the same name.')
    } catch (error) {
      t.view.status = 'failed'
      // 文件系统错误可能含私有暂存路径，不把原始异常发给模型或网页。
      t.view.error = `Could not save download (${(error as NodeJS.ErrnoException).code ?? 'I/O error'}).`
    } finally {
      t.publishing = false
      this.cleanup(t)
      this.changed()
    }
  }

  async askPending(
    owner: TabOwner,
    context: ClientToolContext,
    visible: (tabId: string) => boolean = () => true,
  ): Promise<void> {
    for (const view of this.list(owner)) {
      if (!visible(view.tabId)) continue
      const t = this.transfers.get(view.id)
      if (t?.view.status !== 'pending' || t.prompting) continue
      t.prompting = true
      const abort = () => this.answer(view.id, false)
      context.signal.addEventListener('abort', abort, { once: true })
      let remove: (() => void) | undefined
      try {
        if (context.signal.aborted) {
          abort()
          continue
        }
        const ask = {
          kind: 'browserDownload' as const,
          filename: view.filename,
          origin: view.origin,
          totalBytes: view.totalBytes,
        }
        const decided = new Promise<void>((done) => t.decisions.add(done))
        if (context.show) {
          remove = context.show(ask, (answer) => this.answer(view.id, answer === 'once'))
        } else {
          void context.ask(ask).then(
            (answer) => this.answer(view.id, answer === 'once'),
            () => this.answer(view.id, false),
          )
        }
        await decided
      } finally {
        remove?.()
        t.decisions.clear()
        t.prompting = false
        context.signal.removeEventListener('abort', abort)
      }
    }
  }

  closeTab(tabId: string): void {
    for (const t of this.transfers.values())
      if (t.view.tabId === tabId && t.view.status === 'pending') this.finish(t, 'declined')
  }
  dispose(): void {
    this.disposed = true
    for (const t of this.transfers.values()) {
      if (this.active(t)) this.finish(t, 'failed', 'Application closed.')
      this.cleanup(t)
    }
    rmSync(this.options.stagingRoot, { recursive: true, force: true })
  }
}
