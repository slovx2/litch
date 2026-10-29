// 后台 shell（Litch 注入的 litch_shell 工具）：给没有原生后台命令的 harness（Pi、OpenCode、通用 ACP 入口的 acp）用。
// Claude、原生 codex、dsh 有自己的，不带它。
//
// 进程归引擎的运行时进程：模型调 start 时由引擎起一个 shell（POSIX 上自成一个进程组），标准输入关着，标准输出、
// 标准错误写进 <引擎目录>/background-shell/ 下的日志文件（单个文件满了换下一个，最多留两个）。命令自己退出、
// 被模型或用户停掉都记下来；客户端连着与否、会话装没装载都不影响它；运行时退出（关服务、改设置重启）时整组结束。
// 结束过的只在内存里，每个会话最多留 BACKGROUND_ENDED_LIMIT 个，挤掉的连日志一起删；运行时起来时清掉上次留下的日志。
//
// 每个会话的任务就是 backgroundTasks 扩展的集合（kind 都是 shell）；集合变了叫 host.changed，由引擎整份发出去。
// 命令自己退出的（不是被停掉的）攒一小会儿一起交给 host.finished，引擎据此唤醒模型接着做（formatShellEvent 是给
// 模型的那段话）。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  type WriteStream,
} from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  BACKGROUND_ENDED_LIMIT,
  type BackgroundTaskStatus,
  type LitchBackgroundTask,
} from '../../protocol/src/background-tasks.mjs'
import type { ClientToolNamespaceSpec } from '../../protocol/src/client-tools.mjs'
import { commandEnv } from './command-env.mjs'

/** 设置 harness.<id>.backgroundShell 落到的环境变量：1 开、0 关，运行时起来时读一次 */
export const BACKGROUND_SHELL_VARIABLE = 'CHA_BACKGROUND_SHELL'

/** 设置里没写过、环境里也没给时开着（每个 harness 可在设置里单独关） */
export const BACKGROUND_SHELL_DEFAULT = true

export function backgroundShellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[BACKGROUND_SHELL_VARIABLE]
  if (value === '1') return true
  if (value === '0') return false
  return BACKGROUND_SHELL_DEFAULT
}

export const BACKGROUND_SHELL_LIMITS = {
  /** 一个会话同时在跑的最多几个 */
  runningPerThread: 16,
  /** 一个运行时同时在跑的最多几个 */
  runningTotal: 64,
  /** 单个日志文件多大换下一个（只留上一个），所以一个任务最多占两倍 */
  logFileBytes: 16 * 1024 * 1024,
  /** read 一次最多读多少字节 */
  readMaxBytes: 64_000,
  readDefaultBytes: 8_000,
  /** read 最多等几秒 */
  waitMaxSeconds: 300,
  /** 停的时候先发 SIGTERM，等这么久还没退出就 SIGKILL */
  killGraceMs: 3_000,
  /** 进程组里一个都不剩之后再等这么久把管道里剩下的读完 */
  drainMs: 2_000,
  /** shell 退出了、它放到后台的进程（`x &`、`nohup x &`）还在：隔多久看一次进程组还有没有活的 */
  groupPollMs: 250,
  /** 命令退出后攒这么久，一起交给 host.finished（几个差不多同时结束的只唤醒一次） */
  settleMs: 300,
  /** 唤醒时给模型看的输出末尾多少字节 */
  eventTailBytes: 2_000,
}

/** 谁停的：模型（stop 工具）、用户（backgroundTerminals/terminate、clean）、运行时退出、会话删掉 */
export type ShellStopper = 'model' | 'user' | 'shutdown' | 'deleted'

export interface ShellTask {
  id: string
  threadId: string
  command: string
  title: string
  cwd: string
  pid: number | null
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt?: number
  stoppedBy?: ShellStopper
  /** 起它的那次工具调用（条目号）、回合 */
  itemId?: string
  turnId?: string
  /** 现在写的日志文件；满了挪成 `<它>.1` */
  log: string
  /** 现在这个日志文件写了多少字节 */
  logBytes: number
  /** 一共输出了多少字节 */
  totalBytes: number
}

