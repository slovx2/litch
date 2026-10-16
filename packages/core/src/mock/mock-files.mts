// 模拟核心的文件面板。这里模拟的是“对面”：照 Codex 协议回答 fs/readDirectory、fs/getMetadata、fs/readFile、
// fuzzyFileSearch 四个方法，背后是编出来的示例文件树（sample-files.mts）；这四个方法之上的事——核对根和路径、
// 缓存、同时要同一层只问一次、符号链接补问、大小上限、对面不会时的降级——用的就是真的核心那一份（device/files.mts）。
// 所以在普通浏览器里对着模拟核心，走的也是真的那条路。
// 两台示例设备各缺一样，给界面试降级用：nas 上不提供文件访问，build 上不提供找文件。
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import {
  type AbortSignalLike,
  ChannelError,
  type Clock,
  type Commands,
} from '../channel/protocol.mjs'
import { RpcAbortError, RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import { channelFailure } from '../device/faults.mjs'
import { createFiles, type Files } from '../device/files.mjs'
import type { DeviceView } from '../model.mjs'
import type { FileContent } from '../model-files.mjs'
import { encodeBase64, textToBase64 } from '../text/bytes.mjs'
import { insideRoot, normalizePath, relativeTo } from '../text/paths.mjs'
import { type SampleFiles, sampleFiles } from './sample-files.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface MockFilesHost {
  clock: Clock
  /** 流式回答每一小块之间隔多久。对面“过一会儿才回”跟着它走，0 就是立刻 */
  stepMs: number
  lang: SampleLang
  device(deviceId: string): DeviceView | undefined
  /** 这个目录是不是这台设备上认得的根：某个工作区的根，或者某个会话的工作目录 */
  knownRoot(deviceId: string, root: string): boolean
}

