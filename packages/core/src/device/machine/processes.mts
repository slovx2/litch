// exec 起的进程和 process 工具。
// 进程属于发起它的会话所在的设备：回合结束不结束（构建、测试常常跨回合），那台设备断开 10 分钟、开关关掉、
// 用户在顶栏点了结束时才结束。输出两路合在一起、按到达先后留最近 1 MiB，序号是“到这里一共输出了多少字节”。
// 和 codex 执行服务的做法一样：调用方拿到进程号、输出带序号、长的命令先回一部分再续读。
import {
  MACHINE_LIMITS,
  type ProcessArguments,
} from '../../../../protocol/src/client-tools-machine.mjs'
import type { AbortSignalLike, Clock } from '../../channel/protocol.mjs'
import { encodeUtf8 } from '../../text/bytes.mjs'
import {
  ArgumentError,
  approved,
  askView,
  asObject,
  done,
  errorText,
  failed,
  lookPath,
  type Outcome,
  optionalInt,
  optionalString,
  stringArg,
  type ToolKit,
  targetOf,
} from './common.mjs'
import { clipMiddle, OutputLog, utf8Stream } from './output.mjs'
import { flaggedIn } from './paths.mjs'
import type { RunExit, Runner, Running } from './runner.mjs'
import { execCommand, PID_MARK, runScript, scriptCommand } from './scripts.mjs'
import type { MachineOwner, MachineProcessRecord, MachineTarget } from './types.mjs'

/** 每个进程留多少输出 */
export const RETAIN_BYTES = 1024 * 1024
/** 结束了的进程再留多久、最多留几个（模型还要读它最后的输出） */
const FINISHED_KEEP_MS = 30 * 60_000
const FINISHED_MAX = 16
/** 会话所在的设备断开多久之后结束它的进程 */
export const OWNER_AWAY_MS = 10 * 60_000
/** 对面到点结束进程之后，再等这么久收它的退出 */
const EXIT_SLACK_MS = 2000

interface Exit {
  code: number
  kind: 'exited' | 'timeout' | 'killed' | 'lost'
  at: number
}

interface Proc {
  record: MachineProcessRecord
  target: MachineTarget
  running: Running
  log: OutputLog
  timeoutMs: number
  /** 进程组号，外壳报上来的。没报（或者还没到）是 null */
  pid: number | null
  exit: Exit | null
  /** 已经交给模型的位置（process read 不给 after_seq 时从这里接着读） */
  delivered: number
  stdinOpen: boolean
  wake: Set<() => void>
}

export class ProcessTable {
  private readonly clock: Clock
  private readonly runner: Runner
  private readonly debug: (line: string) => void
  private readonly live = new Map<string, Proc>()
  private readonly ended = new Map<string, Proc>()
  private readonly listeners = new Set<() => void>()
  private readonly away = new Map<string, () => void>()
  private seq = 0

  constructor(clock: Clock, runner: Runner, debug: (line: string) => void) {
    this.clock = clock
    this.runner = runner
    this.debug = debug
  }

