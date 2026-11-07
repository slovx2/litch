import {
  ATTACHMENT_STATUS_METHOD,
  type AttachmentState,
} from '../../../protocol/src/file-attachments.mjs'
import { type AttachmentUpload, uploadAttachment } from './attachments.mjs'
// 一台设备上的文件：列一层目录、读一个文件、模糊找文件。文件面板只发这三条命令。
// 另有挑目录（添加项目时浏览设备上的目录）：只列目录名、不读文件，所以不受下面“只在根之内”的限制。
//
// 用的都是 Codex 协议里现成的方法（fs/readDirectory、fs/readFile、fs/getMetadata、fuzzyFileSearch），哪种对面都有：
// - 设备服务的聚合面：设备进程自己读，不经任何引擎，所以不带 harness，哪个 harness 掉线都不影响；
// - 某个 harness 自己的入口：那个引擎的进程读；
// - 原生 codex：它自己读。
// 只读访问允许同设备的任意绝对根。路径必须落在调用方选定的文件树根内；对话根外链接由 resolve 选择父目录作根。
// 不改变写入、差异操作的根核对。预览仍在设备核对根与目标的 realpath，避免文档相对资源逃出所选目录。
//
// 没有哪个 harness 声明过会不会这几个方法，所以是“试了才知道”：对面说不认识，就记到下次重连，期间不再去问。

import { FILE_DOWNLOAD_CHUNK, type FileReadChunk } from '../../../protocol/src/file-download.mjs'
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { createCancel } from '../channel/cancel.mjs'
import { type AbortSignalLike, ChannelError, type Clock } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcAbortError, RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type {
  DirectoryView,
  FileContent,
  FileEntry,
  FileLinkResolution,
  FileMatch,
  FileSearchView,
  FolderListing,
} from '../model-files.mjs'
import {
  type FilePreview,
  PREVIEW_LIMIT,
  type PreviewKind,
  previewKind,
} from '../model-preview.mjs'
import { phrase } from '../phrase.mjs'
import type { FileRef } from '../projection/file-refs.mjs'
import {
  projectDirectory,
  projectFile,
  sortEntries,
  unreadableGroup,
} from '../projection/files.mjs'
import { base64Bytes } from '../text/bytes.mjs'
import {
  isAbsolutePath,
  isNetworkPath,
  joinPath,
  normalizePath,
  parentPath,
  pathTwin,
  relativeTo,
  withinRoot,
} from '../text/paths.mjs'
import { lacksMethod } from './faults.mjs'
import { resolveFileLink } from './file-links.mjs'
import { createFileWatches } from './file-watches.mjs'

export interface FilesHost {
  imagesSupported?(): boolean
  attachmentsSupported?(): boolean
  previewSupported?(): boolean
  downloadSupported?(): boolean
  clock: Clock
  online(): boolean
  /** 对面的系统（macos、linux、windows），还不知道是 null：路径的另一种写法按它认（text/paths.mts 的 pathTwin） */
  platform(): string | null
  /** 对面的用户主目录（设备服务报的），不知道是 null。挑目录从这里开始 */
  home(): string | null
  /** 设备的项目根信息；只读文件访问不再用它限制范围 */
  knownRoot(root: string): boolean
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  log(line: string): void
}

export interface Files {
  image(source: string, signal?: AbortSignalLike): Promise<FilePreview>
  /** 复用文件面板的路径范围校验；只返回规范路径，不读文件。 */
  locate(root: string, path: string): { root: string; path: string }

  attachmentStatus(path: string, signal?: AbortSignalLike): Promise<{ state: AttachmentState }>

