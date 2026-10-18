// 定时任务的一次运行怎么驱动引擎：开一条内部连接（task-link.mts）到目标 harness，
// 新建会话（或者恢复已有的会话、等它空下来），发一个回合，等 turn/completed，取最后一条回答的开头。
// 这里只管和引擎打交道；运行记录怎么存、什么时候开始、跑完任务怎么变，在 tasks.mts。
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { TASKS_TOOLS } from '../../protocol/src/client-tools-tasks.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  type DeviceTaskRun,
  TASK_RUN_SUMMARY_MAX,
  type TaskError,
  type TaskRunErrorCode,
} from '../../protocol/src/device-tasks.mjs'
import { dialectFor } from './native-codex.mjs'
import type { HarnessSource } from './session.mjs'
import { type EngineLink, openEngineLink } from './task-link.mjs'
import type { TaskRow } from './task-store.mjs'
import { type Frame, isObject, UpstreamRpcError } from './wire.mjs'

export interface TaskTiming {
  /** 一个回合最长跑多久，到点打断（毫秒） */
  turnTimeoutMs: number
  /** thread 目标的会话正忙时最多等它多久（毫秒） */
  threadWaitMs: number
  /** 建会话、恢复会话、发回合这些请求等应答的时限（毫秒） */
  requestTimeoutMs: number
  handshakeTimeoutMs: number
  /** 打断之后再等回合结束多久（毫秒） */
  interruptGraceMs: number
  /** harness 正在起、暂时连不上时最多等多久（毫秒） */
  harnessWaitMs: number
}

export const DEFAULT_TASK_TIMING: TaskTiming = {
  turnTimeoutMs: 2 * 60 * 60 * 1000,
  // 规则里的 TASK_THREAD_WAIT
  threadWaitMs: 30 * 60 * 1000,
  // Pi 恢复会话要读原生会话文件，给得宽一些
  requestTimeoutMs: 60_000,
  handshakeTimeoutMs: 10_000,
  interruptGraceMs: 30_000,
  harnessWaitMs: 60_000,
}

/** 一次运行跑完的结果 */
export interface RunOutcome {
  status: 'succeeded' | 'failed'
  summary: string | null
  error: TaskError | null
}

export class RunFailure extends Error {
  readonly code: TaskRunErrorCode

