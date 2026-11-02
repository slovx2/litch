// 侧栏一行前面的状态记号：普通会话行和经理行共用。回合在跑转圈（run），等人（wait）、出错（err），
// 回合停了、后台任务还在跑是慢呼吸的空心记号（bg，见 23 号设计），再往后是未读。
import type { SessionSummary } from '@litch/core'

export type SessionMark = 'run' | 'wait' | 'err' | 'bg' | 'unread' | ''

export function sessionMark(
  summary: Pick<SessionSummary, 'status' | 'background' | 'unread'> | undefined,
): SessionMark {
  if (!summary) return ''
  if (summary.status === 'running') return 'run'
  if (summary.status === 'waiting') return 'wait'
  if (summary.status === 'error') return 'err'
  if ((summary.background?.running ?? 0) > 0) return 'bg'
  return summary.unread ? 'unread' : ''
}

export type ManagerStateText =
  | { key: 'manager.running' | 'manager.idle' }
  | { key: 'manager.linesCount'; n: number }
  | { key: 'background.sidebar'; count: number }

/**
 * 经理行的状态文字（桌面侧栏和手机经理目录共用）：记号只说经理会话自己，工作线在跑另用文字写明。
 * 依次为经理自己回合在跑或等人 → N 条工作线运行中 → 自己的 N 个后台任务 → 空闲。
 */
export function managerStateText(
  summary: Pick<SessionSummary, 'status' | 'background' | 'unread'> | undefined,
  runningLines: number,
): ManagerStateText {
  const mark = sessionMark(summary)
  if (mark === 'run' || mark === 'wait') return { key: 'manager.running' }
  if (runningLines > 0) return { key: 'manager.linesCount', n: runningLines }
  const background = summary?.background?.running ?? 0
  if (background > 0) return { key: 'background.sidebar', count: background }
  return { key: 'manager.idle' }
}
