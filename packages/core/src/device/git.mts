// 在设备上跑 git：每条命令怎么写、输出读成什么、没跑成怎么说。差异模块（diffs.mts）只调这里的函数。
//
// 几条规矩：
// - 命令是参数的数组（exec.mts），路径一律放在 “--” 后面，并且开着 --literal-pathspecs：
//   路径里的星号、方括号、开头的冒号都只是字，不当通配和魔法写法。
// - 用户的 git 配置可能改掉输出的样子（颜色、路径加引号、去掉 a/ b/ 前缀、外部的差异工具）：
//   这里一条条压回默认，读的时候才靠得住。
// - 只读的命令带 GIT_OPTIONAL_LOCKS=0：git status 平常会顺手把索引刷新了写回去，那会和代理正在跑的
//   git 命令抢锁，也会让“盯着 .git 有没有变”自己把自己触发。
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import { RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type { DiffAbsence } from '../model-diff.mjs'
import { phrase } from '../phrase.mjs'
import {
  parseGrepCounts,
  parseRawNumstat,
  parseStatus,
  type RawEntry,
  type StatusOutput,
} from '../projection/git-output.mjs'
import { isAbsolutePath } from '../text/paths.mjs'
import { abortFailure, type Exec, type ExecResult } from './exec.mjs'
import { lacksMethod } from './faults.mjs'

export interface GitHost {
  exec: Exec
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 记一笔：这一种命令又起了一次 */
  tally(kind: string): void
}

/** 仓库的几样位置。prefix 是面板的根在仓库里的位置：带末尾的斜杠，根就是顶层时是空串 */
export interface GitFacts {
  top: string
  gitDir: string
  prefix: string
}

export type GitProbe = { ok: true; facts: GitFacts } | { ok: false; why: DiffAbsence }

const GIT: readonly string[] = [
  'git',
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.quotePath=false',
  '-c',
  'color.ui=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
]

const ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  // 报错的话要按原文认（“not a git repository”），不能跟着那台机器的语言变
  LC_ALL: 'C',
}

/** 出差异内容的命令都带这几样：不用外部工具、不转换内容、认改名、路径相对于当前目录、固定的前缀 */
const DIFF: readonly string[] = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '-M',
  '--relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

const MIB = 1024 * 1024
/** 各种输出最多要多少字节 */
export const GIT_CAPS = {
  status: 4 * MIB,
  summary: 4 * MIB,
  counts: MIB,
  file: 2 * MIB,
  fileFull: 4 * MIB,
  bundle: 6 * MIB,
}
const TIMEOUT_MS = 30_000
/** 同时最多跑这么多条 */
const PARALLEL = 6
/** 一条命令里路径参数加起来最多这么多个字：再多就分几条跑，免得撞上系统对参数总长的限制 */
const ARGS_MAX = 60_000
/** 展开上下文时要的行数：比哪个文件都长 */
const FULL_CONTEXT = 1_000_000

interface RunOptions {
  cap: number
  /** 这些退出码都算跑成了。不给就只认 0 */
  accept?: readonly number[]
  signal?: AbortSignalLike | undefined
}

/** git 自己报了错。原话在 stderr 里 */
export class GitFailure extends Error {
  readonly exitCode: number
  readonly stderr: string

  constructor(result: ExecResult) {
    const said = result.stderr.trim().split('\n')[0] ?? ''
    super(said || `git 退出码 ${result.exitCode}`)
    this.name = 'GitFailure'
    this.exitCode = result.exitCode
    this.stderr = result.stderr
  }
}

/** 对面在说“没有这个程序”（也可能是“没有这个目录”，两种在起进程时是同一个错） */
const isMissing = (error: unknown): boolean =>
  error instanceof RpcError &&
  !lacksMethod(error) &&
  /ENOENT|no such file or directory|os error 2\b/i.test(error.message)