export interface BackgroundShellHost {
  /** 这个会话的集合变了（起了、结束了、挤掉了） */
  changed(threadId: string): void
  /** 这几个任务自己退出了（不是被停掉的）：引擎看要不要唤醒模型 */
  finished(threadId: string, tasks: ShellTask[]): void
  log?(line: string): void
}

export interface ShellStart {
  command: string
  /** 绝对路径，或相对会话目录 */
  cwd?: string
  title?: string
  itemId?: string
  turnId?: string
}

/** 工具调用的结果。引擎各自换成自己的形状（Pi 的工具结果、MCP 的 content） */
export interface ShellToolResult {
  text: string
  isError: boolean
}

interface Running {
  child: ChildProcess
  stream: WriteStream
  /** 日志写不进去了（磁盘满、目录被删）：之后的输出只计数不落盘 */
  logBroken: boolean
  /** shell 退出了（退出码有了），管道可能还没读完 */
  exited: boolean
  /** 等它结束的（read 的 wait_seconds、close） */
  waiters: Set<() => void>
  killTimer?: NodeJS.Timeout
  /** shell 退出了、进程组还有活的：轮询它 */
  groupPoll?: NodeJS.Timeout
  drainTimer?: NodeJS.Timeout
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 一段时长给人和模型看：2h 3m、4m 5s、6s */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

/** 状态说成一句：running、completed (exit code 0)、failed (exit code 2)、failed (signal SIGKILL)、stopped by the model */
export function statusText(task: ShellTask): string {
  if (task.status === 'running') return 'running'
  if (task.status === 'stopped')
    return task.stoppedBy === 'model'
      ? 'stopped by you'
      : task.stoppedBy === 'user'
        ? 'stopped by the user'
        : 'stopped'
  if (task.signal) return `${task.status} (signal ${task.signal})`
  return `${task.status} (exit code ${task.exitCode ?? 'unknown'})`
}

/** POSIX 用用户的 bash 或 zsh，没有就 sh；Windows 用 cmd */
function shellOf(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32')
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  const own = process.env.SHELL ?? ''
  const file =
    /\/(bash|zsh)$/.test(own) && existsSync(own)
      ? own
      : existsSync('/bin/bash')
        ? '/bin/bash'
        : '/bin/sh'
  return { file, args: ['-c', command] }
}

/** 命令实际在哪个目录跑：模型给的 cwd 接在会话目录后面（绝对路径照用），没给就是会话目录。审批也按它问 */
export function shellCwd(baseCwd: string, cwd?: string): string {
  return cwd ? (isAbsolute(cwd) ? cwd : resolve(baseCwd, cwd)) : baseCwd
}

/** 这个进程组还有没有活着的进程（Windows 没有进程组，算没有） */
function groupAlive(child: ChildProcess): boolean {
  if (process.platform === 'win32' || child.pid === undefined) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class BackgroundShells {
  private readonly dir: string
  private readonly host: BackgroundShellHost
  private readonly now: () => number
  /** 每个会话的任务，键是任务号 */
  private readonly threads = new Map<string, Map<string, ShellTask>>()
  private readonly running = new Map<string, Running>()
  /** 自己退出、还没交给 host.finished 的，按会话 */
  private readonly settling = new Map<string, { tasks: ShellTask[]; timer: NodeJS.Timeout }>()
  /**
   * 用户停掉的、模型还不知道的，按会话。照 Claude 的做法不唤醒，下一轮开头由引擎经 takeStopNotice 交给模型，
   * 只交一次；模型在这之前自己 read、list 看到了的就不再交
   */
  private readonly userStops = new Map<string, ShellTask[]>()
  private seq = 0
  private closed = false

  /** dir：日志放在哪（不存在就建）。起来时清掉里面上次留下的 */
  constructor(dir: string, host: BackgroundShellHost, now: () => number = Date.now) {
    this.dir = dir
    this.host = host
    this.now = now
    rmSync(dir, { recursive: true, force: true })
  }

  /** 这个会话的任务：运行中的在前（按开始），结束的在后（按结束倒序） */
  list(threadId: string): ShellTask[] {
    const tasks = [...(this.threads.get(threadId)?.values() ?? [])]
    const running = tasks.filter((task) => task.status === 'running')
    const ended = tasks.filter((task) => task.status !== 'running')
    running.sort((a, b) => a.startedAt - b.startedAt)
    ended.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    return [...running, ...ended]
  }

  get(threadId: string, id: string): ShellTask | null {
    return this.threads.get(threadId)?.get(id) ?? null
  }

  /** 这个会话还在跑的有几个 */
  runningCount(threadId?: string): number {
    let count = 0
    for (const [id, task] of this.allTasks())
      if (this.running.has(id) && (threadId === undefined || task.threadId === threadId)) count++
    return count
  }

  /** 只读内存活动索引，电源恢复时不枚举持久化历史。 */
  runningThreadIds(): string[] {
    return [...this.threads]
      .filter(([, tasks]) => [...tasks.values()].some((task) => task.status === 'running'))
      .map(([id]) => id)
  }

  /** backgroundTasks 扩展的集合 */
  collection(threadId: string): LitchBackgroundTask[] {
    return this.list(threadId).map((task) => ({
      id: task.id,
      kind: 'shell',
      title: task.title,
      status: task.status,
      ...(task.itemId ? { itemId: task.itemId } : {}),
      ...(task.turnId ? { turnId: task.turnId } : {}),
      startedAt: task.startedAt,
      ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    }))
  }

  /** thread/backgroundTerminals/list 的条目（只列在跑的），processId 就是任务号 */
  terminals(threadId: string) {
    return this.list(threadId)
      .filter((task) => task.status === 'running')
      .map((task) => ({
        itemId: task.itemId ?? task.id,
        processId: task.id,
        command: task.command,
        cwd: task.cwd,
        osPid: task.pid,
        cpuPercent: null,
        rssKb: null,
      }))
  }

  /** 起一个。baseCwd 是会话目录。超了上限、目录不在抛错（错误信息给模型看，用英文） */
  start(threadId: string, request: ShellStart, baseCwd: string): ShellTask {
    if (this.closed) throw new Error('the runtime is shutting down')
    const command = request.command.trim()
    if (!command) throw new Error('command is empty')
    if (this.runningCount(threadId) >= BACKGROUND_SHELL_LIMITS.runningPerThread)
      throw new Error(
        `this session already has ${BACKGROUND_SHELL_LIMITS.runningPerThread} background tasks running; stop one first`,
      )
    if (this.runningCount() >= BACKGROUND_SHELL_LIMITS.runningTotal)
      throw new Error('too many background tasks are running on this device; stop one first')
    const cwd = shellCwd(baseCwd, request.cwd)
    if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`)
    const id = `shell-${++this.seq}`
    const folder = join(this.dir, threadKey(threadId))
    mkdirSync(folder, { recursive: true })
    const task: ShellTask = {
      id,
      threadId,
      command,
      title: (request.title?.trim() || command).replace(/\s+/g, ' ').slice(0, 200),
      cwd,
      pid: null,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: this.now(),
      ...(request.itemId ? { itemId: request.itemId } : {}),
      ...(request.turnId ? { turnId: request.turnId } : {}),
      log: join(folder, `${id}.log`),
      logBytes: 0,
      totalBytes: 0,
    }
    const { file, args } = shellOf(command)
    const child = spawn(file, args, {
      cwd,
      env: commandEnv(undefined),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const entry: Running = {
      child,
      stream: this.logStream(task, task.log),
      logBroken: false,
      exited: false,
      waiters: new Set(),
    }
    task.pid = child.pid ?? null
    const tasks = this.threads.get(threadId) ?? new Map<string, ShellTask>()
    tasks.set(id, task)
    this.threads.set(threadId, tasks)
    this.running.set(id, entry)
    const write = (chunk: Buffer) => this.write(task, entry, chunk)
    child.stdout?.on('data', write)
    child.stderr?.on('data', write)
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (entry.drainTimer) clearTimeout(entry.drainTimer)
      if (entry.groupPoll) clearInterval(entry.groupPoll)
      if (!this.running.has(id)) return
      this.ended(task, entry, code, signal)
    }
    // shell 退出后：它放到后台的进程（同一个进程组）还活着，任务就还算在跑，接着收它们的输出，
    // 一个都不剩了再把管道里剩下的读完、按 shell 的退出码结束。停、关闭时照样按进程组杀
    let pipesClosed = false
    const afterExit = () => {
      if (entry.groupPoll || entry.drainTimer || !this.running.has(id)) return
      const drain = () => {
        if (pipesClosed) return finish(task.exitCode, task.signal as NodeJS.Signals | null)
        entry.drainTimer = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(task.exitCode, task.signal as NodeJS.Signals | null)
        }, BACKGROUND_SHELL_LIMITS.drainMs)
        entry.drainTimer.unref()
      }
      if (!groupAlive(child)) return drain()
      entry.groupPoll = setInterval(() => {
        if (groupAlive(child)) return
        clearInterval(entry.groupPoll)
        drain()
      }, BACKGROUND_SHELL_LIMITS.groupPollMs)
      entry.groupPoll.unref()
    }
    child.on('error', (error) => {
      this.write(task, entry, Buffer.from(`\n[failed to start: ${error.message}]\n`))
      finish(127, null)
    })
    child.on('exit', (code, signal) => {
      entry.exited = true
      task.exitCode = code
      task.signal = signal
      afterExit()
    })
    // 管道都关了：组里没有活的就结束（不等 drain 到点），还有活的（输出重定向走了的守护进程）接着等它们
    child.on('close', () => {
      pipesClosed = true
      if (!entry.exited || groupAlive(child)) return
      finish(task.exitCode, task.signal as NodeJS.Signals | null)
    })
    this.host.log?.(`后台 shell ${id}（会话 ${threadId}）起了：${command}`)
    this.host.changed(threadId)
    return task
  }

  /** 读这个任务的状态和输出末尾。waitSeconds：还在跑时最多等它这么久（结束了、signal 作废了就提前回） */
  async read(
    threadId: string,
    id: string,
    options: { waitSeconds?: number; maxBytes?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ task: ShellTask; output: string; omittedBytes: number }> {
    const task = this.get(threadId, id)
    if (!task) throw new Error(`no background task ${id} in this session`)
    const wait = Math.min(
      Math.max(0, options.waitSeconds ?? 0),
      BACKGROUND_SHELL_LIMITS.waitMaxSeconds,
    )
    const entry = this.running.get(id)
    if (entry && wait > 0 && !signal?.aborted)
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(timer)
          entry.waiters.delete(finish)
          signal?.removeEventListener('abort', finish)
          done()
        }
        const timer = setTimeout(finish, wait * 1000)
        entry.waiters.add(finish)
        signal?.addEventListener('abort', finish, { once: true })
      })
    const max = Math.min(
      Math.max(1, options.maxBytes ?? BACKGROUND_SHELL_LIMITS.readDefaultBytes),
      BACKGROUND_SHELL_LIMITS.readMaxBytes,
    )
    const output = await tail(task, max)
    return { task, output, omittedBytes: Math.max(0, task.totalBytes - Buffer.byteLength(output)) }
  }

  /** 停一个（连它起的整组进程）。已经结束的、已经在停的、不认识的返回 false */
  stop(threadId: string, id: string, by: ShellStopper): boolean {
    const task = this.get(threadId, id)
    const entry = this.running.get(id)
    if (!task || !entry || task.status !== 'running' || task.stoppedBy) return false
    task.stoppedBy = by
    killTree(entry.child, 'SIGTERM')
    entry.killTimer = setTimeout(
      () => killTree(entry.child, 'SIGKILL'),
      BACKGROUND_SHELL_LIMITS.killGraceMs,
    )
    entry.killTimer.unref()
    return true
  }

  /** 停掉这个会话全部在跑的，返回停了几个 */
  stopThread(threadId: string, by: ShellStopper): number {
    let count = 0
    for (const task of this.list(threadId)) if (this.stop(threadId, task.id, by)) count++
    return count
  }

  /** 会话删掉了：停掉在跑的，记录和日志都不要了 */
  forget(threadId: string): void {
    this.stopThread(threadId, 'deleted')
    const tasks = this.threads.get(threadId)
    this.threads.delete(threadId)
    this.settling.delete(threadId)
    this.userStops.delete(threadId)
    if (tasks) rmSync(join(this.dir, threadKey(threadId)), { recursive: true, force: true })
  }

  /** 运行时要退出了：全部停掉（先 SIGTERM，宽限之后 SIGKILL），等它们都结束或宽限到点 */
  async close(): Promise<void> {
    this.closed = true
    for (const timer of this.settling.values()) clearTimeout(timer.timer)
    this.settling.clear()
    const waits: Promise<void>[] = []
    for (const [id, entry] of this.running) {
      const task = this.findTask(id)
      if (task) task.stoppedBy = 'shutdown'
      killTree(entry.child, 'SIGTERM')
      waits.push(
        new Promise<void>((done) => {
          const timer = setTimeout(() => {
            killTree(entry.child, 'SIGKILL')
            done()
          }, BACKGROUND_SHELL_LIMITS.killGraceMs)
          timer.unref()
          // 等的是任务结束（ended 里叫 waiters），不是 shell 的 exit：shell 已经退出、组里还有活的也等得到
          entry.waiters.add(() => {
            clearTimeout(timer)
            done()
          })
        }),
      )
    }
    await Promise.all(waits)
  }

  /**
   * 下一轮开头交给模型的那段话：上一轮之后用户停掉了哪几个（引擎在用户的下一条消息、后台唤醒等任何一轮交出去时取）。
   * 取了就清掉，没有返回 null
   */
  takeStopNotice(threadId: string): string | null {
    const tasks = this.userStops.get(threadId)
    this.userStops.delete(threadId)
    return tasks?.length ? formatStopNotice(tasks) : null
  }

  /** 模型经工具看到了这几个的状态（read、list、stop 的结果）：用户停掉的不用再在下一轮说 */
  seen(threadId: string, ids: string[]): void {
    const tasks = this.userStops.get(threadId)
    if (!tasks) return
    const rest = tasks.filter((task) => !ids.includes(task.id))
    if (rest.length) this.userStops.set(threadId, rest)
    else this.userStops.delete(threadId)
  }

  /** 运行时退出时同步地把还在跑的整组杀掉（进程的 exit 事件里只能做同步的事） */
  killAllSync(): void {
    for (const entry of this.running.values()) killTree(entry.child, 'SIGKILL')
  }

  // ---------- 内部 ----------

  private *allTasks(): Iterable<[string, ShellTask]> {
    for (const tasks of this.threads.values()) yield* tasks
  }

  private findTask(id: string): ShellTask | null {
    for (const [key, task] of this.allTasks()) if (key === id) return task
    return null
  }

  private write(task: ShellTask, entry: Running, chunk: Buffer): void {
    task.totalBytes += chunk.length
    if (entry.logBroken) return
    if (task.logBytes + chunk.length > BACKGROUND_SHELL_LIMITS.logFileBytes && task.logBytes > 0) {
      // 满了：现在这个挪成 .1（顶掉更早的），接着写新的
      entry.stream = this.rotate(task, entry.stream)
      task.logBytes = 0
    }
    task.logBytes += chunk.length
    if (entry.stream.write(chunk)) return
    // 落盘跟不上：先不读管道（命令写满管道就会停下来等），写完了再接着读
    const { stdout, stderr } = entry.child
    stdout?.pause()
    stderr?.pause()
    const resume = () => {
      stdout?.resume()
      stderr?.resume()
    }
    entry.stream.once('drain', resume)
    entry.stream.once('error', resume)
  }

  /** 日志的写入流：出错（磁盘满、目录被删）不让整个运行时退出，这个任务之后只计数不落盘 */
  private logStream(task: ShellTask, path: string, flags = 'w'): WriteStream {
    const stream = createWriteStream(path, { flags })
    stream.on('error', (error) => {
      const entry = this.running.get(task.id)
      if (entry && entry.stream === stream && !entry.logBroken) {
        entry.logBroken = true
        this.host.log?.(
          `后台 shell ${task.id} 的日志写不进去了，之后的输出不再落盘：${error.message}`,
        )
      }
    })
    return stream
  }

  private rotate(task: ShellTask, full: WriteStream): WriteStream {
    full.end()
    // 写入是异步的，旧流里还没落盘的会跟着打开着的文件描述符写进改名后的 .1，新输出进新文件。
    // Windows 上改不了打开着的文件的名字：不换，接着写这一个
    try {
      rmSync(`${task.log}.1`, { force: true })
      renameSync(task.log, `${task.log}.1`)
    } catch {
      return this.logStream(task, task.log, 'a')
    }
    return this.logStream(task, task.log)
  }

  private ended(
    task: ShellTask,
    entry: Running,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.running.delete(task.id)
    if (entry.killTimer) clearTimeout(entry.killTimer)
    entry.stream.end()
    task.exitCode = code
    task.signal = signal
    task.endedAt = this.now()
    task.status = task.stoppedBy ? 'stopped' : code === 0 && !signal ? 'completed' : 'failed'
    for (const waiter of [...entry.waiters]) waiter()
    this.host.log?.(`后台 shell ${task.id}（会话 ${task.threadId}）结束：${statusText(task)}`)
    this.evict(task.threadId)
    this.host.changed(task.threadId)
    if (task.stoppedBy === 'user' && !this.closed)
      this.userStops.set(task.threadId, [...(this.userStops.get(task.threadId) ?? []), task])
    if (task.stoppedBy || this.closed) return
    // 自己退出的：攒一小会儿，差不多同时结束的一起交出去
    const pending = this.settling.get(task.threadId)
    if (pending) {
      pending.tasks.push(task)
      return
    }
    const timer = setTimeout(() => {
      const batch = this.settling.get(task.threadId)
      this.settling.delete(task.threadId)
      if (batch && !this.closed) this.host.finished(task.threadId, batch.tasks)
    }, BACKGROUND_SHELL_LIMITS.settleMs)
    this.settling.set(task.threadId, { tasks: [task], timer })
  }

  /** 结束过的超过上限：挤掉最早结束的，日志一起删 */
  private evict(threadId: string): void {
    const tasks = this.threads.get(threadId)
    if (!tasks) return
    const ended = this.list(threadId).filter((task) => task.status !== 'running')
    for (const task of ended.slice(BACKGROUND_ENDED_LIMIT)) {
      tasks.delete(task.id)
      rmSync(task.log, { force: true })
      rmSync(`${task.log}.1`, { force: true })
    }
  }
}

/** 会话号可能带路径不认的字，目录名用它的安全形式 */
function threadKey(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'thread'
}

/** 日志末尾 max 字节（不够就从 .1 的末尾补） */
async function tail(task: ShellTask, max: number): Promise<string> {
  const read = async (path: string, bytes: number): Promise<Buffer> => {
    const size = await stat(path).then(
      (info) => info.size,
      () => 0,
    )
    if (size === 0 || bytes <= 0) return Buffer.alloc(0)
    const length = Math.min(size, bytes)
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, size - length)
      return buffer
    } finally {
      await file.close()
    }
  }
  const latest = await read(task.log, max)
  const earlier =
    latest.length < max ? await read(`${task.log}.1`, max - latest.length) : Buffer.alloc(0)
  // 截在多字节字符中间的那几个字节丢掉
  return Buffer.concat([earlier, latest]).toString('utf8').replace(/^�+/, '')
}

/** 连它起的整组进程一起：POSIX 发给进程组，Windows 用 taskkill /T */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    }
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

// ---------- 交给模型的工具 ----------

/** 命名空间。Pi 没有命名空间这一层，工具名是 litch_shell_start 这样拼起来的 */
export const BACKGROUND_SHELL_NAMESPACE = 'litch_shell'

export type ShellToolName = 'start' | 'read' | 'stop' | 'list'

/** 起命令的那个工具：要走审批的就是它（引擎按自己“跑命令”的规矩问） */
export const SHELL_START_TOOL: ShellToolName = 'start'

const ID = { type: 'string', description: 'Task id returned by start, e.g. shell-3.' }

/** 工具定义（形状同客户端工具的命名空间，client-tools.mts 的 ClientToolNamespaceSpec）。wakes：跑完会不会叫醒模型 */
export function backgroundShellSpec(wakes: boolean): ClientToolNamespaceSpec {
  const after = wakes
    ? 'When a task exits on its own you get a <litch-background-event> message and continue automatically, so you can end your turn instead of waiting.'
    : 'You are not notified when a task exits; check it with read.'
  return {
    type: 'namespace',
    name: BACKGROUND_SHELL_NAMESPACE,
    description: `Background shell: commands that keep running after your turn ends (dev servers, watchers, long builds or test runs, long-running scripts). The user sees which tasks are running. ${after}`,
    tools: [
      {
        type: 'function',
        name: 'start',
        description: `Start a shell command in the background and return immediately with its task id. Use it for commands that take more than a couple of minutes or must keep running; run quick commands with your normal shell tool instead. stdin is closed; stdout and stderr go to a log file. ${after}`,
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run.' },
            cwd: {
              type: 'string',
              description:
                'Working directory, absolute or relative to the session folder. Default: the session folder.',
            },
            title: {
              type: 'string',
              description:
                'Short label shown to the user, under 60 characters. Default: the command.',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'read',
        description:
          'Check a background task: status, exit code, run time and the end of its output. Set wait_seconds to wait for it to exit first (returns early when it does).',
        inputSchema: {
          type: 'object',
          properties: {
            id: ID,
            wait_seconds: {
              type: 'integer',
              minimum: 0,
              maximum: BACKGROUND_SHELL_LIMITS.waitMaxSeconds,
              description: 'Wait up to this many seconds for the task to exit. Default 0.',
            },
            max_bytes: {
              type: 'integer',
              minimum: 1,
              maximum: BACKGROUND_SHELL_LIMITS.readMaxBytes,
              description: `How much of the end of the output to return. Default ${BACKGROUND_SHELL_LIMITS.readDefaultBytes}.`,
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'stop',
        description:
          'Stop a background task and every process it started (SIGTERM, then SIGKILL after 3 seconds).',
        inputSchema: {
          type: 'object',
          properties: { id: ID },
          required: ['id'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'list',
        description: "List this session's background tasks with status and run time.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }
}

/** 一行说一个任务（list、start 的结果用） */
function taskLine(task: ShellTask, now: number): string {
  const time = formatDuration((task.endedAt ?? now) - task.startedAt)
  const title = task.title === task.command ? '' : ` "${task.title}"`
  return `${task.id}${title}: ${statusText(task)}, ${task.status === 'running' ? 'running for' : 'ran'} ${time} — ${task.command}`
}

const fail = (message: string): ShellToolResult => ({ text: message, isError: true })

/**
 * 执行一次工具调用。threadId、cwd 是发起它的会话和会话目录；itemId、turnId 是这次调用的条目和回合（记在任务上，
 * 集合里能挂回对话）。参数不对、超了上限都按失败答，不抛错
 */
export async function runShellTool(
  shells: BackgroundShells,
  call: {
    threadId: string
    cwd: string
    tool: string
    arguments: unknown
    itemId?: string
    turnId?: string
  },
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<ShellToolResult> {
  const args =
    call.arguments && typeof call.arguments === 'object'
      ? (call.arguments as Record<string, unknown>)
      : {}
  try {
    switch (call.tool) {
      case 'start': {
        const task = shells.start(
          call.threadId,
          {
            command: text(args.command),
            ...(text(args.cwd) ? { cwd: text(args.cwd) } : {}),
            ...(text(args.title) ? { title: text(args.title) } : {}),
            ...(call.itemId ? { itemId: call.itemId } : {}),
            ...(call.turnId ? { turnId: call.turnId } : {}),
          },
          call.cwd,
        )
        return {
          text: `Started background task ${task.id}${task.pid ? ` (pid ${task.pid})` : ''} in ${task.cwd}. Output log: ${task.log}`,
          isError: false,
        }
      }
      case 'read': {
        const id = text(args.id)
        const wait = typeof args.wait_seconds === 'number' ? args.wait_seconds : 0
        const max = typeof args.max_bytes === 'number' ? args.max_bytes : undefined
        const { task, output, omittedBytes } = await shells.read(
          call.threadId,
          id,
          { waitSeconds: wait, ...(max !== undefined ? { maxBytes: max } : {}) },
          signal,
        )
        shells.seen(call.threadId, [task.id])
        const head = taskLine(task, now())
        const note =
          omittedBytes > 0
            ? `\n(${omittedBytes} earlier bytes not shown; full log: ${task.log})`
            : ''
        return { text: `${head}${note}\n<output>\n${output}\n</output>`, isError: false }
      }
      case 'stop': {
        const id = text(args.id)
        const task = shells.get(call.threadId, id)
        if (!task) return fail(`no background task ${id} in this session`)
        shells.seen(call.threadId, [id])
        if (!shells.stop(call.threadId, id, 'model'))
          return { text: `${id} is not running: ${statusText(task)}`, isError: false }
        return { text: `Stopping ${id}.`, isError: false }
      }
      case 'list': {
        const tasks = shells.list(call.threadId)
        shells.seen(
          call.threadId,
          tasks.map((task) => task.id),
        )
        if (tasks.length === 0)
          return { text: 'No background tasks in this session.', isError: false }
        return { text: tasks.map((task) => taskLine(task, now())).join('\n'), isError: false }
      }
      default:
        return fail(`unknown tool ${BACKGROUND_SHELL_NAMESPACE}.${call.tool}`)
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

// ---------- 唤醒 ----------

const EVENT_TAG = 'litch-background-event'

/** 唤醒模型时交给它的那段话：几个自己退出了的任务，各带输出的末尾 */
export async function formatShellEvent(tasks: ShellTask[]): Promise<string> {
  const blocks: string[] = []
  for (const task of tasks) {
    const output = await tail(task, BACKGROUND_SHELL_LIMITS.eventTailBytes)
    blocks.push(
      [
        `Background task ${task.id} exited: ${statusText(task)} after ${formatDuration((task.endedAt ?? task.startedAt) - task.startedAt)}.`,
        `Command: ${task.command}`,
        `Output log: ${task.log}`,
        `<output>\n${output}\n</output>`,
      ].join('\n'),
    )
  }
  return `<${EVENT_TAG}>\n${blocks.join('\n\n')}\n</${EVENT_TAG}>`
}

const NOTICE_TAG = 'litch-background-notice'

/**
 * 用户停掉了的那几个，下一轮开头交给模型的那段话（不唤醒，照 Claude 对用户停的后台命令那条不开回合的通知）。
 * 标签和唤醒的不同：引擎把它接在用户那句话后面，重读历史时不能被当成一轮唤醒
 */
export function formatStopNotice(tasks: ShellTask[]): string {
  const lines = tasks.map(
    (task) =>
      `Background task ${task.id} was stopped by the user after ${formatDuration((task.endedAt ?? task.startedAt) - task.startedAt)}. Command: ${task.command}`,
  )
  return `<${NOTICE_TAG}>\n${lines.join('\n')}\n</${NOTICE_TAG}>`
}

/** 一句话后面接上用户停掉的那段（没有就原样） */
export function withStopNotice(text: string, notice: string | null): string {
  if (!notice) return text
  return text ? `${text}\n\n${notice}` : notice
}

/** 这段文字是不是唤醒时交给模型的（引擎重读历史时认出来：不画成用户的话，回合记成后台任务唤醒的） */
export function isShellEventText(value: unknown): boolean {
  return typeof value === 'string' && value.trimStart().startsWith(`<${EVENT_TAG}>`)
}