  constructor(code: TaskRunErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface RunHost {
  /** 现在的时间（毫秒） */
  now(): number
  version: string
  timing: TaskTiming
  log(line: string): void
  /** 运行的进展：会话建好了、回合开始了。传进来的是改好的整份运行 */
  progress(run: DeviceTaskRun): void
  /** 新建出来的会话：登记进索引、归进工作区 */
  born(harness: string, thread: Record<string, unknown>, workspaceId: string | null): void
  /** litch_tasks 的一次调用（来自这条内部连接） */
  toolCall(harness: string, frame: Frame, reply: (result: unknown) => void): void
  /** 开着的内部连接登记一下，设备进程退出时一起关掉。返回的函数在连接用完时调用 */
  hold(link: EngineLink): () => void
}

/** 给模型看的时间：任务时区里的 YYYY-MM-DD HH:MM */
export function wallClock(seconds: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(seconds * 1000))
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/** 新建的会话叫什么 */
export const threadName = (task: TaskRow, scheduledFor: number): string =>
  `${task.name} · ${wallClock(scheduledFor, task.timezone)}`

/** 发给模型的提示词：一段英文说明，后面是用户写的原文 */
export function taskPrompt(task: TaskRow, run: DeviceTaskRun, nowSeconds: number): string {
  const lines = [
    '[Scheduled task run]',
    'This message was sent automatically by a scheduled task on this device, not typed by a person just now.',
    `Task: ${task.name}`,
    `Trigger: ${run.trigger === 'manual' ? 'run now (started by hand)' : 'schedule'}`,
    `Scheduled for: ${wallClock(run.scheduledFor, task.timezone)} (${task.timezone})`,
    `Current time: ${wallClock(nowSeconds, task.timezone)} (${task.timezone})`,
  ]
  if (run.coalesced > 0)
    lines.push(
      `Missed runs merged into this one: ${run.coalesced} (the device was off, asleep, or the previous run was still going).`,
    )
  lines.push(
    'No one is watching this run. Work on your own and finish as much as you can without waiting for answers; if something needs a person, say clearly what is left.',
    'The task instructions follow.',
    '---',
    task.prompt,
  )
  return lines.join('\n')
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 这个 harness 现在能不能用。不能用抛 harnessUnavailable */
export function usableSource(sources: HarnessSource[], harness: string): HarnessSource {
  const source = sources.find((item) => item.id === harness)
  if (!source)
    throw new RunFailure('harnessUnavailable', `${harness} is not configured on this device`)
  if (source.managed && source.managed.state !== 'running')
    throw new RunFailure(
      'harnessUnavailable',
      `${harness} is not running (${source.managed.state})`,
    )
  return source
}

/**
 * 连上这个 harness。它正在起（适配器主进程刚把它拉起来，比如服务刚重启、错过的运行正要补跑）
 * 或者暂时连不上时，最多等 harnessWaitMs；停用了、没装、起不来的当场算 harnessUnavailable
 */
export async function reachEngine(
  sources: () => HarnessSource[],
  harness: string,
  host: Pick<RunHost, 'version' | 'timing' | 'toolCall' | 'now'>,
  notification: (method: string, params: Record<string, unknown>) => void,
  lost: () => void,
): Promise<EngineLink> {
  const deadline = host.now() + host.timing.harnessWaitMs
  for (;;) {
    const source = sources().find((item) => item.id === harness)
    const starting = source?.managed?.state === 'starting'
    if (!starting) {
      const usable = usableSource(sources(), harness)
      try {
        return await connectEngine(usable, host, notification, lost)
      } catch (error) {
        if (host.now() >= deadline) throw error
      }
    } else if (host.now() >= deadline) usableSource(sources(), harness)
    await new Promise((resolve) => setTimeout(resolve, 1000).unref())
  }
}

/** 开一条内部连接。连不上、握手失败都算 harnessUnavailable */
export async function connectEngine(
  source: HarnessSource,
  host: Pick<RunHost, 'version' | 'timing' | 'toolCall'>,
  notification: (method: string, params: Record<string, unknown>) => void,
  lost: () => void,
): Promise<EngineLink> {
  try {
    return await openEngineLink({
      connect: source.connect,
      dialect: dialectFor(source.managed ? source.managed.native : source.native),
      version: host.version,
      handshakeTimeoutMs: host.timing.handshakeTimeoutMs,
      handlers: {
        notification,
        toolCall: (frame, reply) => host.toolCall(source.id, frame, reply),
        lost,
      },
    })
  } catch (error) {
    throw new RunFailure(
      'harnessUnavailable',
      `could not connect to ${source.id}: ${message(error)}`,
    )
  }
}

/** 引擎说的“没有这个会话” */
function threadMissing(error: unknown): boolean {
  return error instanceof UpstreamRpcError
}

/** 一个回合在跑，等它的结果。条目和结束的通知都可能比 turn/start 的应答先到，先攒着 */
class TurnWatch {
  readonly threadId: string
  turnId: string | null = null
  /** 回合里最后一条完整的回答 */
  lastAnswer: string | null = null
  private readonly answers = new Map<string, string>()
  private readonly ended = new Map<string, Record<string, unknown>>()
  private waiter: ((turn: Record<string, unknown> | null) => void) | null = null
  /** 会话从忙变闲（thread 目标等它空下来时用） */
  idle: (() => void) | null = null

  constructor(threadId: string) {
    this.threadId = threadId
  }

  notification(method: string, params: Record<string, unknown>): void {
    if (params.threadId !== this.threadId) return
    if (method === 'item/completed') {
      const item = isObject(params.item) ? params.item : null
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim())
        this.answers.set(String(params.turnId ?? ''), item.text)
    } else if (method === 'turn/completed') {
      const turn = isObject(params.turn) ? params.turn : null
      if (typeof turn?.id !== 'string') return
      this.ended.set(turn.id, turn)
      this.idle?.()
      if (turn.id === this.turnId) this.waiter?.(turn)
    } else if (method === 'thread/status/changed') {
      const status = isObject(params.status) ? params.status : null
      if (status && status.type !== 'active') this.idle?.()
    }
  }

  /** 回合结束了没有（结束了给出 turn 对象） */
  finished(): Record<string, unknown> | null {
    return this.turnId === null ? null : (this.ended.get(this.turnId) ?? null)
  }

  /** 连接断了：正在等的立刻醒来 */
  abort(): void {
    this.waiter?.(null)
    this.idle?.()
  }

  answer(): string | null {
    return this.turnId === null ? null : (this.answers.get(this.turnId) ?? null)
  }

  wait(timeoutMs: number): Promise<Record<string, unknown> | null> {
    const done = this.finished()
    if (done) return Promise.resolve(done)
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.waiter = null
          resolve(null)
        },
        Math.max(0, timeoutMs),
      )
      timer.unref()
      this.waiter = (turn) => {
        clearTimeout(timer)
        this.waiter = null
        resolve(turn)
      }
    })
  }
}

