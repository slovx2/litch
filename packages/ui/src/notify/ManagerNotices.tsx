import { keys, type ManagerView } from '@litch/core'
import { useEffect, useRef } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { watchManagerNotices } from './manager-notice.ts'

/** 复用桌面通知桥，普通浏览器和手机不发系统通知。 */
export function ManagerNotices({
  selection,
  onOpen,
}: {
  selection: Selection | null
  onOpen(selection: Selection): void
}) {
  const { replica } = useServices()
  const t = useT()
  const current = useRef({ selection, onOpen, t })
  current.current = { selection, onOpen, t }
  useEffect(() => {
    const shell = window.litchShell
    if (!shell?.notify || !shell.onNotifyClick) return
    return watchManagerNotices({
      subscribe: (listener) => replica.onManagerDecision(listener),
      notify: (notice) => shell.notify?.(notice),
      onClick: (listener) => shell.onNotifyClick?.(listener) ?? (() => {}),
      subtitle: () => current.current.t('notify.manager.decision'),
      viewing: (manager) => {
        const seen = current.current.selection
        return (
          document.hasFocus() &&
          seen?.deviceId === manager.deviceId &&
          seen.sessionId === manager.threadId
        )
      },
      open: (deviceId, managerId) => {
        const manager = replica.store.get<ManagerView>(keys.manager(deviceId, managerId))
        if (manager) current.current.onOpen({ deviceId, sessionId: manager.threadId })
      },
    })
  }, [replica])
  return null
}
