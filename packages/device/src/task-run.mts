// 定时任务的一次运行怎么驱动引擎：开一条内部连接（engine-link.mts）到目标 harness，
// 新建会话（或者恢复已有的会话、等它空下来），发一个回合，等 turn/completed，取最后一条回答的开头。
// 这里只管和引擎打交道；运行记录怎么存、什么时候开始、跑完任务怎么变，在 tasks.mts。
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { presentationSpec } from '../../protocol/src/client-tools-presentation.mjs'
import { TASKS_TOOLS } from '../../protocol/src/client-tools-tasks.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  type DeviceTaskRun,
  TASK_RUN_SUMMARY_MAX,
  type TaskError,
  type TaskRunErrorCode,
} from '../../protocol/src/device-tasks.mjs'
import {
  type EngineLink,
  EngineUnavailable,
  lastAnswerIn,
  runTurn,
  type TurnResult,
  turnResult,
  watchTurn,
} from './engine-link.mjs'
import type { TaskRow } from './task-store.mjs'
import type { TaskTurns } from './task-turns.mjs'
import { isObject, UpstreamRpcError } from './wire.mjs'

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
  timing: TaskTiming
  log(line: string): void
  /** 运行的进展：会话建好了、回合开始了。传进来的是改好的整份运行 */
  progress(run: DeviceTaskRun): void
  /** 新建出来的会话：登记进索引、归进工作区 */
  born(harness: string, thread: Record<string, unknown>, workspaceId: string | null): void
  /**
   * 开一条内部连接（DeviceServer.openEngineLink，harness 正在起、暂时连不上时最多等 harnessWaitMs）。
   * 开不了抛 EngineUnavailable。设备进程退出时它替我们关掉
   */
  openEngineLink(harness: string): Promise<EngineLink>
  /** 记下任务发起的回合（会话树认出它们，不拿来唤醒父会话） */
  turns: TaskTurns
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

/** 任务新建会话时带的动态工具 */
function taskTools(harness: string): unknown[] {
  const presentation = presentationSpec(harness)
  return presentation ? [TASKS_TOOLS, presentation] : [TASKS_TOOLS]
}

/** 开内部连接；开不了的算 harnessUnavailable */
async function reach(host: RunHost, harness: string): Promise<EngineLink> {
  try {
    return await host.openEngineLink(harness)
  } catch (error) {
    if (error instanceof EngineUnavailable)
      throw new RunFailure('harnessUnavailable', error.message)
    throw error
  }
}

/** 引擎说的“没有这个会话” */
function threadMissing(error: unknown): boolean {
  return error instanceof UpstreamRpcError
}

export function summaryOf(text: string | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  return trimmed ? trimmed.slice(0, TASK_RUN_SUMMARY_MAX) : null
}