export function summaryOf(text: string | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  return trimmed ? trimmed.slice(0, TASK_RUN_SUMMARY_MAX) : null
}

/** 一个回合在会话里的结果：在会话的回合里找最后一条回答 */
export function answerIn(turn: Record<string, unknown>): string | null {
  const items = Array.isArray(turn.items) ? turn.items : []
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]
    if (isObject(item) && item.type === 'agentMessage' && typeof item.text === 'string')
      if (item.text.trim()) return item.text
  }
  return null
}

/** 回合结束时的 turn 对象换成运行的结果 */
export function outcomeOf(turn: Record<string, unknown>, answer: string | null): RunOutcome {
  const summary = summaryOf(answer)
  if (turn.status === 'completed') return { status: 'succeeded', summary, error: null }
  const error = isObject(turn.error) ? turn.error : null
  const detail = typeof error?.message === 'string' && error.message ? `: ${error.message}` : ''
  return {
    status: 'failed',
    summary,
    error: { code: 'turnFailed', message: `the turn ended as ${String(turn.status)}${detail}` },
  }
}

/** 会话的权限设置写成 thread/start 的参数：声明了预设的给预设的标识，没声明的给审批策略（同客户端） */
function permissionParams(permission: string | null, link: EngineLink): Record<string, unknown> {
  if (!permission) return {}
  const presets = link.runtime?.permissionPresets
  return Array.isArray(presets) && presets.length > 0
    ? { permissions: permission }
    : { approvalPolicy: permission }
}

const supportsClientTools = (link: EngineLink): boolean => {
  const extensions = link.runtime?.extensions
  return Array.isArray(extensions) && extensions.includes(EXTENSION.clientTools)
}

/**
 * 跑一次。run 是排上的那一次（可能已经有会话：上一次设备进程在会话建好、回合还没发的时候退出了）。
 * 失败抛 RunFailure；回合跑完了（不论成败）返回结果。
 */
