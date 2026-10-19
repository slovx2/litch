// 差异模块的测试共用的搭建：一个真的差异模块（device/diffs.mts），对面是这台机器上真的 git。
// “对面”照协议回答 process/spawn（不带终端、不流式：结束时发一条 process/exited，里面是攒下来的输出）、
// process/kill、fs/getMetadata、fs/watch、fs/unwatch。仓库建在临时目录里，测试完删掉。
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type ChannelError,
  createDiffs,
  type DiffScope,
  type DiffView,
  RpcError,
  samePath,
} from '../src/index.mjs'
import { fakeClock } from './helpers.mjs'

export interface GitWorldOptions {
  /** 不建仓库：只是一个普通目录 */
  plain?: boolean
  /** 对面起不了进程：没有这个方法 */
  noSpawn?: boolean
  /** 对面没有 fs/watch */
  noWatch?: boolean
  /** 对面答 fs/watch 要这么久（真的毫秒）：真的设备上应答是隔一会儿才到的 */
  watchDelayMs?: number
  /** 这个会话的 harness 发不发本回合差异（见 DiffsHost.turnDiffDeclared） */
  turnDiff?: boolean | null
  /** 对面报的系统（见 DiffsHost.platform）。不给是还不知道 */
  platform?: string
  /**
   * 装成 Windows 上的仓库：对面的路径是 C: 加上这台机器上的路径（C:/var/…），git 报的路径也换成这样。
   * 发给对面的 C:/… 去掉盘符再在这台机器上用
   */
  drive?: boolean
}

