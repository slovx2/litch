// 任务的目标说成一行：每次新建会话（harness、项目或目录），或者在哪个会话里接着发（harness、会话名）。
// 会话名、项目名、harness 名都从订阅里拿：会话不在列表里了就说一声。
import {
  type DeviceView,
  keys,
  type SessionSummary,
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
    return t('timed.target.summary.thread', {
      harness,
      title: summary ? t.text(summary.title) : t('timed.target.thread.gone'),
    })
  const workspace = target.workspaceId
    ? workspaces?.find((entry) => entry.id === target.workspaceId)
    : undefined
  return t('timed.target.summary.new', {
    harness,
    where: workspace ? `${workspace.name} (${target.cwd})` : target.cwd,
  })
}