export async function executeRun(
  host: RunHost,
  sources: () => HarnessSource[],
  task: TaskRow,
  initial: DeviceTaskRun,
): Promise<RunOutcome> {
  let run = { ...initial }
  const target = task.target
  if (target.kind === 'newThread' && run.threadId === null) {
    let directory = false
    try {
      directory = isAbsolute(target.cwd) && statSync(target.cwd).isDirectory()
    } catch {
      directory = false
    }
    if (!directory || !existsSync(target.cwd))
      throw new RunFailure('cwdMissing', `the working directory ${target.cwd} does not exist`)
  }
  let watch: TurnWatch | null = null
  let lostLink = false
  const link = await reachEngine(
    sources,
    run.harness,
    host,
    (method, params) => watch?.notification(method, params),
    () => {
      lostLink = true
      watch?.abort()
    },
  )
  const release = host.hold(link)
  try {
    const timeout = host.timing.requestTimeoutMs
    if (run.threadId === null && target.kind === 'newThread') {
      const started = await link.call(
        'thread/start',
        {
          cwd: target.cwd,
          ...(target.settings.model ? { model: target.settings.model } : {}),
          ...permissionParams(target.settings.permission, link),
          // 任务自己的回合里模型也能管任务（litch_tasks 由设备进程执行）。别的客户端工具要桌面端，不带
          ...(supportsClientTools(link) ? { dynamicTools: [TASKS_TOOLS] } : {}),
          // 原生 codex 认这个来源（上游的 ThreadSource::Feature("automation")），适配器的引擎不认，不带
          ...(link.dialect.clientToolsByDevice ? { threadSource: 'automation' } : {}),
        },
        timeout,
      )
      const thread = isObject(started) && isObject(started.thread) ? started.thread : null
      if (typeof thread?.id !== 'string')
        throw new RunFailure('internal', `${run.harness} did not return the new thread`)
      host.born(run.harness, thread, target.workspaceId)
      run = { ...run, threadId: thread.id }
      host.progress(run)
      // 起名不是要紧的事：不支持、失败都照样往下跑
      await link
        .call(
          'thread/name/set',
          { threadId: thread.id, name: threadName(task, run.scheduledFor) },
          timeout,
        )
        .catch((error) => host.log(`任务 ${task.id} 的会话没有起上名字：${message(error)}`))
    } else {
      const threadId = run.threadId ?? (target.kind === 'thread' ? target.threadId : null)
      if (threadId === null) throw new RunFailure('internal', 'the run has no thread')
      let resumed: unknown
      try {
        resumed = await link.call('thread/resume', { threadId }, timeout)
      } catch (error) {
        if (threadMissing(error))
          throw new RunFailure('threadMissing', `the thread ${threadId} is gone: ${message(error)}`)
        throw error
      }
      const thread = isObject(resumed) && isObject(resumed.thread) ? resumed.thread : null
      if (thread?.id !== threadId)
        throw new RunFailure('threadMissing', `the thread ${threadId} could not be resumed`)
      if (run.threadId !== threadId) {
        run = { ...run, threadId }
        host.progress(run)
      }
      watch = new TurnWatch(threadId)
      const status = isObject(thread.status) ? thread.status : null
      if (status?.type === 'active') await waitIdle(host, link, watch, () => lostLink)
    }
    const threadId = run.threadId as string
    watch ??= new TurnWatch(threadId)
    const effort = target.kind === 'newThread' ? target.settings.effort : null
    const started = await link.call(
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text: taskPrompt(task, run, Math.floor(host.now() / 1000)) }],
        ...(effort ? { effort } : {}),
      },
      timeout,
    )
    const turn = isObject(started) && isObject(started.turn) ? started.turn : null
    if (typeof turn?.id !== 'string')
      throw new RunFailure('internal', `${run.harness} did not start the turn`)
    watch.turnId = turn.id
    run = { ...run, turnId: turn.id, status: 'running', startedAt: Math.floor(host.now() / 1000) }
    host.progress(run)
    return await follow(host, link, watch, () => lostLink, host.timing.turnTimeoutMs)
  } finally {
    release()
    link.close()
  }
}

/** thread 目标：会话正在跑回合，等它空下来，最多等 threadWaitMs */
async function waitIdle(
  host: RunHost,
  link: EngineLink,
  watch: TurnWatch,
  lost: () => boolean,
): Promise<void> {
  const deadline = host.now() + host.timing.threadWaitMs
  while (!lost()) {
    const left = deadline - host.now()
    if (left <= 0)
      throw new RunFailure(
        'internal',
        `the thread stayed busy for ${Math.round(host.timing.threadWaitMs / 60000)} minutes`,
      )
    // 通知来了就醒；也隔一阵自己去看一眼，免得漏了通知一直等
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(left, 30_000))
      timer.unref()
      watch.idle = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    watch.idle = null
    const read = await link
      .call(
        'thread/read',
        { threadId: watch.threadId, includeTurns: false },
        host.timing.requestTimeoutMs,
      )
      .catch(() => null)
    const thread = isObject(read) && isObject(read.thread) ? read.thread : null
    const status = isObject(thread?.status) ? thread.status : null
    if (status && status.type !== 'active') return
  }
  throw new RunFailure('internal', `the connection to the harness was lost`)
}