  upload(
    file: AttachmentUpload,
    signal?: AbortSignalLike,
  ): Promise<Extract<import('../model.mjs').MessageExtra, { kind: 'file' }>>
  chunk(
    root: string,
    path: string,
    offset: number,
    revision?: string,
    signal?: AbortSignalLike,
  ): Promise<FileReadChunk>
  watch(root: string, path: string, directory: boolean, sink: HostSink): () => void
  reconcile(root: string): void
  notification(method: string, params: unknown): boolean
  resolve(
    root: string,
    ref: FileRef,
    href: string,
    signal?: AbortSignalLike,
  ): Promise<FileLinkResolution>
  preview(
    root: string,
    path: string,
    format: PreviewKind,
    signal?: AbortSignalLike,
  ): Promise<FilePreview>
  /** 列一层目录。fresh：不用缓存里的，重新去取 */
  list(root: string, path: string, fresh: boolean, signal?: AbortSignalLike): Promise<DirectoryView>
  read(root: string, path: string, signal?: AbortSignalLike): Promise<FileContent>
  /** 在根下面模糊找文件。同一个根上后来的一次会让前一次以 cancelled 结束 */
  search(root: string, query: string, signal?: AbortSignalLike): Promise<FileSearchView>
  /** 挑目录：列任意一层（绝对路径，null 是主目录）下面的目录。走同一份缓存 */
  folders(path: string | null, signal?: AbortSignalLike): Promise<FolderListing>
  /** 各层目录、各个文件真的向对面要过几次（走缓存的、搭便车的不算）。给验收量“每层只请求一次”用 */
  requests(): { lists: Record<string, number>; reads: Record<string, number> }
  /** 连上并认出对面是谁了：上一次连接里记的（缓存、对面不会什么）都不算数 */
  resync(): void
  /** 连接断了 */
  offline(): void
}

/** 一层目录取到之后这么久之内再要，直接给上次的 */
export const LIST_TTL_MS = 5000
/** 缓存里最多留这么多层目录，多了从最早的丢 */
const CACHE_MAX = 400
/** 一层里既不是目录也不是文件的条目（多半是符号链接），最多去问这么多个指向哪儿 */
export const LINK_PROBES = 64
const LINK_PARALLEL = 8
/** 读文件给宽一点：文件大、线路慢的时候一来一回要不少时间 */
const READ_TIMEOUT_MS = 60_000
/** “要过几次”最多记这么多个路径，多了从最早的丢 */
const TALLY_MAX = 4000

const tally = (counts: Map<string, number>, path: string) => {
  counts.set(path, (counts.get(path) ?? 0) + 1)
  if (counts.size <= TALLY_MAX) return
  const oldest = counts.keys().next().value
  if (oldest !== undefined) counts.delete(oldest)
}

/** 对面是不是在说“没有这个文件”。各家的说法不一样，只能看原话；“不认识这个方法”不算 */
const isMissing = (error: unknown): boolean =>
  error instanceof RpcError &&
  !lacksMethod(error) &&
  /ENOENT|ENOTDIR|no such file|os error 2\b/i.test(error.message)