/** 给仓库的 git 一份干净的环境：不读这台机器上用户自己的配置 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 'tester@example.invalid',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 'tester@example.invalid',
}

export function gitWorld(options: GitWorldOptions = {}) {
  // macOS 上临时目录是个符号链接：git 报的是解开之后的路径
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'litch-diff-test-')))
  const root = join(base, 'repo')
  mkdirSync(root)
  /** 在仓库里直接跑 git（摆场景用，不经差异模块） */
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' })
  const put = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  /** 跑一条 git，不管成没成：退出码和输出原样给（拿来和假的 git 比） */
  const raw = (args: readonly string[], cwd = root): { exitCode: number; stdout: string } => {
    const result = spawnSync('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' })
    return { exitCode: result.status ?? -1, stdout: result.stdout }
  }
  if (!options.plain) git('init', '-q', '-b', 'main', '.')
  /** 对面看到的仓库位置：装成 Windows 时是 C:/… */
  const remoteRoot = options.drive ? `C:${root}` : root
  /** 对面的路径换成这台机器上的 */
  const local = (path: unknown): string =>
    options.drive && typeof path === 'string' ? path.replace(/^C:/i, '') : (path as string)
  /** 这台机器上的 git 给的路径换成对面的写法 */
  const remote = (text: string): string =>
    options.drive ? text.split(base).join(`C:${base}`) : text

  const time = fakeClock()
  const children = new Map<string, ChildProcess>()
  /** 对面收到过的请求 */
  const seen: { method: string; params: Record<string, unknown> }[] = []
  let online = true
  /** 让对面“没有 git”：起进程时回的是找不到程序 */
  const state = {
    gitMissing: false,
    roots: new Set<string>([remoteRoot]),
    turnDiff: options.turnDiff,
    /** 每起一条命令叫一次：测试拿它卡在“命令刚发出去”的那一刻 */
    onSpawn: null as ((command: string[]) => void) | null,
  }

  const request = async (method: string, raw: unknown): Promise<unknown> => {
    const params = raw as Record<string, unknown>
    seen.push({ method, params })
    if (method === 'process/spawn') {
      if (options.noSpawn) throw new RpcError(-32601, `Method not found: ${method}`)
      const command = params.command as string[]
      const handle = params.processHandle as string
      const cap = typeof params.outputBytesCap === 'number' ? params.outputBytesCap : 1_048_576
      const program = state.gitMissing ? 'litch-no-such-git' : (command[0] ?? '')
      return new Promise((resolve, reject) => {
        const child = spawn(program, command.slice(1), {
          cwd: local(params.cwd),
          env: { ...GIT_ENV, ...(params.env as Record<string, string> | null) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        children.set(handle, child)
        state.onSpawn?.(command)
        const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
        const size = { stdout: 0, stderr: 0 }
        const capped = { stdout: false, stderr: false }
        for (const stream of ['stdout', 'stderr'] as const) {
          child[stream]?.on('data', (chunk: Buffer) => {
            const room = cap - size[stream]
            if (room <= 0) return
            const kept = chunk.subarray(0, room)
            out[stream].push(kept)
            size[stream] += kept.length
            capped[stream] = size[stream] === cap
          })
        }
        child.once('error', (error) => {
          children.delete(handle)
          reject(new RpcError(-32603, `failed to spawn process: ${error.message}`))
        })
        child.once('spawn', () => resolve({}))
        child.once('close', (code, signal) => {
          children.delete(handle)
          if (!online) return
          diffs.notification('process/exited', {
            processHandle: handle,
            exitCode: code ?? (signal ? 137 : 1),
            stdout: remote(Buffer.concat(out.stdout).toString('utf8')),
            stderr: Buffer.concat(out.stderr).toString('utf8'),
            stdoutCapReached: capped.stdout,
            stderrCapReached: capped.stderr,
          })
        })
      })
    }
    if (method === 'process/kill') {
      children.get(params.processHandle as string)?.kill('SIGKILL')
      return {}
    }
    if (method === 'fs/getMetadata') {
      try {
        const stat = statSync(local(params.path))
        return {
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          isSymlink: false,
          createdAtMs: 0,
          modifiedAtMs: 0,
        }
      } catch {
        throw new RpcError(
          -32603,
          `ENOENT: no such file or directory, stat '${String(params.path)}'`,
        )
      }
    }
    if (method === 'fs/watch') {
      if (options.noWatch) throw new RpcError(-32601, `Method not found: ${method}`)
      if (options.watchDelayMs) {
        await new Promise((done) => setTimeout(done, options.watchDelayMs))
      }
      return { path: params.path }
    }
    if (method === 'fs/unwatch') return {}
    throw new RpcError(-32601, `Method not found: ${method}`)
  }

  const diffs = createDiffs({
    clock: time.clock,
    online: () => online,
    platform: () => options.platform ?? null,
    knownRoot: (path) => [...state.roots].some((known) => samePath(known, path)),
    turnDiffDeclared: () => (state.turnDiff === undefined ? null : state.turnDiff),
    request: ((method: string, params: unknown) => request(method, params)) as never,
    fail: (error) => error as ChannelError,
    log() {},
    random: () => 0.5,
  })

  /** 订阅概况，像界面那样把每次给的整份记下来 */
  const watch = (scope: DiffScope = 'all', sessionId: string | null = 's1', at = remoteRoot) => {
    const views: DiffView[] = []
    const stop = diffs.open(at, scope, sessionId, {
      snapshot: (data) => views.push(data as DiffView),
      delta: (ops) => {
        for (const op of ops as { op: string; view: DiffView }[]) views.push(op.view)
      },
      error() {},
    })
    const latest = (): DiffView => views[views.length - 1] as DiffView
    /** 等到取完（不在取了，而且不是还没开始的样子） */
    const settled = async (): Promise<DiffView> => {
      for (let n = 0; n < 2000; n++) {
        const view = latest()
        if (view.phase !== 'loading' && !view.refreshing) return view
        await new Promise((done) => setTimeout(done, 5))
      }
      throw new Error(`概况一直没取完：${JSON.stringify(latest())}`)
    }
    /** 等到版本变了并且取完 */
    const next = async (after: number): Promise<DiffView> => {
      for (let n = 0; n < 2000; n++) {
        const view = latest()
        if (view.version !== after && view.phase !== 'loading' && !view.refreshing) return view
        await new Promise((done) => setTimeout(done, 5))
      }
      throw new Error(`概况一直没换成新的：${JSON.stringify(latest())}`)
    }
    return { views, stop, latest, settled, next }
  }

  return {
    base,
    root,
    remoteRoot,
    git,
    put,
    raw,
    diffs,
    time,
    seen,
    state,
    watch,
    /** 对面收到过的某个方法的参数 */
    sent: (method: string) =>
      seen.filter((entry) => entry.method === method).map((entry) => entry.params),
    /** 起过的 git 命令：去掉前面固定的那一串，只留子命令和它的参数 */
    commands: (): string[][] =>
      seen
        .filter((entry) => entry.method === 'process/spawn')
        .map((entry) => {
          const command = entry.params.command as string[]
          return command.slice(command.indexOf('diff.mnemonicPrefix=false') + 1)
        }),
    setOnline(value: boolean) {
      online = value
    },
    cleanup() {
      online = false
      for (const child of children.values()) child.kill('SIGKILL')
      rmSync(base, { recursive: true, force: true })
    },
  }
}

export type GitWorld = ReturnType<typeof gitWorld>

/**
 * 摆一个有各种改动的仓库：改了内容的、删了的、暂存了的改名、权限变了的、二进制的、暂存区里新加的、
 * 没跟踪的（文字的、二进制的、空的）、子目录里的、名字里有中文和空格的
 */
export function mixedRepo(world: GitWorld): void {
  const { git, put } = world
  put('mod.txt', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n')
  put('del.txt', 'x\ny\n')
  put('old-name.txt', 'r1\nr2\nr3\nr4\nr5\n')
  put('run.sh', '#!/bin/sh\necho hi\n')
  put('pic.bin', Uint8Array.from([0, 1, 2, 98, 105, 110]))
  put('sub/in.txt', 's\n')
  put('中文 名.txt', '中\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  put('mod.txt', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\n')
  git('rm', '-q', 'del.txt')
  git('mv', 'old-name.txt', 'new-name.txt')
  chmodSync(join(world.root, 'run.sh'), 0o755)
  put('pic.bin', Uint8Array.from([0, 9, 2, 98, 105, 110, 50]))
  put('untracked.txt', 'new\nfile\nno newline')
  put('untracked.bin', Uint8Array.from([0, 1]))
  put('empty-untracked.txt', '')
  put('staged-new.txt', 'staged\n')
  git('add', 'staged-new.txt')
  put('中文 名.txt', '中\n文\n')
  put('sub/in.txt', 's\nt\n')
}