/** 把路径分成几批，每批加起来不超过 ARGS_MAX 个字 */
export function batchPaths(paths: readonly string[], max = ARGS_MAX): string[][] {
  const batches: string[][] = []
  let batch: string[] = []
  let size = 0
  for (const path of paths) {
    if (batch.length > 0 && size + path.length + 1 > max) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(path)
    size += path.length + 1
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

export type Git = ReturnType<typeof createGit>

export function createGit(host: GitHost) {
  let running = 0
  const queue: (() => void)[] = []
  const enter = (): Promise<void> => {
    if (running < PARALLEL) {
      running++
      return Promise.resolve()
    }
    return new Promise((resolve) => queue.push(resolve))
  }
  const leave = () => {
    const next = queue.shift()
    if (next) next()
    else running--
  }

  const run = async (
    root: string,
    kind: string,
    args: readonly string[],
    options: RunOptions,
  ): Promise<ExecResult> => {
    await enter()
    try {
      if (options.signal?.aborted) throw new ChannelError('cancelled', '已取消')
      host.tally(kind)
      const result = await host.exec.run([...GIT, ...args], {
        cwd: root,
        env: ENV,
        capBytes: options.cap,
        timeoutMs: TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!(options.accept ?? [0]).includes(result.exitCode)) throw new GitFailure(result)
      return result
    } finally {
      leave()
    }
  }

  /** 改东西的命令：一条一条跑，路径太多就分批 */
  const write = async (root: string, kind: string, args: readonly string[], paths: string[]) => {
    for (const batch of batchPaths(paths)) {
      await run(root, kind, [...args, '--', ...batch], { cap: MIB })
    }
  }

  return {
    /** 这个目录在不在 git 仓库里、仓库在哪。看不了 git 的几种情形不算出错，各有一个原因 */
    async probe(root: string, signal?: AbortSignalLike): Promise<GitProbe> {
      let result: ExecResult
      try {
        result = await run(
          root,
          'probe',
          ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-prefix'],
          { cap: MIB, accept: [0, 128], signal },
        )
      } catch (error) {
        if (lacksMethod(error)) return { ok: false, why: 'unsupported' }
        if (!isMissing(error)) throw error
        // 起不来：是没有 git，还是这个目录不在了？问一下目录
        const there = await host.request('fs/getMetadata', { path: root }).then(
          (meta) => meta.isDirectory === true,
          () => false,
        )
        if (there) return { ok: false, why: 'noGit' }
        throw new ChannelError('remote', `目录不在了：${root}`, phrase('diff.rootMissing'))
      }
      if (result.exitCode !== 0) {
        // 不在仓库里，或者在一个没有工作区的仓库（裸仓库、.git 里面）里
        if (/not a git repository|must be run in a work tree/i.test(result.stderr)) {
          return { ok: false, why: 'notRepo' }
        }
        throw new GitFailure(result)
      }
      const [top = '', gitDir = '', prefix = ''] = result.stdout.split('\n')
      // Windows 上的 git 给的是 C:/… 这种写法
      if (!isAbsolutePath(top) || !isAbsolutePath(gitDir)) return { ok: false, why: 'notRepo' }
      return { ok: true, facts: { top, gitDir, prefix } }
    },

    /**
     * 现在的状态：在哪个分支、每个文件暂存了没有、有哪些没跟踪的。
     * 没跟踪的平常一个个列；多到输出装不下了，退一步按目录列（一整个没跟踪的目录只算一条）
     */
    async status(root: string, signal?: AbortSignalLike): Promise<StatusOutput> {
      const base = ['status', '--porcelain=v2', '--branch', '-z']
      const all = await run(root, 'status', [...base, '--untracked-files=all', '--', '.'], {
        cap: GIT_CAPS.status,
        signal,
      })
      if (!all.capped) return parseStatus(all.stdout)
      const folded = await run(root, 'status', [...base, '--untracked-files=normal', '--', '.'], {
        cap: GIT_CAPS.status,
        signal,
      })
      // 这样还装不下的话最后一条可能是半截的：丢掉
      const text = folded.capped
        ? folded.stdout.slice(0, folded.stdout.lastIndexOf('\0') + 1)
        : folded.stdout
      return parseStatus(text)
    },

    /** 一棵空树的对象名：仓库里还没有提交时拿它当“上一次提交” */
    async emptyTree(root: string, signal?: AbortSignalLike): Promise<string> {
      const result = await run(root, 'emptyTree', ['hash-object', '-t', 'tree', '/dev/null'], {
        cap: MIB,
        signal,
      })
      return result.stdout.trim()
    },

    /** HEAD 和 ref 最近的共同祖先；算不出（ref 不在了、没有共同的历史）是 null */
    async mergeBase(root: string, ref: string, signal?: AbortSignalLike): Promise<string | null> {
      const result = await run(root, 'mergeBase', ['merge-base', 'HEAD', ref], {
        cap: MIB,
        accept: [0, 1, 128],
        signal,
      })
      return result.exitCode === 0 ? result.stdout.trim() || null : null
    },

    /** 这个范围里变了哪些文件、各增删多少行。rev 是比的两头（空着是暂存区对工作区） */
    async changed(
      root: string,
      rev: readonly string[],
      signal?: AbortSignalLike,
    ): Promise<{ entries: RawEntry[]; capped: boolean }> {
      const result = await run(
        root,
        'summary',
        ['diff', '--raw', '--numstat', '-z', ...DIFF, ...rev],
        {
          cap: GIT_CAPS.summary,
          signal,
        },
      )
      return { entries: parseRawNumstat(result.stdout), capped: result.capped }
    },

    /** 数没跟踪的文件各有多少行。不是文字的、空的不在结果里 */
    async countLines(
      root: string,
      paths: readonly string[],
      signal?: AbortSignalLike,
    ): Promise<Map<string, number>> {
      const counts = new Map<string, number>()
      for (const batch of batchPaths(paths)) {
        // 退出码 1 是“一行都没对上”（全是空文件或者不是文字的），不算出错
        const result = await run(
          root,
          'counts',
          ['grep', '--untracked', '-I', '-c', '-z', '-e', '', '--', ...batch],
          { cap: GIT_CAPS.counts, accept: [0, 1], signal },
        )
        for (const [path, count] of parseGrepCounts(result.stdout)) counts.set(path, count)
      }
      return counts
    },

    /** 一个没跟踪的文件是不是文字。数行数时没数到的（空的，或者不是文字的）才来问 */
    async untrackedIsBinary(
      root: string,
      path: string,
      signal?: AbortSignalLike,
    ): Promise<boolean> {
      const result = await run(
        root,
        'counts',
        ['diff', '--no-index', '--numstat', '--', '/dev/null', path],
        { cap: MIB, accept: [0, 1], signal },
      )
      return result.stdout.startsWith('-\t-\t')
    },

    /** 一个跟踪着的文件的差异。full：带上整个文件当上下文 */
    patch(
      root: string,
      rev: readonly string[],
      paths: readonly string[],
      full: boolean,
      signal?: AbortSignalLike,
    ): Promise<ExecResult> {
      return run(
        root,
        'file',
        ['diff', ...DIFF, full ? `-U${FULL_CONTEXT}` : '-U3', ...rev, '--', ...paths],
        { cap: full ? GIT_CAPS.fileFull : GIT_CAPS.file, signal },
      )
    },

    /** 一个没跟踪的文件的差异：拿它和“什么都没有”比。有差异时 git 的退出码是 1 */
    patchUntracked(root: string, path: string, signal?: AbortSignalLike): Promise<ExecResult> {
      return run(
        root,
        'file',
        [
          'diff',
          '--no-index',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--',
          '/dev/null',
          path,
        ],
        { cap: GIT_CAPS.file, accept: [0, 1], signal },
      )
    },

    /** 这个范围里全部跟踪着的文件的差异，一次取回来 */
    patchAll(root: string, rev: readonly string[], signal?: AbortSignalLike): Promise<ExecResult> {
      return run(root, 'bundle', ['diff', ...DIFF, '-U3', ...rev], {
        cap: GIT_CAPS.bundle,
        signal,
      })
    },

    /** 暂存：新加的、改了的、删了的都算 */
    stage: (root: string, paths: string[]) => write(root, 'stage', ['add', '-A'], paths),
    /** 取消暂存：暂存区里的这几个路径回到上一次提交的样子，工作区不动 */
    unstage: (root: string, paths: string[]) => write(root, 'unstage', ['reset', '-q'], paths),
    /** 暂存区和工作区里的这几个路径都回到上一次提交的样子 */
    restoreFromHead: (root: string, paths: string[]) =>
      write(root, 'discard', ['checkout', '-q', 'HEAD'], paths),
    /** 工作区里的这几个路径回到暂存区的样子 */
    restoreFromIndex: (root: string, paths: string[]) =>
      write(root, 'discard', ['checkout', '-q'], paths),
    /** 从暂存区和工作区里一起去掉（新加的文件） */
    remove: (root: string, paths: string[]) => write(root, 'discard', ['rm', '-q', '-f'], paths),
    /** 删掉没跟踪的文件。dir：是一整个没跟踪的目录 */
    clean: (root: string, paths: string[], dir: boolean) =>
      write(root, 'discard', ['clean', '-q', '-f', ...(dir ? ['-d'] : [])], paths),
  }
}

/** git 没跑成：换成通道上的错误。git 自己的话原样给，那是最说明问题的 */
export function gitFailure(
  error: unknown,
  fallback: (error: unknown) => ChannelError,
): ChannelError {
  if (error instanceof ChannelError) return error
  if (error instanceof GitFailure) return new ChannelError('remote', error.message)
  return abortFailure(error) ?? fallback(error)
}
