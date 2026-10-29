// 长按一行出的菜单里有哪几项。规矩照桌面端侧栏（packages/ui/src/sidebar/Sidebar.tsx）：
// - 置顶、移出分区是设备上的记录，不经过 harness：设备能整理（organizable）就有，它的 harness 用不了也能做；
// - 移到别的工作区、改名、归档、删除要够得着它所属的 harness：设备连着、harness 可用才出；
//   harness 声明了自己不会的那几样不出（没有声明的照旧都出，对面说不认识了核心会停掉）。
import type { DeviceView, SessionSummary, WorkspaceView } from '@litch/core'
import type { Translator } from '../../ui/i18n'

export type SessionAct =
  | 'pin'
  | 'unpin'
  | 'unsection'
  | 'move'
  | 'rename'
  | 'archive'
  | 'delete'
  | 'report'

export interface MenuEntry<A extends string> {
  act: A
  label: string
  danger?: boolean
  disabled?: string
}

export function sessionMenu(
  summary: SessionSummary,
  device: DeviceView | undefined,
  workspaces: WorkspaceView[],
  t: Translator,
): MenuEntry<SessionAct>[] {
  const harness = device?.harnesses.find((entry) => entry.id === summary.harness)
  const online = device?.connection === 'online' && harness?.state === 'ready'
  const can = harness?.abilities
  const entries: MenuEntry<SessionAct>[] = []
  if (summary.lineage && device?.reportControl)
    entries.push({
      act: 'report',
      label: t(summary.lineage.reportParent === false ? 'tree.report.resume' : 'tree.report.stop'),
      ...(device.connection === 'online' ? {} : { disabled: t('tree.report.offline') }),
    })
  if (device?.organizable) {
    if (summary.pinned) entries.push({ act: 'unpin', label: t('session.unpin') })
    else {
      if (summary.section)
        entries.push({
          act: 'unsection',
          label: t('session.unsection', { name: summary.section.name }),
        })
      entries.push({ act: 'pin', label: t('session.pin') })
    }
    if (online && workspaces.some((entry) => entry.id !== summary.workspaceId))
      entries.push({ act: 'move', label: t('session.move') })
  }
  if (online) {
    if (can?.rename !== false) entries.push({ act: 'rename', label: t('session.rename') })
    if (can?.archive !== false) entries.push({ act: 'archive', label: t('session.archive') })
    if (can?.remove !== false)
      entries.push({ act: 'delete', label: t('session.delete'), danger: true })
  }
  return entries
}

export type WorkspaceAct = 'new' | 'files' | 'edit' | 'up' | 'down' | 'delete'

/** 工作区标题的菜单。新建和浏览文件要设备连着；改名、排序、删除要设备能整理 */
export function workspaceMenu(
  workspace: WorkspaceView,
  device: DeviceView | undefined,
  workspaces: WorkspaceView[],
  t: Translator,
): MenuEntry<WorkspaceAct>[] {
  const online = device?.connection === 'online'
  const at = workspaces.findIndex((entry) => entry.id === workspace.id)
  const entries: MenuEntry<WorkspaceAct>[] = []
  if (online) {
    entries.push({ act: 'new', label: t('sessions.newHere') })
    if (workspace.roots[0]) entries.push({ act: 'files', label: t('sessions.files') })
  }
  if (device?.organizable) {
    entries.push({ act: 'edit', label: t('workspace.edit') })
    if (at > 0) entries.push({ act: 'up', label: t('workspace.up') })
    if (at >= 0 && at < workspaces.length - 1)
      entries.push({ act: 'down', label: t('workspace.down') })
    entries.push({ act: 'delete', label: t('workspace.delete'), danger: true })
  }
  return entries
}

export type ArchivedAct = 'restore' | 'open' | 'delete'

/** 已归档的一行的菜单。要设备连着：恢复、删除都要问设备，只读打开也要读 */
export function archivedMenu(
  summary: SessionSummary,
  device: DeviceView | undefined,
  t: Translator,
): MenuEntry<ArchivedAct>[] {
  if (device?.connection !== 'online') return []
  const can = device.harnesses.find((entry) => entry.id === summary.harness)?.abilities
  const entries: MenuEntry<ArchivedAct>[] = [
    { act: 'restore', label: t('archived.restore') },
    { act: 'open', label: t('archived.open') },
  ]
  if (can?.remove !== false)
    entries.push({ act: 'delete', label: t('session.delete'), danger: true })
  return entries
}