/** 回合的结果换成运行的结果 */
export function outcomeOf(result: TurnResult): RunOutcome {
  const summary = summaryOf(result.lastMessage)
  if (result.status === 'completed') return { status: 'succeeded', summary, error: null }
  if (result.status === 'timedOut')
    return {
      status: 'failed',
      summary,
      error: { code: 'timedOut', message: result.error ?? 'the turn timed out' },
    }
  const detail = result.error ? `: ${result.error}` : ''
  return {
    status: 'failed',
    summary,
    error: { code: 'turnFailed', message: `the turn ended as ${result.status}${detail}` },
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

/** 失败（不论哪种）都按 RunFailure 抛，丢了连接的算 internal */
const lostOrRethrow = (error: unknown): never => {
  if (error instanceof RunFailure) throw error
  throw new RunFailure('internal', message(error))
}

/**
 * 跑一次。run 是排上的那一次（可能已经有会话：上一次设备进程在会话建好、回合还没发的时候退出了）。
 * 失败抛 RunFailure；回合跑完了（不论成败）返回结果。
 */
export async function executeRun(
  host: RunHost,
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
  const link = await reach(host, run.harness)
  try {
    if (run.threadId === null && target.kind === 'newThread') {
      const started = await link.request('thread/start', {
        cwd: target.cwd,
        ...(target.settings.model ? { model: target.settings.model } : {}),
        ...permissionParams(target.settings.permission, link),
        // 任务自己的回合里模型也能管任务（litch_tasks 由设备进程执行）。别的客户端工具要桌面端，不带。
        // 任务的会话也在 Litch 里看，带上呈现风格（原生 codex 不带，client-tools-presentation.mts）
        ...(supportsClientTools(link) ? { dynamicTools: taskTools(run.harness) } : {}),
        // 原生 codex 认这个来源（上游的 ThreadSource::Feature("automation")），适配器的引擎不认，不带
        ...(link.native ? { threadSource: 'automation' } : {}),
      })
      const thread = isObject(started) && isObject(started.thread) ? started.thread : null
      if (typeof thread?.id !== 'string')
        throw new RunFailure('internal', `${run.harness} did not return the new thread`)
      host.born(run.harness, thread, target.workspaceId)
      run = { ...run, threadId: thread.id }
      host.progress(run)
      // 起名不是要紧的事：不支持、失败都照样往下跑
      await link
        .request('thread/name/set', {
          threadId: thread.id,
          name: threadName(task, run.scheduledFor),
        })
        .catch((error) => host.log(`任务 ${task.id} 的会话没有起上名字：${message(error)}`))
    } else {
      const threadId = run.threadId ?? (target.kind === 'thread' ? target.threadId : null)
      if (threadId === null) throw new RunFailure('internal', 'the run has no thread')
      let resumed: unknown
      try {
        resumed = await link.request('thread/resume', { threadId })
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
      const status = isObject(thread.status) ? thread.status : null
      if (status?.type === 'active') await waitIdle(host, link, threadId)
    }
    const threadId = run.threadId as string
    const effort = target.kind === 'newThread' ? target.settings.effort : null
    const sent = host.turns.starting(threadId)
    const result = await runTurn(
      link,
      {
        threadId,
        input: [{ type: 'text', text: taskPrompt(task, run, Math.floor(host.now() / 1000)) }],
        ...(effort ? { overrides: { effort } } : {}),
      },
      {
        timeoutMs: host.timing.turnTimeoutMs,
        interruptGraceMs: host.timing.interruptGraceMs,
        onStarted: (turnId) => {
          host.turns.started(threadId, turnId)
          sent()
          run = { ...run, turnId, status: 'running', startedAt: Math.floor(host.now() / 1000) }
          host.progress(run)
        },
      },
    ).finally(sent)
    if (result.status === 'timedOut') host.log(`任务 ${task.id} 的回合超过了时限，打断了`)
    return outcomeOf(result)
  } catch (error) {
    return lostOrRethrow(error)
  } finally {
    link.close()
  }
}

/** thread 目标：会话正在跑回合，等它空下来，最多等 threadWaitMs */
async function waitIdle(host: RunHost, link: EngineLink, threadId: string): Promise<void> {
  const deadline = host.now() + host.timing.threadWaitMs
  let wake: (() => void) | null = null
  let lost: string | null = null
  const stop = link.onNotification((method, params) => {
    if (!isObject(params) || params.threadId !== threadId) return
    const status = isObject(params.status) ? params.status : null
    if (
      method === 'turn/completed' ||
      (method === 'thread/status/changed' && status?.type !== 'active')
    )
      wake?.()
  })
  const unclose = link.onClose((reason) => {
    lost = reason
    wake?.()
  })
  try {
    while (lost === null) {
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
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wake = null
      if (lost !== null) break
      const read = await link
        .request('thread/read', { threadId, includeTurns: false })
        .catch(() => null)
      const thread = isObject(read) && isObject(read.thread) ? read.thread : null
      const status = isObject(thread?.status) ? thread.status : null
      if (status && status.type !== 'active') return
    }
    throw new RunFailure('internal', `the connection to the harness was lost: ${lost}`)
  } finally {
    stop()
    unclose()
  }
}

/**
 * 设备进程上一次在回合结束之前退出了：去会话里查这个回合。结束了照实记；还在跑就接着等（时限从它开始时算）；
 * 查不到记 interrupted。
 */
export async function recoverRun(host: RunHost, run: DeviceTaskRun): Promise<RunOutcome> {
  const interrupted = (why: string): RunOutcome => ({
    status: 'failed',
    summary: null,
    error: {
      code: 'interrupted',
      message: `the device service stopped before the turn finished; ${why}`,
    },
  })
  if (run.threadId === null || run.turnId === null) return interrupted('the turn was never started')
  let link: EngineLink
  try {
    link = await host.openEngineLink(run.harness)
  } catch (error) {
    return interrupted(message(error))
  }
  host.turns.started(run.threadId, run.turnId)
  const watch = watchTurn(link, run.threadId)
  try {
    const read = await link
      .request('thread/read', { threadId: run.threadId, includeTurns: true })
      .catch(() => null)
    const thread = isObject(read) && isObject(read.thread) ? read.thread : null
    const turns = Array.isArray(thread?.turns) ? thread.turns : []
    const turn = turns.find((item) => isObject(item) && item.id === run.turnId)
    if (!isObject(turn)) return interrupted('the turn could not be found in the thread')
    if (turn.status !== 'inProgress') return outcomeOf(turnResult(turn, lastAnswerIn(turn)))
    // 还在跑：订阅这个会话，接着等
    await link.request('thread/resume', { threadId: run.threadId })
    const startedAt = (run.startedAt ?? Math.floor(host.now() / 1000)) * 1000
    const left = startedAt + host.timing.turnTimeoutMs - host.now()
    return outcomeOf(
      await watch.follow(run.turnId, {
        timeoutMs: Math.max(left, 0),
        interruptGraceMs: host.timing.interruptGraceMs,
      }),
    )
  } catch (error) {
    return interrupted(message(error))
  } finally {
    watch.dispose()
    link.close()
  }
}
