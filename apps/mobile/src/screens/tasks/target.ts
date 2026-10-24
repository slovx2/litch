// 任务详情里的两行：到点之后做什么（每次新建会话的 harness、项目或目录；或者在哪个会话里接着发），
// 任务是怎么来的（界面上建的，或者模型在哪个会话里建的）。会话名、项目名、harness 名都从订阅里拿。
import {
  type DeviceView,
  keys,
  type SessionSummary,
  type TaskOrigin,
  type TaskTarget,
  type WorkspaceView,
} from '@litch/core'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'

export function useTargetLine(deviceId: string, target: TaskTarget | undefined): string {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const summary = useKey<SessionSummary>(
    keys.summary(deviceId, target?.kind === 'thread' ? target.threadId : ''),
  )
  if (!target) return ''
  const harness =
    device?.harnesses.find((entry) => entry.id === target.harness)?.name ?? target.harness
  if (target.kind === 'thread')
    return [
      t('tasks.detail.inThread'),
      harness,
      summary ? t.text(summary.title) : t('tasks.run.gone'),
    ].join(' · ')
  const workspace = target.workspaceId
    ? workspaces?.find((entry) => entry.id === target.workspaceId)
    : undefined
  const where = workspace ? `${workspace.name} (${target.cwd})` : target.cwd
  return [
    t(target.worktree ? 'tasks.detail.newWorktree' : 'tasks.detail.newThread'),
    harness,
    where,
  ].join(' · ')
}

export function useOriginLine(deviceId: string, origin: TaskOrigin | undefined): string {
  const t = useT()
  const summary = useKey<SessionSummary>(
    keys.summary(deviceId, origin?.kind === 'tool' ? origin.threadId : ''),
  )
  if (!origin) return ''
  if (origin.kind === 'client') return t('tasks.detail.origin.client')
  return summary
    ? t('tasks.detail.origin.tool', { title: t.text(summary.title) })
    : t('tasks.detail.origin.toolGone')
}
