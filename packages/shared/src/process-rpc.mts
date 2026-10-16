import { type ChildProcess, spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { adapterCliPath } from './adapter-cli.mjs'
import { commandEnv } from './command-env.mjs'
import { decodeBase64 } from './filesystem-rpc.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import type { RpcPeer } from './types.mjs'
import { debugLog } from './util.mjs'

// 语义对齐 Codex 0.157.1：core/src/exec.rs 的默认超时与排空时间、utils/pty 的
// 默认输出上限、app-server 的 process_exec_processor.rs / command_exec.rs。
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_OUTPUT_BYTES_CAP = 1_048_576
const IO_DRAIN_TIMEOUT_MS = 2_000
const EXEC_TIMEOUT_EXIT_CODE = 124
export const DEFAULT_SIZE = { rows: 24, cols: 80 }

type Kind = 'command' | 'process'
type Stream = 'stdout' | 'stderr'

/** `process/exited` 通知里除句柄以外的内容 */
export interface ProcessExit {
  exitCode: number
  stdout: string
  stderr: string
  stdoutCapReached: boolean
  stderrCapReached: boolean
}

/**
 * 进程的输出和退出不发给发起它的连接，改交给它。只有设备进程给“属于设备的进程”用
 * （协议扩展 deviceProcesses）；不给的时候一切照旧，引擎的兼容面从不给。
 * 拿到的是原始字节，切分和 `process/outputDelta` 通知的一样。
 */
export interface ProcessSink {
  output(stream: Stream, chunk: Buffer, capReached: boolean): void
  exited(exit: ProcessExit): void
}

interface SpawnPlan {
  id: string
  key: string
  clientId: boolean
  command: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  tty: boolean
  stdin: boolean
  streaming: boolean
  size: { rows: number; cols: number }
  cap: number
  timeoutMs: number | null
}

function booleanParam(params: Record<string, unknown>, key: string): boolean {
  const value = params[key]
  if (value == null) return false
  if (typeof value !== 'boolean') throw new ProtocolError(-32602, `${key} 必须是布尔值`)
  return value
}

// usize 类型的字段：负数或非整数都是类型错误（原生由 serde 反序列化拒绝）。
function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ProtocolError(-32602, `${name} 必须是非负整数`)
  return value
}

function timeoutParam(value: unknown, method: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new ProtocolError(-32602, `${method} timeoutMs 必须是整数`)
  if (value < 0)
    throw new ProtocolError(-32602, `${method} timeoutMs must be non-negative, got ${value}`)
  return value
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new ProtocolError(-32602, 'command 必须是字符串数组')
  return value as string[]
}

function sizeParam(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 65535)
    throw new ProtocolError(-32602, `终端 ${name} 必须是 0 到 65535 之间的整数`)
  return value
}

function terminalSize(value: unknown, kind: Kind): { rows: number; cols: number } {
  const prefix = kind === 'command' ? 'command/exec' : 'process'
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, `${prefix} size 必须是 {rows, cols} 对象`)
  const size = value as Record<string, unknown>
  const rows = sizeParam(size.rows, 'rows')
  const cols = sizeParam(size.cols, 'cols')
  if (!rows || !cols)
    throw new ProtocolError(-32602, `${prefix} size rows and cols must be greater than 0`)
  return { rows, cols }
}

function validateEnv(value: unknown): void {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, 'env 必须是字符串或 null 的对象')
  for (const item of Object.values(value as Record<string, unknown>))
    if (item !== null && typeof item !== 'string')
      throw new ProtocolError(-32602, 'env 必须是字符串或 null 的对象')
}

function resolveCwd(kind: Kind, value: unknown): string {
  if (kind === 'process') {
    if (typeof value !== 'string') throw new ProtocolError(-32602, 'cwd 必须是字符串')
    if (!isAbsolute(value)) throw new ProtocolError(-32602, 'cwd 必须是绝对路径')
    return value
  }
  // command/exec 省略时为服务进程的 cwd，相对路径按它解析。
  if (value == null) return process.cwd()
  if (typeof value !== 'string') throw new ProtocolError(-32602, 'cwd 必须是字符串')
  return resolve(process.cwd(), value)
}