export interface MockFiles {
  /** 是文件面板的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown, signal: AbortSignalLike): Promise<unknown> | undefined
}

/** 这台示例设备上不提供文件访问 */
const NO_FILES = 'nas'
/** 这台示例设备上不提供找文件 */
const NO_SEARCH = 'build'
const MATCH_LIMIT = 50
/** 示例数据里的根写成 ~/work/litch 这样；对面认的是完整路径，进出各换一次 */
const HOME = '/Users/dev'
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

const expand = (path: string): string =>
  path === '~' ? HOME : path.startsWith('~/') ? HOME + path.slice(1) : path
const shrink = (path: string): string =>
  path === HOME ? '~' : path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path

/**
 * 按顺序在路径里找到查询的每个字就算对上。从后往前对：要找的多半是文件名，这样对上的字尽量落在文件名里。
 * 分数只管排序：文件名开头对上的、连着对上的、短的在前
 */
function fuzzy(needle: string[], path: string): { score: number; indices: number[] } | null {
  const chars = Array.from(path)
  const indices: number[] = []
  let cursor = chars.length - 1
  for (let at = needle.length - 1; at >= 0; at--) {
    while (cursor >= 0 && chars[cursor]?.toLowerCase() !== needle[at]) cursor--
    if (cursor < 0) return null
    indices.unshift(cursor--)
  }
  const first = indices[0] ?? 0
  const span = (indices[indices.length - 1] ?? first) - first + 1
  const name = chars.lastIndexOf('/') + 1
  const score =
    1000 + (first === name ? 100 : 0) - (span - needle.length) * 4 - first - chars.length
  return { score, indices }
}

interface Remote {
  files: Files
  /** 界面给过的根（完整路径）。对面收到的只有路径，靠它们认出是示例树里的哪一处 */
  roots: Set<string>
  /** 其中界面是用 ~ 开头的写法给的那些 */
  short: Set<string>
}

export function createMockFiles(host: MockFilesHost): MockFiles {
  const { clock } = host
  const tree: SampleFiles = sampleFiles(host.lang)
  const remotes = new Map<string, Remote>()
  let all: { path: string; kind: 'dir' | 'file' }[] | null = null

  /** 过一小会儿。途中取消了照连接层的样子结束 */
  const pause = (signal: AbortSignalLike | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new RpcAbortError('cancelled', '已取消'))
        return
      }
      const stop = clock.setTimer(resolve, host.stepMs <= 0 ? 0 : Math.min(host.stepMs, 40))
      signal?.addEventListener(
        'abort',
        () => {
          stop()
          reject(new RpcAbortError('cancelled', '已取消'))
        },
        { once: true },
      )
    })

  /** 完整路径 → 示例树里的相对路径。不在哪个根下面的是 null */
  const relativeOf = (remote: Remote, path: string): string | null => {
    let best: string | null = null
    for (const root of remote.roots) {
      if (insideRoot(root, path) && (best === null || root.length > best.length)) best = root
    }
    return best === null ? null : relativeTo(best, path)
  }

  const noSuch = (call: string, path: string): RpcError =>
    new RpcError(INTERNAL_ERROR, `ENOENT: no such file or directory, ${call} '${path}'`)

  /** 对面：照协议回答 */
  const answer = async (
    deviceId: string,
    remote: Remote,
    method: string,
    params: unknown,
    options: RpcRequestOptions | undefined,
  ): Promise<unknown> => {
    await pause(options?.signal)
    if (deviceId === NO_FILES || (deviceId === NO_SEARCH && method === 'fuzzyFileSearch')) {
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
    if (method === 'fuzzyFileSearch') {
      const { query, roots } = params as ClientRequests['fuzzyFileSearch']['params']
      const root = roots[0] ?? ''
      all ??= tree.all()
      const needle = Array.from(query.toLowerCase())
      const found: { path: string; kind: 'dir' | 'file'; score: number; indices: number[] }[] = []
      for (const entry of all) {
        const hit = fuzzy(needle, entry.path)
        if (hit) found.push({ path: entry.path, kind: entry.kind, ...hit })
      }
      found.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return {
        files: found.slice(0, MATCH_LIMIT).map((hit) => ({
          root,
          path: hit.path,
          match_type: hit.kind === 'dir' ? 'directory' : 'file',
          file_name: hit.path.slice(hit.path.lastIndexOf('/') + 1),
          score: hit.score,
          indices: hit.indices,
        })),
      }
    }
    const { path } = params as { path: string }
    const relative = relativeOf(remote, path)
    if (method === 'fs/readDirectory') {
      if (relative === 'fixtures/locked') {
        throw new RpcError(INTERNAL_ERROR, `EACCES: permission denied, scandir '${path}'`)
      }
      const entries = relative === null ? null : tree.list(relative)
      if (!entries) {
        if (relative === null || tree.kind(relative) === null) throw noSuch('scandir', path)
        throw new RpcError(INTERNAL_ERROR, `ENOTDIR: not a directory, scandir '${path}'`)
      }
      return {
        // 符号链接两样都不是：适配器列目录时就是这样回的，核心会再去问它指向什么
        entries: entries.map((entry) => ({
          fileName: entry.name,
          isDirectory: entry.kind === 'dir',
          isFile: entry.kind === 'file',
        })),
      }
    }
    const kind = relative === null ? null : tree.kind(relative)
    if (method === 'fs/getMetadata') {
      if (kind === null) throw noSuch('stat', path)
      return {
        isDirectory: kind === 'dir',
        isFile: kind === 'file',
        isSymlink: false,
        createdAtMs: 0,
        modifiedAtMs: 0,
      }
    }
    if (method === 'fs/readFile') {
      // gone.txt：列得出来、问得到，读的时候已经没了
      if (relative === null || kind === null || relative === 'fixtures/gone.txt') {
        throw noSuch('open', path)
      }
      if (kind === 'dir') {
        throw new RpcError(INTERNAL_ERROR, 'EISDIR: illegal operation on a directory, read')
      }
      const data = tree.read(relative) ?? ''
      return { dataBase64: typeof data === 'string' ? textToBase64(data) : encodeBase64(data) }
    }
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
  }

  const remoteOf = (deviceId: string): Remote => {
    const known = remotes.get(deviceId)
    if (known) return known
    const remote: Remote = {
      roots: new Set(),
      short: new Set(),
      files: createFiles({
        clock,
        online: () => host.device(deviceId)?.connection === 'online',
        platform: () => host.device(deviceId)?.os ?? null,
        // 示例数据里的根有的写成 ~ 开头：两种写法都认
        knownRoot: (root) =>
          host.knownRoot(deviceId, root) || host.knownRoot(deviceId, shrink(root)),
        request: <M extends ClientRequestMethod>(
          method: M,
          params: ClientRequests[M]['params'],
          options?: RpcRequestOptions,
        ) =>
          answer(deviceId, remote, method, params, options) as Promise<ClientRequests[M]['result']>,
        fail: (error) => channelFailure(error),
        log() {},
      }),
    }
    remotes.set(deviceId, remote)
    return remote
  }

  /** 这台设备上的文件模块，顺手记下这个根。没有这台设备就抛错 */
  const filesOf = (deviceId: string, root: unknown): Files => {
    if (!host.device(deviceId)) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    const remote = remoteOf(deviceId)
    if (typeof root === 'string' && root) {
      const full = normalizePath(expand(root))
      remote.roots.add(full)
      if (full !== normalizePath(root)) remote.short.add(full)
    }
    return remote.files
  }

  /** 给界面的路径换回它给的那种写法：根是 ~ 开头的，结果里的也是 */
  const outward = (root: string, path: string): string =>
    root === '~' || root.startsWith('~/') ? shrink(path) : path

  const handlers: {
    [K in keyof Commands]?: (params: Commands[K]['params'], signal: AbortSignalLike) => unknown
  } = {
    async 'files.list'({ deviceId, root, path, fresh }, signal) {
      const files = filesOf(deviceId, root)
      const view = await files.list(expand(root), expand(path), fresh === true, signal)
      return { ...view, path: outward(root, view.path) }
    },

    async 'files.read'({ deviceId, root, path }, signal) {
      const files = filesOf(deviceId, root)
      const content: FileContent = await files.read(expand(root), expand(path), signal)
      return { ...content, path: outward(root, content.path) }
    },

    async 'files.search'({ deviceId, root, query }, signal) {
      const found = await filesOf(deviceId, root).search(expand(root), query, signal)
      return {
        query: found.query,
        matches: found.matches.map((match) => ({ ...match, path: outward(root, match.path) })),
      }
    },

    'files.requests'({ deviceId }) {
      const { lists, reads } = filesOf(deviceId, null).requests()
      const { short } = remoteOf(deviceId)
      // 键照界面给的写法回：验收拿界面上看到的路径来对
      const written = (path: string): string => {
        for (const root of short) if (insideRoot(root, path)) return shrink(path)
        return path
      }
      const out = (counts: Record<string, number>) =>
        Object.fromEntries(Object.entries(counts).map(([path, count]) => [written(path), count]))
      return { lists: out(lists), reads: out(reads) }
    },
  }

  return {
    command(name, params, signal) {
      const handler = handlers[name as keyof Commands] as
        | ((params: unknown, signal: AbortSignalLike) => unknown)
        | undefined
      if (!handler) return undefined
      // 处理的函数有同步有异步：一律包成异步的，抛出来的错都变成拒绝
      return (async () => handler(params, signal))()
    },
  }
}