  records(): MachineProcessRecord[] {
    return [...this.live.values()].map((proc) => ({ ...proc.record }))
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.debug(`machine.listener.error ${errorText(error)}`)
      }
    }
  }

  // —— 起进程 ——

  async start(
    target: MachineTarget,
    owner: MachineOwner,
    shell: string,
    command: string,
    cwd: string,
    timeoutMs: number,
    keepStdin: boolean,
  ): Promise<Proc> {
    const id = `p${++this.seq}`
    const log = new OutputLog(RETAIN_BYTES)
    const out = utf8Stream()
    const err = utf8Stream()
    // 标准错误开头那一行是外壳报的进程号，摘掉
    let head: Uint8Array | null = new Uint8Array(0)
    const holder: { proc: Proc | null; pid: number | null } = { proc: null, pid: null }
    const onOutput = (stream: 'stdout' | 'stderr', bytes: Uint8Array) => {
      let chunk = bytes
      if (stream === 'stderr' && head) {
        const merged = new Uint8Array(head.length + chunk.length)
        merged.set(head)
        merged.set(chunk, head.length)
        const newline = merged.indexOf(10)
        if (newline < 0 && merged.length < 64) {
          head = merged
          return
        }
        head = null
        const first = String.fromCharCode(...merged.subarray(0, newline < 0 ? 0 : newline))
        if (newline >= 0 && first.startsWith(PID_MARK)) {
          const pid = Number.parseInt(first.slice(PID_MARK.length), 10)
          if (Number.isInteger(pid) && pid > 1) {
            holder.pid = pid
            if (holder.proc) holder.proc.pid = pid
          }
          chunk = merged.subarray(newline + 1)
        } else chunk = merged
      }
      const text = (stream === 'stdout' ? out : err).push(chunk)
      if (!text) return
      log.push(text)
      for (const wake of holder.proc?.wake ?? []) wake()
    }
    const running = await this.runner.run(target, execCommand(shell, command), {
      cwd,
      stdin: keepStdin,
      timeoutMs,
      onOutput,
    })
    const proc: Proc = {
      record: {
        id,
        owner: { ...owner },
        targetId: target.id,
        command,
        cwd,
        startedAt: this.clock.now(),
      },
      target,
      running,
      log,
      timeoutMs,
      pid: holder.pid,
      exit: null,
      delivered: 0,
      stdinOpen: keepStdin,
      wake: new Set(),
    }
    holder.proc = proc
    this.live.set(id, proc)
    this.changed()
    running.done.then((exit) => {
      const rest = out.end() + err.end()
      if (rest) log.push(rest)
      this.finish(proc, exitOf(exit, proc, this.clock.now()))
    })
    return proc
  }

  private finish(proc: Proc, exit: Exit): void {
    if (proc.exit) return
    proc.exit = exit
    proc.stdinOpen = false
    const id = proc.record.id
    this.live.delete(id)
    this.ended.set(id, proc)
    this.prune()
    for (const wake of [...proc.wake]) wake()
    this.changed()
  }

  private prune(): void {
    const now = this.clock.now()
    for (const [id, proc] of this.ended) {
      if (this.ended.size > FINISHED_MAX || now - (proc.exit?.at ?? now) > FINISHED_KEEP_MS)
        this.ended.delete(id)
    }
  }

  /** 等到有新输出（或者退出）、到点、被中止。untilExit 时只等退出 */
  wait(proc: Proc, ms: number, signal: AbortSignalLike, untilExit: boolean): Promise<void> {
    if (proc.exit || ms <= 0 || signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let over = false
      const stop = this.clock.setTimer(() => end(), ms)
      const end = () => {
        if (over) return
        over = true
        stop()
        proc.wake.delete(wake)
        resolve()
      }
      const wake = () => {
        if (!untilExit || proc.exit) end()
      }
      proc.wake.add(wake)
      signal.addEventListener('abort', end, { once: true })
    })
  }

  find(id: string, deviceId: string): Proc | null {
    const proc = this.live.get(id) ?? this.ended.get(id) ?? null
    // 别的设备起的进程，当作不认识
    return proc && proc.record.owner.deviceId === deviceId ? proc : null
  }

  kill(id: string): boolean {
    const proc = this.live.get(id)
    if (!proc) return false
    proc.running.kill()
    this.finish(proc, { code: 137, kind: 'killed', at: this.clock.now() })
    return true
  }

  stopAll(deviceId?: string): void {
    for (const proc of [...this.live.values()]) {
      if (deviceId === undefined || proc.record.owner.deviceId === deviceId)
        this.kill(proc.record.id)
    }
  }

  ownerPresence(deviceId: string, online: boolean): void {
    this.away.get(deviceId)?.()
    this.away.delete(deviceId)
    if (online) return
    this.away.set(
      deviceId,
      this.clock.setTimer(() => {
        this.away.delete(deviceId)
        this.debug(`machine.owner.away ${deviceId}`)
        this.stopAll(deviceId)
      }, OWNER_AWAY_MS),
    )
  }

  dispose(): void {
    for (const stop of this.away.values()) stop()
    this.away.clear()
    this.stopAll()
    this.ended.clear()
    this.listeners.clear()
  }

  // —— 回给模型的样子 ——

  /** 从 after 开始的输出，并把交到的位置记下 */
  take(proc: Proc, after: number): { text: string; seq: number; dropped: number } {
    const part = proc.log.after(after)
    proc.delivered = Math.max(proc.delivered, part.seq)
    return { text: part.text, seq: part.seq, dropped: part.dropped }
  }

  async signal(proc: Proc, signal: string): Promise<void> {
    if (proc.pid == null)
      throw new ArgumentError(
        'Litch does not know the process group of this process; use action kill instead.',
      )
    await runScript(this.runner, proc.target, scriptCommand.signal(signal, proc.pid), {
      collect: 1024,
    })
  }
}