/**
 * 等回合结束。超时打断，记 timedOut。连接断了：回合可能还在引擎里跑，也可能随引擎一起没了，
 * 这一次按失败记。
 */
export async function follow(
  host: RunHost,
  link: EngineLink,
  watch: TurnWatch,
  lost: () => boolean,
  timeoutMs: number,
): Promise<RunOutcome> {
  const deadline = host.now() + timeoutMs
  while (!lost()) {
    const ended = await watch.wait(Math.min(deadline - host.now(), 60_000))
    if (ended) return outcomeOf(ended, watch.answer() ?? (await readAnswer(host, link, watch)))
    if (host.now() < deadline) continue
    host.log(`回合 ${watch.turnId} 超过了时限，打断它`)
    await link
      .call(
        'turn/interrupt',
        { threadId: watch.threadId, turnId: watch.turnId },
        host.timing.requestTimeoutMs,
      )
      .catch(() => null)
    const after = await watch.wait(host.timing.interruptGraceMs)
    return {
      status: 'failed',
      summary: summaryOf(after ? watch.answer() : null),
      error: {
        code: 'timedOut',
        message: `the turn ran longer than ${Math.round(timeoutMs / 60000)} minutes and was interrupted`,
      },
    }
  }
  throw new RunFailure('internal', 'the connection to the harness was lost during the turn')
}

/** 通知里没见到回答（比如条目早于这条连接订阅之前就结束了）：读一遍会话 */
async function readAnswer(
  host: RunHost,
  link: EngineLink,
  watch: TurnWatch,
): Promise<string | null> {
  const read = await link
    .call(
      'thread/read',
      { threadId: watch.threadId, includeTurns: true },
      host.timing.requestTimeoutMs,
    )
    .catch(() => null)
  const thread = isObject(read) && isObject(read.thread) ? read.thread : null
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const turn = turns.find((item) => isObject(item) && item.id === watch.turnId)
  return isObject(turn) ? answerIn(turn) : null
}

/**
 * 设备进程上一次在回合结束之前退出了：去会话里查这个回合。结束了照实记；还在跑就接着等（时限从它开始时算）；
 * 查不到记 interrupted。
 */
export async function recoverRun(
  host: RunHost,
  sources: () => HarnessSource[],
  run: DeviceTaskRun,
): Promise<RunOutcome> {
  const interrupted = (why: string): RunOutcome => ({
    status: 'failed',
    summary: null,
    error: {
      code: 'interrupted',
      message: `the device service stopped before the turn finished; ${why}`,
    },
  })
  if (run.threadId === null || run.turnId === null) return interrupted('the turn was never started')
  const watch = new TurnWatch(run.threadId)
  watch.turnId = run.turnId
  let lostLink = false
  let link: EngineLink
  try {
    link = await reachEngine(
      sources,
      run.harness,
      host,
      (method, params) => watch.notification(method, params),
      () => {
        lostLink = true
        watch.abort()
      },
    )
  } catch (error) {
    return interrupted(message(error))
  }
  const release = host.hold(link)
  try {
    const timeout = host.timing.requestTimeoutMs
    const read = await link
      .call('thread/read', { threadId: run.threadId, includeTurns: true }, timeout)
      .catch(() => null)
    const thread = isObject(read) && isObject(read.thread) ? read.thread : null
    const turns = Array.isArray(thread?.turns) ? thread.turns : []
    const turn = turns.find((item) => isObject(item) && item.id === run.turnId)
    if (!isObject(turn)) return interrupted('the turn could not be found in the thread')
    if (turn.status !== 'inProgress') return outcomeOf(turn, answerIn(turn))
    // 还在跑：订阅这个会话，接着等
    await link.call('thread/resume', { threadId: run.threadId }, timeout)
    const startedAt = (run.startedAt ?? Math.floor(host.now() / 1000)) * 1000
    const left = startedAt + host.timing.turnTimeoutMs - host.now()
    return await follow(host, link, watch, () => lostLink, Math.max(left, 0))
  } catch (error) {
    return interrupted(message(error))
  } finally {
    release()
    link.close()
  }
}
