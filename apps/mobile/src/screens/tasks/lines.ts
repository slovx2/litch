// 任务和运行记录在列表里的几行字：日程、下一次、最近一次的状态、错误的说法。纯逻辑，单测在 test/tasks.test.mjs。
import type { TaskErrorView, TaskRunStatus, TaskRunView, TaskView } from '@litch/core'
import type { Key, Translator } from '../../ui/i18n'
import { describeSchedule } from './schedule'
import { whenText } from './when'

const RUN_KEY: Record<TaskRunStatus, Key> = {
  queued: 'timed.run.queued',
  running: 'timed.run.running',
  succeeded: 'timed.run.succeeded',
  failed: 'timed.run.failed',
  canceled: 'timed.run.canceled',
}

export const runStatusText = (status: TaskRunStatus, t: Translator): string => t(RUN_KEY[status])

const ERROR_KEY: Record<TaskErrorView['code'], Key> = {
  harnessUnavailable: 'timed.error.harnessUnavailable',
  threadMissing: 'timed.error.threadMissing',
  cwdMissing: 'timed.error.cwdMissing',
  turnFailed: 'timed.error.turnFailed',
  timedOut: 'timed.error.timedOut',
  interrupted: 'timed.error.interrupted',
  internal: 'timed.error.internal',
}

/** 错误说成人话；设备给的原话不一样时接在后面 */
export function errorText(error: TaskErrorView, t: Translator): string {
  const said = t(ERROR_KEY[error.code] ?? 'timed.error.internal')
  return error.message && error.message !== said
    ? t('timed.error.with', { reason: said, message: error.message })
    : said
}

/** 状态记号：在跑、排队算 running；暂停、跑完的不显眼；最近一次失败标错；有没看过的标未读 */
export type TaskMark = 'idle' | 'running' | 'error' | 'unread' | 'offline'

export interface TaskLines {
  title: string
  /** 第二行：日程，第三行：下一次和最近一次 */
  detail: string
  /** 右上角：没看过的几次 */
  meta: string | undefined
  mark: TaskMark
}

export function taskLines(
  task: TaskView,
  now: number,
  localZone: string,
  t: Translator,
): TaskLines {
  const schedule = describeSchedule(task.schedule, task.timezone, localZone, t)
  const state: string[] = []
  if (task.status === 'active' && task.nextRunAt !== null)
    state.push(t('timed.next', { when: whenText(task.nextRunAt, now, t) }))
  else state.push(t(`timed.status.${task.status}`))
  const last = task.lastRun
  if (last) {
    const status = runStatusText(last.status, t)
    const at = last.finishedAt ?? last.startedAt ?? last.scheduledFor
    state.push(`${t('timed.last', { status })} ${whenText(at, now, t)}`)
  }
  const running = last?.status === 'running' || last?.status === 'queued'
  const mark: TaskMark = running
    ? 'running'
    : task.lastError
      ? 'error'
      : task.unreadRuns > 0
        ? 'unread'
        : task.status === 'active'
          ? 'idle'
          : 'offline'
  return {
    title: task.name,
    detail: `${schedule}\n${state.join(' · ')}`,
    meta: task.unreadRuns > 0 ? t('timed.unread', { count: task.unreadRuns }) : undefined,
    mark,
  }
}

export interface RunLines {
  title: string
  detail: string
  mark: TaskMark
}

/** 运行记录的一行：状态、什么时候、怎么来的、合并了几次；摘要或错误在第二行 */
export function runLines(run: TaskRunView, now: number, t: Translator): RunLines {
  const at = run.startedAt ?? run.scheduledFor
  const head = [
    runStatusText(run.status, t),
    whenText(at, now, t),
    t(run.trigger === 'manual' ? 'timed.run.manual' : 'timed.run.scheduled'),
  ]
  if (run.coalesced > 0) head.push(t('timed.run.coalesced', { count: run.coalesced }))
  const body = run.error ? errorText(run.error, t) : (run.summary ?? '')
  const mark: TaskMark =
    run.status === 'running' || run.status === 'queued'
      ? 'running'
      : run.status === 'failed'
        ? 'error'
        : run.read
          ? 'idle'
          : 'unread'
  return { title: head.join(' · '), detail: body, mark }
}
