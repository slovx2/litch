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