// 原生的 error_repr：客户端提供的标识按 JSON 字符串加引号，内部生成的 id 不加。
function duplicateMessage(kind: Kind, plan: { id: string; clientId: boolean }): string {
  return kind === 'process'
    ? `duplicate active process handle: ${JSON.stringify(plan.id)}`
    : `duplicate active command/exec process id: ${plan.clientId ? JSON.stringify(plan.id) : plan.id}`
}

function missingMessage(kind: Kind, id: string): string {
  return kind === 'process'
    ? `no active process for process handle ${JSON.stringify(id)}`
    : `no active command/exec for process id ${JSON.stringify(id)}`
}

function spawnFailureMessage(kind: Kind, detail: string): ProtocolError {
  return new ProtocolError(
    -32603,
    `failed to spawn ${kind === 'command' ? 'command' : 'process'}: ${detail}`,
  )
}

interface StreamCapture {
  pending: Buffer[]
  flush: NodeJS.Immediate | null
  buffered: Buffer[]
  bytes: number
  capReached: boolean
  done: boolean
}

interface ProcessRecord {
  kind: Kind
  // 客户端标识；command/exec 未提供 processId 时是内部生成、不对外暴露的编号。
  id: string
  key: string
  clientId: boolean
  peer: RpcPeer
  child: ChildProcess
  tty: boolean
  stdin: boolean
  stdinClosed: boolean
  streaming: boolean
  cap: number
  stdout: StreamCapture
  stderr: StreamCapture
  bridge: string
  bridgePid: number | null
  exit: { code: number | null; signal: NodeJS.Signals | null } | null
  spawned: boolean
  answered: boolean
  aborted: boolean
  terminated: boolean
  timedOut: boolean
  settled: boolean
  sink: ProcessSink | null
  // 流量控制：按住的时候不读它的输出（见 hold）。没有人调用 hold 就一直是 false
  held: boolean
  drainTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  finish: () => void
}

function capture(): StreamCapture {
  return { pending: [], flush: null, buffered: [], bytes: 0, capReached: false, done: false }
}

export class ProcessRpc {
  private readonly owned = new Map<string, Map<string, ProcessRecord>>()
  private readonly running = new Set<Promise<void>>()
  private generated = 0

  constructor(
    privateCommandPolicy: (
      command: string[],
      cwd: string,
      params: Record<string, unknown>,
    ) => string[],
  ) {
    this.commandPolicy = privateCommandPolicy
  }

  private readonly commandPolicy: (
    command: string[],
    cwd: string,
    params: Record<string, unknown>,
  ) => string[]

