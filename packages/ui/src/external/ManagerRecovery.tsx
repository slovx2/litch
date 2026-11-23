// 恢复入口复用经理本身的刷新、换绑与确认流程。
import { type ExternalManagerRecovery, keys, type ManagerView } from '@litch/core'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useKey } from '../app/services.tsx'
import { ResetManager } from '../manager/ResetManager.tsx'

/** 当前活动经理的页头已提供刷新，不重复显示同一入口。 */
export function recoveryInManagerHeader(
  manager: Pick<ManagerView, 'id' | 'threadId' | 'status'>,
  recovery: ExternalManagerRecovery,
): boolean {
  return (
    recovery.managerId === manager.id &&
    recovery.threadId === manager.threadId &&
    manager.status === 'active'
  )
}

export function ManagerRecovery({
  deviceId,
  recovery,
  disabled,
}: {
  deviceId: string
  recovery: ExternalManagerRecovery
  disabled: boolean
}) {
  const t = useT()
  const manager = useKey<ManagerView>(keys.manager(deviceId, recovery.managerId))
  if (manager?.threadId === recovery.threadId && manager.status === 'active')
    return <ResetManager manager={manager} disabled={disabled} autoOpenFailure={false} />
  return (
    <button
      type="button"
      className="ext-text-link"
      disabled={disabled}
      onClick={() => requestOpenSession({ deviceId, sessionId: recovery.threadId })}
    >
      {t('ext.openManagerRecovery')}
    </button>
  )
}
