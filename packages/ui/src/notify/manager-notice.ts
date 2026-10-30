// core 已排除快照和重复状态；这里只决定前台抑制、文字和点击后的去处。
import type { ManagerDecisionView, ManagerView } from '@litch/core'

const PREFIX = 'manager-decision:'
const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

interface NoticeHost {
  subscribe(listener: (manager: ManagerView, decision: ManagerDecisionView) => void): () => void
  notify(notice: {
    id: string
    title: string
    subtitle: string
    body: string
    urgent: boolean
  }): void
  onClick(listener: (id: string) => void): () => void
  subtitle(): string
  viewing(manager: ManagerView): boolean
  open(deviceId: string, managerId: string): void
}

export function watchManagerNotices(host: NoticeHost): () => void {
  const stop = host.subscribe((manager, decision) => {
    if (!manager.contact.desktopNotification || host.viewing(manager)) return
    host.notify({
      id: `${PREFIX}${JSON.stringify([manager.deviceId, manager.id, decision.id])}`,
      title: clip(manager.name, 120),
      subtitle: host.subtitle(),
      body: clip(decision.title, 240),
      urgent: true,
    })
  })
  const stopClick = host.onClick((id) => {
    if (!id.startsWith(PREFIX)) return
    const [deviceId, managerId] = JSON.parse(id.slice(PREFIX.length)) as [string, string, string]
    host.open(deviceId, managerId)
  })
  return () => {
    stop()
    stopClick()
  }
}