export function createFiles(host: FilesHost): Files {
  /** 每次连上换一个：途中断了重连，回来的结果按它作废，不进缓存 */
  let epoch = 0
  /** 对面说过不认识的：读目录读文件那一组、找文件。到下次重连之前不再去问 */
  const lacks = { fs: false, search: false }
  const cache = new Map<string, { at: number; view: DirectoryView }>()
  const listing = new Map<string, Promise<DirectoryView>>()
  const reading = new Map<string, Promise<FileContent>>()
  // 只在读取结果存活时保留原始字节，用于相对路径歧义比较；不能比较已正规化换行的显示文字。
  const original = new WeakMap<FileContent, string>()
  /** 各个根上正在找的那一次：新的一次来了，旧的作废 */
  const searching = new Map<string, { abort(): void }>()
  /** 真的向对面要过几次。这次运行里一直累计，重连也不清 */
  const asked = { lists: new Map<string, number>(), reads: new Map<string, number>() }

  const versions = new Map<string, object>()
  const watches = createFileWatches(host, (path) => {
    cache.delete(path)
    listing.delete(path)
    reading.delete(path)
    // 旧请求回来不能把失效的目录重新写回缓存。
    versions.delete(path)
  })

  const forget = () => {
    epoch++
    versions.clear()
    cache.clear()
    listing.clear()
    reading.clear()
    for (const entry of searching.values()) entry.abort()
    searching.clear()
  }

  const unsupported = (what: 'fs' | 'search'): ChannelError =>
    what === 'fs'
      ? new ChannelError('unsupported', '对面不提供文件访问', phrase('files.unsupported'))
      : new ChannelError('unsupported', '对面不提供找文件', phrase('files.searchUnsupported'))

  /** 这台设备上路径的另一种写法 */
  const twin = () => pathTwin(host.platform())

  /**
   * 核对根和路径，返回理过的完整路径。路径用的是根的另一种写法（macOS 上 /private/var 和 /var）的，
   * 换成根的写法：之后的缓存、计数、去对面取都按这一种
   */
  const locate = (root: string, path: string): { root: string; path: string } => {
    if (typeof root !== 'string' || typeof path !== 'string' || !root || !path) {
      throw new ChannelError('rejected', '没有给路径', phrase('files.outside'))
    }
    if (isNetworkPath(root) || /^[\\/]{2}/.test(root) || /^[\\/]{2}/.test(path)) {
      throw new ChannelError('unsupported', '网络共享上的目录还不支持', phrase('files.network'))
    }
    const base = normalizePath(root)
    if (!isAbsolutePath(base) || /[\0\r\n]/.test(root + path)) {
      throw new ChannelError('rejected', `不认识这个根目录：${root}`, phrase('files.unknownRoot'))
    }
    const full = normalizePath(path)
    const inside = isAbsolutePath(full) ? withinRoot(base, full, twin()) : null
    if (inside === null) {
      throw new ChannelError('rejected', `路径不在工作区之内：${path}`, phrase('files.outside'))
    }
    return { root: base, path: inside }
  }

  const mustBeOnline = () => {
    if (!host.online()) throw new ChannelError('offline', '设备未连接')
  }

  /** 请求没做成。对面说不认识这个方法的记下来；别的换成给人看的错误 */
  const failed = (error: unknown, what: 'fs' | 'search'): ChannelError => {
    if (lacksMethod(error)) {
      lacks[what] = true
      return unsupported(what)
    }
    if (error instanceof RpcAbortError && error.reason === 'cancelled') {
      return new ChannelError('cancelled', error.message)
    }
    return host.fail(error)
  }

  /**
   * 既不是目录也不是文件的条目多半是符号链接：适配器列目录时不跟着链接走，原生 codex 会。
   * 去问一下它指向什么，问得到的照实归类（指向目录的就能展开了）。一层里最多问 LINK_PROBES 个，几个一起问
   */
  const resolveLinks = async (view: DirectoryView): Promise<DirectoryView> => {
    const unknown = view.entries.filter((entry) => entry.kind === 'other').slice(0, LINK_PROBES)
    if (unknown.length === 0) return view
    const resolved = new Map<string, FileEntry['kind']>()
    let next = 0
    const worker = async () => {
      for (;;) {
        const entry = unknown[next++]
        if (!entry) return
        try {
          const meta = await host.request('fs/getMetadata', {
            path: joinPath(view.path, entry.name),
          })
          if (meta.isDirectory === true) resolved.set(entry.name, 'dir')
          else if (meta.isFile === true) resolved.set(entry.name, 'file')
        } catch {
          // 断了的链接、没权限看的：照旧当“别的”
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LINK_PARALLEL, unknown.length) }, worker))
    if (resolved.size === 0) return view
    const entries = view.entries.map((entry) =>
      entry.kind === 'other' && resolved.has(entry.name)
        ? { name: entry.name, kind: resolved.get(entry.name) ?? 'other' }
        : entry,
    )
    return { ...view, entries: sortEntries(entries) }
  }

  const remember = (path: string, view: DirectoryView) => {
    cache.delete(path)
    cache.set(path, { at: host.clock.now(), view })
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const fetchDirectory = async (path: string): Promise<DirectoryView> => {
    const mine = epoch
    const version = {}
    versions.set(path, version)
    tally(asked.lists, path)
    try {
      const { entries } = await host.request('fs/readDirectory', { path })
      const view = await resolveLinks(projectDirectory(path, Array.isArray(entries) ? entries : []))
      if (mine === epoch && versions.get(path) === version) remember(path, view)
      return view
    } catch (error) {
      throw failed(error, 'fs')
    } finally {
      if (versions.get(path) === version) versions.delete(path)
    }
  }

  /** 调用的一方不等了（界面取消了命令）：它那一头立刻以 cancelled 结束；共用的那次请求照常跑完，结果留给别人和缓存 */
  const abandonable = <T,>(work: Promise<T>, signal: AbortSignalLike | undefined): Promise<T> => {
    if (!signal) return work
    return new Promise<T>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new ChannelError('cancelled', '已取消')), {
        once: true,
      })
      work.then(resolve, reject)
    })
  }

  const fetchFile = async (path: string): Promise<FileContent> => {
    tally(asked.reads, path)
    try {
      let meta: ClientRequests['fs/getMetadata']['result']
      try {
        meta = await host.request('fs/getMetadata', { path })
      } catch (error) {
        if (isMissing(error)) return { kind: 'missing', path }
        throw error
      }
      if (meta.isDirectory === true) return { kind: 'directory', path }
      // 套接字、管道、设备这些不是普通文件，读了可能一直不返回：不去读
      if (meta.isFile !== true) return { kind: 'binary', path, group: 'binary', bytes: null }
      // 看扩展名就知道不是文字的不读：协议读文件是整个读回来的，读之前也问不到它多大
      const group = unreadableGroup(path)
      if (group) return { kind: 'binary', path, group, bytes: null }
      const { dataBase64 } = await host.request(
        'fs/readFile',
        { path },
        { timeoutMs: READ_TIMEOUT_MS },
      )
      const bytes = typeof dataBase64 === 'string' ? dataBase64 : ''
      const content = projectFile(path, bytes)
      if (content.kind === 'text') original.set(content, bytes)
      return content
    } catch (error) {
      // 问元数据和读之间文件没了
      if (isMissing(error)) return { kind: 'missing', path }
      throw failed(error, 'fs')
    }
  }

  /** 列一层（路径已经核对过）：缓存里新的直接给，同一层正在取的话搭它的车，几处同时要同一层只发一次请求 */
  const listPath = async (
    path: string,
    fresh: boolean,
    signal: AbortSignalLike | undefined,
  ): Promise<DirectoryView> => {
    mustBeOnline()
    if (lacks.fs) throw unsupported('fs')
    if (!fresh) {
      const cached = cache.get(path)
      if (cached && host.clock.now() - cached.at < LIST_TTL_MS) return cached.view
    }
    let work = listing.get(path)
    if (!work) {
      work = fetchDirectory(path)
      listing.set(path, work)
      const mine = work
      const done = () => {
        if (listing.get(path) === mine) listing.delete(path)
      }
      work.then(done, done)
    }
    return abandonable(work, signal)
  }

  const files: Files = {
    reconcile(root) {
      watches.reconcile(locate(root, root).root)
    },
    async image(source, signal) {
      mustBeOnline()
      const remote = /^https?:\/\//i.test(source)
      const toolImage = /^litch-tool-image:[a-f0-9]{64}$/.test(source)
      if (
        !remote &&
        !toolImage &&
        (!isAbsolutePath(source) ||
          /^[\\/]{2}/.test(source) ||
          /[\u0000-\u001f\u007f]/.test(source) ||
          source.split(/[\\/]/).includes('..'))
      )
        return { kind: 'invalid', path: source }
      if (host.imagesSupported?.()) {
        const result = await host.request(
          'litch/media/readImage',
          { source },
          { timeoutMs: 20_000, ...(signal ? { signal } : {}) },
        )
        if (
          result.kind === 'ready' &&
          (!['image', 'svg'].includes(result.format) ||
            !Number.isSafeInteger(result.bytes) ||
            result.bytes < 1 ||
            typeof result.dataBase64 !== 'string' ||
            result.dataBase64.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(result.dataBase64) ||
            base64Bytes(result.dataBase64) !== result.bytes)
        )
          return { kind: 'invalid', path: source }
        if (
          result.kind === 'ready' &&
          (result.bytes > PREVIEW_LIMIT[result.format] ||
            result.dataBase64.length > Math.ceil(PREVIEW_LIMIT[result.format] / 3) * 4)
        )
          return {
            kind: 'tooLarge',
            path: source,
            bytes: result.bytes,
            limit: PREVIEW_LIMIT[result.format],
          }
        return { ...result, path: source }
      }
      const format = previewKind(source)
      if (remote || (format !== 'image' && format !== 'svg'))
        return { kind: 'unsupported', path: source }
      const root = /^[a-z]:[\\/]/i.test(source) ? `${source.slice(0, 2)}/` : '/'
      return files.preview(root, source, format, signal)
    },
    locate,
    async attachmentStatus(path, signal) {
      if (!host.online() || !host.attachmentsSupported?.()) return { state: 'unknown' }
      const response = await host.request(
        ATTACHMENT_STATUS_METHOD,
        { path },
        { ...(signal ? { signal } : {}) },
      )
      return {
        state: ['available', 'cleaned'].includes(response.state) ? response.state : 'unknown',
      }
    },
    upload: (file, signal) => uploadAttachment(host, file, signal),
    async chunk(root, path, offset, revision, signal) {
      const at = locate(root, path)
      mustBeOnline()
      if (!host.downloadSupported?.())
        throw new ChannelError(
          'unsupported',
          '设备不支持分块另存，请升级设备服务',
          phrase('files.save.unsupported'),
        )
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ChannelError('invalid', '读取位置无效')
      let result: ClientRequests['fs/readFile']['result']
      try {
        result = await host.request(
          'fs/readFile',
          {
            path: at.path,
            litchReadRange: {
              root: at.root,
              offset,
              maxBytes: FILE_DOWNLOAD_CHUNK,
              ...(revision ? { revision } : {}),
            },
          },
          { timeoutMs: READ_TIMEOUT_MS, ...(signal ? { signal } : {}) },
        )
      } catch (error) {
        const kind =
          error instanceof RpcError
            ? (error.data as { litchReadRange?: { kind?: string } } | null)?.litchReadRange?.kind
            : undefined
        if (kind === 'changed')
          throw new ChannelError(
            'rejected',
            '源文件在保存期间发生变化',
            phrase('files.save.changed'),
          )
        if (kind === 'notFile')
          throw new ChannelError('rejected', '只能另存普通文件', phrase('files.save.notFile'))
        throw failed(error, 'fs')
      }
      const info = result.litchReadRange
      if (
        !info ||
        !Number.isSafeInteger(info.size) ||
        info.size < offset ||
        typeof info.revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(info.revision) ||
        (revision !== undefined && info.revision !== revision) ||
        typeof result.dataBase64 !== 'string' ||
        result.dataBase64.length > Math.ceil(FILE_DOWNLOAD_CHUNK / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          result.dataBase64,
        ) ||
        base64Bytes(result.dataBase64) !== Math.min(FILE_DOWNLOAD_CHUNK, info.size - offset)
      ) {
        throw new ChannelError('remote', '分块读取响应无效')
      }
      return { dataBase64: result.dataBase64, litchReadRange: info }
    },
    watch(root, path, directory, sink) {
      return watches.open(locate(root, path).path, directory, sink)
    },
    notification: watches.notification,
    resolve(root, ref, href, signal) {
      if (!host.online())
        return Promise.resolve({
          status: 'failed',
          href,
          path: ref.path,
          attempted: [],
          candidates: [],
          failures: [{ path: ref.path, reason: 'offline' }],
        })
      return resolveFileLink(
        files,
        host.home(),
        root,
        ref,
        href,
        (a, b) => original.has(a) && original.get(a) === original.get(b),
        signal,
      )
    },
    async preview(root, path, format, signal) {
      const at = locate(root, path)
      mustBeOnline()
      if (!host.previewSupported?.()) return { kind: 'unsupported', path: at.path }
      if (!Object.hasOwn(PREVIEW_LIMIT, format)) return { kind: 'invalid', path: at.path }
      const limit = PREVIEW_LIMIT[format]
      try {
        tally(asked.reads, at.path)
        const { dataBase64 } = await host.request(
          'fs/readFile',
          {
            path: at.path,
            litchPreview: { root: at.root, maxBytes: limit },
          },
          { timeoutMs: READ_TIMEOUT_MS, ...(signal ? { signal } : {}) },
        )
        if (typeof dataBase64 !== 'string') return { kind: 'invalid', path: at.path }
        const bytes = base64Bytes(dataBase64)
        if (bytes > limit) return { kind: 'tooLarge', path: at.path, bytes, limit }
        if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64))
          return { kind: 'invalid', path: at.path }
        return { kind: 'ready', path: at.path, format, dataBase64, bytes }
      } catch (error) {
        if (isMissing(error)) return { kind: 'missing', path: at.path }
        const data =
          error instanceof RpcError
            ? (error.data as { litchPreview?: { kind?: string; bytes?: number } } | null)
            : null
        const reason = data?.litchPreview
        if (reason?.kind === 'tooLarge')
          return { kind: 'tooLarge', path: at.path, bytes: reason.bytes ?? limit + 1, limit }
        if (reason && ['outside', 'notFile', 'changed', 'busy'].includes(reason.kind ?? ''))
          return { kind: reason.kind as 'outside' | 'notFile' | 'changed' | 'busy', path: at.path }
        throw failed(error, 'fs')
      }
    },
    async list(root, path, fresh, signal) {
      return listPath(locate(root, path).path, fresh, signal)
    },

    async folders(given, signal) {
      // 不知道主目录（单个入口连的、旧的设备服务）从根开始
      const path = given ?? host.home() ?? '/'
      if (typeof path !== 'string' || isNetworkPath(path)) {
        throw new ChannelError('unsupported', '网络共享上的目录还不支持', phrase('files.network'))
      }
      const at = normalizePath(path)
      if (!isAbsolutePath(at)) {
        throw new ChannelError('rejected', `不是绝对路径：${path}`, phrase('files.outside'))
      }
      const view = await listPath(at, false, signal)
      return {
        path: view.path,
        parent: parentPath(view.path),
        folders: view.entries.filter((entry) => entry.kind === 'dir').map((entry) => entry.name),
      }
    },

    async read(root, path, signal) {
      const at = locate(root, path)
      mustBeOnline()
      if (lacks.fs) throw unsupported('fs')
      let work = reading.get(at.path)
      if (!work) {
        work = fetchFile(at.path)
        reading.set(at.path, work)
        const mine = work
        const done = () => {
          if (reading.get(at.path) === mine) reading.delete(at.path)
        }
        work.then(done, done)
      }
      return abandonable(work, signal)
    },

    async search(root, query, signal) {
      // 找文件只看根，路径就是根自己
      const at = locate(root, root)
      const text = typeof query === 'string' ? query.trim() : ''
      // 同一个根上只留最新的一次：前一次不等了
      searching.get(at.root)?.abort()
      searching.delete(at.root)
      if (!text) return { query: text, matches: [] }
      mustBeOnline()
      if (lacks.search) throw unsupported('search')
      const cancel = createCancel()
      searching.set(at.root, cancel)
      signal?.addEventListener('abort', () => cancel.abort(), { once: true })
      try {
        const { files } = await host.request(
          'fuzzyFileSearch',
          // 同一个标记的新请求会让对面把旧的那次停掉：一个根用一个标记
          { query: text, roots: [at.root], cancellationToken: `litch-files:${at.root}` },
          { signal: cancel.signal },
        )
        const matches: FileMatch[] = []
        for (const file of Array.isArray(files) ? files : []) {
          if (typeof file?.path !== 'string' || !file.path) continue
          const full = joinPath(typeof file.root === 'string' ? file.root : at.root, file.path)
          // 对面给的结果也要在根之内才收，写法换成根的
          const inside = withinRoot(at.root, full, twin())
          if (inside === null || inside === at.root) continue
          matches.push({
            path: inside,
            relative: relativeTo(at.root, inside),
            kind: file.match_type === 'directory' ? 'dir' : 'file',
            indices:
              Array.isArray(file.indices) && file.indices.every((n) => Number.isInteger(n))
                ? file.indices
                : null,
          })
        }
        return { query: text, matches }
      } catch (error) {
        throw failed(error, 'search')
      } finally {
        if (searching.get(at.root) === cancel) searching.delete(at.root)
      }
    },

    requests() {
      return {
        lists: Object.fromEntries(asked.lists),
        reads: Object.fromEntries(asked.reads),
      }
    },

    resync() {
      forget()
      lacks.fs = false
      lacks.search = false
      watches.resync()
    },

    offline() {
      watches.offline()
      forget()
    },
  }
  return files
}