function exitOf(exit: RunExit, proc: Proc, now: number): Exit {
  if (exit.kind === 'lost') return { code: 1, kind: 'lost', at: now }
  if (exit.kind === 'killed') return { code: 137, kind: 'killed', at: now }
  // 对面到点结束进程时给 124
  const timedOut = exit.exitCode === 124 && now - proc.record.startedAt >= proc.timeoutMs - 50
  return { code: exit.exitCode, kind: timedOut ? 'timeout' : 'exited', at: now }
}

function exitLine(proc: Proc): string {
  const exit = proc.exit
  if (!exit) return 'status: running'
  if (exit.kind === 'timeout')
    return `status: timed out after ${proc.timeoutMs} ms and was killed (exit code ${exit.code})`
  if (exit.kind === 'killed') return 'status: killed'
  if (exit.kind === 'lost')
    return 'status: unknown: Litch lost the connection to the machine, so the process is gone'
  return `status: exited\nexit_code: ${exit.code}`
}

function outputBlock(label: string, part: { text: string; dropped: number }): string {
  const clipped = clipMiddle(part.text, MACHINE_LIMITS.outputBytes)
  const lost =
    part.dropped > 0 ? `[${part.dropped} bytes of earlier output are no longer kept]\n` : ''
  return `${label}:\n${lost}${clipped.text}`
}

// —— 两个工具 ——

const SHELL_FALLBACK = '/bin/sh'

