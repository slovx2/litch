// 一台设备上的文件：列一层目录、读一个文件、模糊找文件。文件面板只发这三条命令。
// 另有挑目录（添加项目时浏览设备上的目录）：只列目录名、不读文件，所以不受下面“只在根之内”的限制。
//
// 用的都是 Codex 协议里现成的方法（fs/readDirectory、fs/readFile、fs/getMetadata、fuzzyFileSearch），哪种对面都有：
// - 设备服务的聚合面：设备进程自己读，不经任何引擎，所以不带 harness，哪个 harness 掉线都不影响；
// - 某个 harness 自己的入口：那个引擎的进程读；
// - 原生 codex：它自己读。
// 协议不管能读哪里，“只在工作区的根之内”是这里守的：根必须是这台设备上认得的（某个工作区的根，或者某个会话的
// 工作目录），路径理成最简之后必须落在根里。只是字面上的核对：根里面的符号链接指到外面去，这里拦不住
// （协议里没有“解析成真实路径”这一样）。
//
// 没有哪个 harness 声明过会不会这几个方法，所以是“试了才知道”：对面说不认识，就记到下次重连，期间不再去问。
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { createCancel } from '../channel/cancel.mjs'
import { type AbortSignalLike, ChannelError, type Clock } from '../channel/protocol.mjs'
import { RpcAbortError, RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type {
  DirectoryView,
  FileContent,
  FileEntry,
  FileMatch,
  FileSearchView,
  FolderListing,
} from '../model-files.mjs'
import { phrase } from '../phrase.mjs'
import {
  projectDirectory,
  projectFile,
  sortEntries,
  unreadableGroup,
} from '../projection/files.mjs'
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

export interface FilesHost {
  clock: Clock
  online(): boolean
  /** 对面的系统（macos、linux、windows），还不知道是 null：路径的另一种写法按它认（text/paths.mts 的 pathTwin） */
  platform(): string | null
  /** 对面的用户主目录（设备服务报的），不知道是 null。挑目录从这里开始 */
  home(): string | null
  /** 这个目录是不是这台设备上认得的根：某个工作区的根，或者某个会话的工作目录。给的是理过的路径 */
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
  /** 各个根上正在找的那一次：新的一次来了，旧的作废 */
  const searching = new Map<string, { abort(): void }>()
  /** 真的向对面要过几次。这次运行里一直累计，重连也不清 */
  const asked = { lists: new Map<string, number>(), reads: new Map<string, number>() }

  const forget = () => {
    epoch++
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
    if (isNetworkPath(root)) {
      throw new ChannelError('unsupported', '网络共享上的目录还不支持', phrase('files.network'))
    }
    const base = normalizePath(root)
    if (!isAbsolutePath(base) || !host.knownRoot(base)) {
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
    tally(asked.lists, path)
    try {
      const { entries } = await host.request('fs/readDirectory', { path })
      const view = await resolveLinks(projectDirectory(path, Array.isArray(entries) ? entries : []))
      if (mine === epoch) remember(path, view)
      return view
    } catch (error) {
      throw failed(error, 'fs')
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
      return projectFile(path, typeof dataBase64 === 'string' ? dataBase64 : '')
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

  return {
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
    },

    offline() {
      forget()
    },
  }
}