  async start(
    peer: RpcPeer,
    kind: Kind,
    params: Record<string, unknown>,
    sink: ProcessSink | null = null,
  ): Promise<unknown> {
    const plan = this.resolvePlan(kind, params)
    const records = this.owned.get(peer.id) ?? new Map<string, ProcessRecord>()
    if (records.has(plan.key)) throw new ProtocolError(-32600, duplicateMessage(kind, plan))
    const command =
      kind === 'command' ? this.commandPolicy(plan.command, plan.cwd, params) : plan.command
    // 带终端的由伪终端桥来起：命令行（Go）自带的 pty-bridge 子命令，三个平台都是它。
    // 协议见 cmd/codex-harness-adapter/pty_bridge_unix.go 开头。
    const argv = plan.tty
      ? [
          this.ptyBridge(kind),
          'pty-bridge',
          '--rows',
          String(plan.size.rows),
          '--cols',
          String(plan.size.cols),
          '--',
          ...command,
        ]
      : command
    debugLog(`${kind}.spawn.start`, {
      id: plan.id,
      cwd: plan.cwd,
      tty: plan.tty,
      command: argv,
    })
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: plan.cwd,
      env: plan.env,
      detached: !plan.tty && process.platform !== 'win32',
      stdio: plan.tty || plan.stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    })
    let resolveResult: (value: unknown) => void = () => {}
    let rejectResult: (error: unknown) => void = () => {}
    const answer = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise
      rejectResult = rejectPromise
    })
    const record: ProcessRecord = {
      kind,
      id: plan.id,
      key: plan.key,
      clientId: plan.clientId,
      peer,
      child,
      tty: plan.tty,
      stdin: plan.stdin,
      stdinClosed: false,
      streaming: plan.streaming,
      cap: plan.cap,
      stdout: capture(),
      stderr: capture(),
      bridge: '',
      bridgePid: null,
      exit: null,
      spawned: false,
      answered: false,
      aborted: false,
      terminated: false,
      timedOut: false,
      settled: false,
      sink,
      held: false,
      drainTimer: null,
      timeoutTimer: null,
      resolve: resolveResult,
      reject: rejectResult,
      finish: () => {},
    }
    const finished = new Promise<void>((resolveFinished) => {
      record.finish = () => {
        resolveFinished()
        this.running.delete(finished)
      }
    })
    this.running.add(finished)
    records.set(plan.key, record)
    this.owned.set(peer.id, records)

    child.once('error', (error) => {
      debugLog(`${kind}.spawn.error`, { id: plan.id, error: error.message })
      this.failSpawn(record, error.message)
    })
    child.once('spawn', () => {
      // tty 模式下先启动的是桥，等它回报 spawned 才算真正启动成功。
      if (plan.tty) return
      record.spawned = true
      if (kind === 'process') this.answerSpawn(record, {})
    })
    child.once('exit', (code, signal) => this.beginDrain(record, code, signal))
    child.once('close', (code, signal) => {
      record.exit ??= { code, signal }
      this.settleRecord(record)
    })
    // 对端退出后的 EPIPE 由下一次写入的状态检查报告。
    child.stdin?.on('error', () => {})
    if (plan.tty) {
      // 桥的 stderr 只写调试日志，不作为协议里的 stderr 输出。
      child.stderr?.on('data', (chunk: Buffer) =>
        debugLog(`${kind}.pty.stderr`, { id: plan.id, message: chunk.toString('utf8') }),
      )
      child.stdout?.on('data', (chunk: Buffer) => this.readBridgeLines(record, chunk))
    } else {
      child.stdout?.on('data', (chunk: Buffer) => this.queue(record, 'stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => this.queue(record, 'stderr', chunk))
    }
    if (plan.timeoutMs != null)
      record.timeoutTimer = setTimeout(() => {
        // 超时标记后立即终止进程组；最终退出码固定为 124。
        record.timedOut = true
        this.terminate(record)
      }, plan.timeoutMs)
    return answer
  }

  private resolvePlan(kind: Kind, params: Record<string, unknown>): SpawnPlan {
    const method = kind === 'command' ? 'command/exec' : 'process/spawn'
    const tty = booleanParam(params, 'tty')
    const stdin = tty || booleanParam(params, 'streamStdin')
    const streaming = tty || booleanParam(params, 'streamStdoutStderr')
    const disableOutputCap = kind === 'command' && booleanParam(params, 'disableOutputCap')
    const disableTimeout = kind === 'command' && booleanParam(params, 'disableTimeout')
    const command = stringArray(params.command)
    if (!command.length) throw new ProtocolError(-32600, 'command must not be empty')
    let id: string | null = null
    let clientId = true
    if (kind === 'process') {
      const handle = params.processHandle
      if (typeof handle !== 'string') throw new ProtocolError(-32602, 'processHandle 必须是字符串')
      if (!handle) throw new ProtocolError(-32600, 'processHandle must not be empty')
      id = handle
    } else if (params.processId != null) {
      if (typeof params.processId !== 'string')
        throw new ProtocolError(-32602, 'processId 必须是字符串')
      id = params.processId
    }
    if (params.size != null && !tty)
      throw new ProtocolError(-32602, `${method} size requires tty: true`)
    if (disableOutputCap && params.outputBytesCap != null)
      throw new ProtocolError(
        -32602,
        'command/exec cannot set both outputBytesCap and disableOutputCap',
      )
    if (disableTimeout && params.timeoutMs != null)
      throw new ProtocolError(-32602, 'command/exec cannot set both timeoutMs and disableTimeout')
    validateEnv(params.env)
    let timeoutMs: number | null = DEFAULT_TIMEOUT_MS
    if (kind === 'command') {
      if (disableTimeout) timeoutMs = null
      else if (params.timeoutMs != null) timeoutMs = timeoutParam(params.timeoutMs, method)
    } else if (params.timeoutMs === null) timeoutMs = null
    else if (params.timeoutMs != null) timeoutMs = timeoutParam(params.timeoutMs, method)
    let cap = DEFAULT_OUTPUT_BYTES_CAP
    if (disableOutputCap) cap = Number.POSITIVE_INFINITY
    else if (kind === 'process' && params.outputBytesCap === null) cap = Number.POSITIVE_INFINITY
    else if (params.outputBytesCap != null)
      cap = nonNegativeInteger(params.outputBytesCap, 'outputBytesCap')
    const size = params.size == null ? { ...DEFAULT_SIZE } : terminalSize(params.size, kind)
    const cwd = resolveCwd(kind, params.cwd)
    if (kind === 'command' && id == null && (tty || stdin || streaming))
      throw new ProtocolError(
        -32600,
        'command/exec tty or streaming requires a client-supplied processId',
      )
    if (id == null) {
      clientId = false
      id = String(++this.generated)
    }
    return {
      id,
      key: kind === 'command' ? `command:${clientId ? id : `#${id}`}` : `process:${id}`,
      clientId,
      command,
      cwd,
      env: commandEnv(params.env),
      tty,
      stdin,
      streaming,
      size,
      cap,
      timeoutMs,
    }
  }

  private ptyBridge(kind: Kind): string {
    const cli = adapterCliPath()
    if (!cli) throw spawnFailureMessage(kind, 'PTY 桥缺失，请先运行 npm run build')
    return cli
  }

  async followup(
    peer: RpcPeer,
    kind: Kind,
    action: 'write' | 'resize' | 'kill',
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const method = kind === 'command' ? 'command/exec/write' : 'process/writeStdin'
    const field = kind === 'command' ? 'processId' : 'processHandle'
    const id = params[field]
    if (typeof id !== 'string') throw new ProtocolError(-32602, `${field} 必须是字符串`)
    if (action === 'write') return this.writeStdin(peer, kind, method, id, params)
    if (action === 'resize') {
      const size = terminalSize(params.size, kind)
      const record = this.record(peer, kind, id)
      if (!record) throw new ProtocolError(-32600, missingMessage(kind, id))
      if (!record.tty)
        throw new ProtocolError(-32600, 'failed to resize PTY: process is not attached to a PTY')
      this.writeLine(record, { action: 'resize', rows: size.rows, cols: size.cols })
      return {}
    }
    const record = this.record(peer, kind, id)
    if (!record) throw new ProtocolError(-32600, missingMessage(kind, id))
    this.terminate(record)
    return {}
  }

  private async writeStdin(
    peer: RpcPeer,
    kind: Kind,
    method: string,
    id: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const closeStdin = booleanParam(params, 'closeStdin')
    if (params.deltaBase64 == null && !closeStdin)
      throw new ProtocolError(-32602, `${method} requires deltaBase64 or closeStdin`)
    const data = params.deltaBase64 == null ? Buffer.alloc(0) : decodeBase64(params.deltaBase64)
    const record = this.record(peer, kind, id)
    if (!record) throw new ProtocolError(-32600, missingMessage(kind, id))
    if (!record.stdin)
      throw new ProtocolError(
        -32600,
        kind === 'command'
          ? 'stdin streaming is not enabled for this command/exec'
          : 'stdin streaming is not enabled for this process',
      )
    if (data.length) {
      if (record.stdinClosed) throw new ProtocolError(-32600, 'stdin is already closed')
      if (record.tty) this.writeLine(record, { action: 'input', data: data.toString('base64') })
      else await this.writePipe(record, data)
    }
    if (closeStdin) {
      record.stdinClosed = true
      if (record.tty) this.writeLine(record, { action: 'eof' })
      else record.child.stdin?.end()
    }
    return {}
  }

  // 收到的数据先排队，在下一个事件循环统一成一片发出（允许超出一个读取块）。
  private queue(record: ProcessRecord, stream: Stream, chunk: Buffer): void {
    const state = record[stream]
    if (state.done) return
    state.pending.push(chunk)
    state.flush ??= setImmediate(() => this.flushStream(record, stream))
  }

  private flushStream(record: ProcessRecord, stream: Stream): void {
    const state = record[stream]
    state.flush = null
    if (state.done || !state.pending.length) return
    const merged = Buffer.concat(state.pending)
    state.pending = []
    const allowed = Number.isFinite(record.cap)
      ? Math.max(0, Math.min(merged.length, record.cap - state.bytes))
      : merged.length
    const chunk = merged.subarray(0, allowed)
    state.bytes += chunk.length
    state.capReached = Number.isFinite(record.cap) && state.bytes === record.cap
    if (record.streaming) this.sendDelta(record, stream, chunk, state.capReached)
    else state.buffered.push(chunk)
    if (state.capReached) {
      // 触达上限后该流不再读取、也不再发送。
      state.done = true
      state.pending = []
      const readable = stream === 'stdout' ? record.child.stdout : record.child.stderr
      readable?.pause()
    }
  }

  private flushStreams(record: ProcessRecord): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const state = record[stream]
      if (state.flush) {
        clearImmediate(state.flush)
        state.flush = null
      }
      if (!state.done && state.pending.length) this.flushStream(record, stream)
    }
  }

  private sendDelta(
    record: ProcessRecord,
    stream: Stream,
    chunk: Buffer,
    capReached: boolean,
  ): void {
    // 内部生成的 command/exec id 不对外暴露，与原生一样不发通知。
    if (!record.clientId) return
    if (record.sink) {
      record.sink.output(stream, chunk, capReached)
      return
    }
    record.peer.send({
      method: record.kind === 'command' ? 'command/exec/outputDelta' : 'process/outputDelta',
      params: {
        [record.kind === 'command' ? 'processId' : 'processHandle']: record.id,
        stream,
        deltaBase64: chunk.toString('base64'),
        capReached,
      },
    })
  }

  private readBridgeLines(record: ProcessRecord, chunk: Buffer): void {
    record.bridge += chunk.toString('utf8')
    const lines = record.bridge.split('\n')
    record.bridge = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch (error) {
        debugLog('process.pty.line', {
          id: record.id,
          line,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      this.handleBridgeMessage(record, message)
    }
  }

  private handleBridgeMessage(record: ProcessRecord, message: Record<string, unknown>): void {
    if (message.event === 'spawned' && typeof message.pid === 'number') {
      // 桥的子进程 setsid 后自成进程组，握手拿到的 pid 就是进程组号。
      record.bridgePid = message.pid
      record.spawned = true
      if (record.kind === 'process') this.answerSpawn(record, {})
      return
    }
    if (message.event === 'spawnError') {
      this.failSpawn(
        record,
        typeof message.message === 'string' ? message.message : 'PTY 桥启动失败',
      )
      return
    }
    if (message.stream === 'stdout' && typeof message.delta === 'string')
      this.queue(record, 'stdout', Buffer.from(message.delta, 'base64'))
    else debugLog('process.pty.line', { id: record.id, message })
  }
  private answerSpawn(record: ProcessRecord, value: unknown): void {
    if (record.answered) return
    record.answered = true
    record.resolve(value)
  }

  private failSpawn(record: ProcessRecord, detail: string): void {
    if (record.aborted || record.settled) return
    record.aborted = true
    if (record.child.pid) record.child.kill('SIGKILL')
    this.abandon(record)
    debugLog(`${record.kind}.spawn.failed`, { id: record.id, detail })
    record.reject(spawnFailureMessage(record.kind, detail))
  }

  // 子进程退出后最多再等 2 秒排空输出，以 stdio 关闭（close）为准。
  private beginDrain(
    record: ProcessRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    record.exit ??= { code, signal }
    // 输出被按住没读的时候不计排空时间：管道里剩下的要等放开之后才读得到，放开时再开始计
    if (record.settled || record.drainTimer || record.held) return
    record.drainTimer = setTimeout(() => this.settleRecord(record), IO_DRAIN_TIMEOUT_MS)
  }

  /**
   * 流量控制：按住（不读）或者放开这个进程的输出。按住之后管道写满，进程自己就会停在写上。
   * 进程不在了就什么也不做。只有设备进程在连接的发送积压过线时调用，引擎的兼容面不调用。
   */
  hold(peerId: string, kind: Kind, id: string, held: boolean): void {
    const record = this.owned.get(peerId)?.get(`${kind}:${id}`)
    // 已经在收尾的不再按住：按住了就等不到它的输出结束
    if (!record || record.held === held || (held && record.terminated)) return
    this.setHeld(record, held)
  }

  private setHeld(record: ProcessRecord, held: boolean): void {
    record.held = held
    // 伪终端模式下标准错误是桥的调试输出，量很小，不用管
    for (const stream of record.tty ? (['stdout'] as const) : (['stdout', 'stderr'] as const)) {
      const readable = stream === 'stdout' ? record.child.stdout : record.child.stderr
      if (held) readable?.pause()
      // 触达输出上限的那一路本来就不再读，放开时不能把它重新读起来
      else if (!record[stream].done) readable?.resume()
    }
    if (record.settled || !record.exit) return
    // 进程已经退出、正在等输出排空：按住期间不计时，放开之后重新计
    if (held) {
      if (record.drainTimer) clearTimeout(record.drainTimer)
      record.drainTimer = null
    } else if (!record.drainTimer)
      record.drainTimer = setTimeout(() => this.settleRecord(record), IO_DRAIN_TIMEOUT_MS)
  }

  /** 这条连接名下现在有没有这个标识的进程 */
  has(peerId: string, kind: Kind, id: string): boolean {
    return this.owned.get(peerId)?.has(`${kind}:${id}`) ?? false
  }

  private settleRecord(record: ProcessRecord): void {
    if (record.settled || record.aborted) return
    this.abandon(record)
    if (!record.spawned) {
      // 没等到启动成功就退出了（例如桥没有完成握手），按启动失败处理。
      const exit = record.exit
      record.reject(
        spawnFailureMessage(
          record.kind,
          `进程在启动阶段退出（exit ${exit?.code ?? exit?.signal ?? 'unknown'}）`,
        ),
      )
      return
    }
    this.flushStreams(record)
    // 退出后再对进程组发一次 SIGKILL，回收残留的孙进程。
    this.killGroup(record)
    const exitCode = this.exitCode(record)
    const stdout = record.streaming ? '' : Buffer.concat(record.stdout.buffered).toString('utf8')
    const stderr = record.streaming ? '' : Buffer.concat(record.stderr.buffered).toString('utf8')
    debugLog(`${record.kind}.exit`, { id: record.id, exitCode, stdout, stderr })
    if (record.kind === 'process' && record.sink)
      record.sink.exited({
        exitCode,
        stdout,
        stderr,
        stdoutCapReached: record.stdout.capReached,
        stderrCapReached: record.stderr.capReached,
      })
    else if (record.kind === 'process')
      record.peer.send({
        method: 'process/exited',
        params: {
          processHandle: record.id,
          exitCode,
          stdout,
          stderr,
          stdoutCapReached: record.stdout.capReached,
          stderrCapReached: record.stderr.capReached,
        },
      })
    else {
      record.answered = true
      record.resolve({ exitCode, stdout, stderr })
    }
  }

  private abandon(record: ProcessRecord): void {
    if (record.settled) return
    record.settled = true
    if (record.drainTimer) clearTimeout(record.drainTimer)
    if (record.timeoutTimer) clearTimeout(record.timeoutTimer)
    record.drainTimer = null
    record.timeoutTimer = null
    this.forget(record)
    record.finish()
  }

  private exitCode(record: ProcessRecord): number {
    if (record.timedOut) return EXEC_TIMEOUT_EXIT_CODE
    const code = record.exit?.code ?? null
    if (code != null) return code
    const signal = record.exit?.signal ?? null
    // tty 模式下退出码来自桥；被信号终止时桥返回 1，与 portable-pty 一致。
    if (record.tty || !signal) return 1
    return 128 + (osConstants.signals[signal] ?? 0)
  }

  // 终止（kill、terminate、断开连接、超时）立即对进程组发 SIGKILL，不先 SIGTERM。
  private terminate(record: ProcessRecord): void {
    if (record.terminated) return
    record.terminated = true
    // 按住的要先放开：不读的话桥和管道都结束不了，这条记录就一直收不了尾
    if (record.held) this.setHeld(record, false)
    this.killGroup(record)
  }

  private killGroup(record: ProcessRecord): void {
    if (record.tty) this.writeLine(record, { action: 'kill' })
    const pid = record.tty ? record.bridgePid : (record.child.pid ?? null)
    if (pid == null) return
    try {
      if (process.platform === 'win32') {
        if (!record.tty) {
          const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
          })
          killer.on('error', (error) => debugLog('process.kill.error', { error: error.message }))
        }
      } else process.kill(-pid, 'SIGKILL')
    } catch (error) {
      // 与原生一致：进程组已经消失（ESRCH）等失败不影响收尾。
      debugLog('process.kill.error', {
        id: record.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private writeLine(record: ProcessRecord, message: Record<string, unknown>): void {
    const stdin = record.child.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) return
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private writePipe(record: ProcessRecord, data: Buffer): Promise<void> {
    return new Promise<void>((resolveWrite, rejectWrite) => {
      const stdin = record.child.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded) {
        rejectWrite(new ProtocolError(-32600, 'stdin is already closed'))
        return
      }
      stdin.write(data, (error) =>
        error ? rejectWrite(new ProtocolError(-32600, 'stdin is already closed')) : resolveWrite(),
      )
    })
  }

  private record(peer: RpcPeer, kind: Kind, id: string): ProcessRecord | null {
    return this.owned.get(peer.id)?.get(`${kind}:${id}`) ?? null
  }

  private forget(record: ProcessRecord): void {
    const records = this.owned.get(record.peer.id)
    if (!records) return
    records.delete(record.key)
    if (!records.size) this.owned.delete(record.peer.id)
  }

  closePeer(peerId: string): void {
    for (const record of this.owned.get(peerId)?.values() ?? []) this.terminate(record)
  }

  async close(): Promise<void> {
    for (const peerId of [...this.owned.keys()]) this.closePeer(peerId)
    await Promise.all([...this.running])
  }

  get activeCount(): number {
    return [...this.owned.values()].reduce((sum, records) => sum + records.size, 0)
  }
}