export async function execTool(kit: ToolKit, table: ProcessTable, raw: unknown): Promise<Outcome> {
  let summary = ''
  let flagged: string[] = []
  try {
    const args = asObject(raw)
    const command = stringArg(args, 'command')
    summary = command
    const timeoutMs =
      optionalInt(args, 'timeout_ms', 1000, MACHINE_LIMITS.execTimeoutMaxMs) ??
      MACHINE_LIMITS.execTimeoutDefaultMs
    const yieldMs = optionalInt(args, 'yield_ms', 0, MACHINE_LIMITS.yieldMaxMs)
    const stdin = optionalString(args, 'stdin')
    const target = targetOf(kit.context, args.machine)
    const facts = await target.facts()
    const cwdRaw = optionalString(args, 'cwd') ?? facts.home
    const looked = await lookPath(kit, target, facts, cwdRaw, 'cwd')
    if (looked.probe.type !== 'd')
      return failed('invalid', `cwd ${looked.path} is not an existing folder`, summary)
    flagged = flaggedIn(command, looked.path, facts.home, looked.rules, looked.icase)
    if (looked.blocked && !flagged.includes(looked.blocked.rule)) flagged.push(looked.blocked.rule)
    const refused = await approved(
      kit,
      { class: 'mutate', ask: askView({ action: 'exec', command, cwd: looked.path, flagged }) },
      summary,
    )
    if (refused) return refused
    // 给了 stdin 就写完关掉；没给但要先回（yield_ms）的留着，好用 process write；别的起来就关，免得等输入的命令一直卡着
    const keepStdin = stdin !== undefined || yieldMs !== undefined
    const proc = await table.start(
      target,
      kit.context.owner,
      facts.shell || SHELL_FALLBACK,
      command,
      looked.path,
      timeoutMs,
      keepStdin,
    )
    if (stdin !== undefined) {
      proc.stdinOpen = false
      await proc.running.write(encodeUtf8(stdin), true).catch(() => {
        // 进程已经结束了：结果里会说
      })
    }
    // 不给 yield_ms 就等到超时（多等一点收它的退出）；但一次调用最多等 yieldMaxMs
    const waitMs = Math.min(yieldMs ?? timeoutMs + EXIT_SLACK_MS, MACHINE_LIMITS.yieldMaxMs)
    await table.wait(proc, waitMs, kit.context.signal, true)
    if (kit.context.signal.aborted && !proc.exit) {
      table.kill(proc.record.id)
      return failed(
        'failed',
        'The call was cancelled; the command was killed.',
        summary,
        flagged.length > 0,
      )
    }
    const part = table.take(proc, 0)
    const elapsed = kit.clock.now() - proc.record.startedAt
    if (proc.exit) {
      return done(
        `${exitLine(proc)}\nduration_ms: ${elapsed}\nseq: ${part.seq}\n${outputBlock('output', part)}`,
        summary,
        flagged.length > 0,
      )
    }
    return done(
      `process_id: ${proc.record.id}\nstatus: still running after ${elapsed} ms. Use process with action read to get more output (it continues from seq ${part.seq}), or kill it. It is killed after timeout_ms (${timeoutMs} ms).\nseq: ${part.seq}\n${outputBlock('output so far', part)}`,
      summary,
      flagged.length > 0,
    )
  } catch (error) {
    if (error instanceof ArgumentError) return failed('invalid', error.message, summary)
    return failed(
      'failed',
      `Could not run the command: ${errorText(error)}`,
      summary,
      flagged.length > 0,
    )
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'] as const

export async function processTool(
  kit: ToolKit,
  table: ProcessTable,
  raw: unknown,
): Promise<Outcome> {
  let summary = ''
  try {
    const args = asObject(raw)
    const id = stringArg(args, 'process_id')
    const action = stringArg(args, 'action') as ProcessArguments['action']
    summary = `${action} ${id}`
    if (!['read', 'write', 'signal', 'kill'].includes(action))
      throw new ArgumentError('action must be read, write, signal or kill')
    const proc = table.find(id, kit.context.owner.deviceId)
    if (!proc)
      return failed(
        'invalid',
        `No process ${id} from this device. It may have ended a while ago, or Litch was restarted.`,
        summary,
      )
    summary = `${action} ${id}: ${proc.record.command}`
    if (action === 'read') {
      const waitMs = optionalInt(args, 'wait_ms', 0, MACHINE_LIMITS.waitMaxMs) ?? 0
      const after = optionalInt(args, 'after_seq', 0, Number.MAX_SAFE_INTEGER) ?? proc.delivered
      if (proc.log.totalBytes <= after) await table.wait(proc, waitMs, kit.context.signal, false)
      const part = table.take(proc, after)
      return done(
        `process_id: ${id}\n${exitLine(proc)}\nseq: ${part.seq}\n${outputBlock('output', part)}`,
        summary,
      )
    }
    if (action === 'kill') {
      if (!proc.exit) table.kill(id)
      return done(`process_id: ${id}\n${exitLine(proc)}`, summary)
    }
    if (proc.exit)
      return failed('invalid', `Process ${id} has already ended (${exitLine(proc)}).`, summary)
    if (action === 'signal') {
      const signal = optionalString(args, 'signal') ?? 'SIGINT'
      if (!(SIGNALS as readonly string[]).includes(signal))
        throw new ArgumentError(`signal must be one of ${SIGNALS.join(', ')}`)
      if (signal === 'SIGKILL') table.kill(id)
      else await table.signal(proc, signal)
      return done(`Sent ${signal} to process ${id}.`, summary)
    }
    const input = optionalString(args, 'input')
    if (input === undefined) throw new ArgumentError('input is required for write')
    if (!proc.stdinOpen)
      return failed(
        'invalid',
        'The stdin of this process is closed. Only commands started with yield_ms and without stdin keep stdin open.',
        summary,
      )
    const refused = await approved(
      kit,
      {
        class: 'mutate',
        ask: askView({ action: 'process', command: proc.record.command, cwd: proc.record.cwd }),
      },
      summary,
    )
    if (refused) return refused
    await proc.running.write(encodeUtf8(input))
    return done(`Wrote ${encodeUtf8(input).length} bytes to the stdin of process ${id}.`, summary)
  } catch (error) {
    if (error instanceof ArgumentError) return failed('invalid', error.message, summary)
    return failed('failed', errorText(error), summary)
  }
}
