// 任务和运行记录在列表里的几行字。日程、时间点、运行状态、失败原因的说法用桌面界面那一份
// （packages/ui/src/tasks/describe.ts，纯函数），这里只管怎么摆成手机上的几行。单测在 test/tasks.test.mjs。
import type { TaskRunView, TaskView } from '@litch/core'
import {
  askLine,
  askStateText,
  errorText,
  runStatusText,
  scheduleLine,
  triggerText,
  waitingAsks,
  whenText,
} from '../../../../../packages/ui/src/tasks/describe.ts'
import type { Translator } from '../../ui/i18n'

/** 状态记号：回合停在审批上等人的算 waiting；在跑、排队算 running；最近一次失败标错；有没看过的标未读；暂停、跑完的不显眼 */
export type TaskMark = 'idle' | 'running' | 'waiting' | 'error' | 'unread' | 'offline'

export interface TaskLines {
  title: string
  /** 第二行：日程，第三行：下一次和最近一次 */
  detail: string
  /** 右上角：没看过的几次 */
  meta: string | undefined
  mark: TaskMark
}

export function taskLines(task: TaskView, now: number, here: string, t: Translator): TaskLines {
  const schedule = scheduleLine(task, t, here, now)
  const state: string[] = []
  if (task.status === 'active' && task.nextRunAt !== null)
    state.push(
      t('timed.row', { label: t('tasks.row.next'), value: whenText(task.nextRunAt, now, t) }),
    )
  else state.push(t(`tasks.status.${task.status}`))
  const last = task.lastRun
  const asking = waitingAsks(last).length > 0
  if (last) {
    const at = last.finishedAt ?? last.startedAt ?? last.scheduledFor
    const status = asking ? t('tasks.ask.mark') : runStatusText(last.status, t)
    const value = `${status} ${whenText(at, now, t)}`
    state.push(t('timed.row', { label: t('tasks.row.last'), value }))
  }
  const running = last?.status === 'running' || last?.status === 'queued'
  const mark: TaskMark = asking
    ? 'waiting'
    : running
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

/** 运行记录的一行：状态、什么时候、怎么来的、合并了几次；错误或摘要在第二行，回合里要人答的请求各占一行 */
export function runLines(run: TaskRunView, now: number, t: Translator): RunLines {
  const head = [
    runStatusText(run.status, t),
    whenText(run.startedAt ?? run.scheduledFor, now, t),
    triggerText(run.trigger, t),
  ]
  if (run.coalesced > 0) head.push(t('tasks.run.coalesced', { count: run.coalesced }))
  if (waitingAsks(run).length > 0) head.push(t('tasks.ask.mark'))
  const mark: TaskMark =
    waitingAsks(run).length > 0
      ? 'waiting'
      : run.status === 'running' || run.status === 'queued'
        ? 'running'
        : run.status === 'failed'
          ? 'error'
          : run.read
            ? 'idle'
            : 'unread'
  const lines = [run.error ? errorText(run.error, t) : (run.summary ?? '')].filter(Boolean)
  for (const entry of run.approvals)
    lines.push(`${askLine(entry, t)} · ${askStateText(entry, now, t)}`)
  return {
    title: head.join(' · '),
    detail: lines.join('\n'),
    mark,
  }
}
