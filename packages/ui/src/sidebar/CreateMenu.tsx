// 侧栏的“新建”菜单：顶上一排的“+”，和侧栏空白处的右键，是同一份菜单（右键经 handle 弹在鼠标那里）。
// 每一项都走现成的流程和对话框：新对话页、添加项目（WorkspaceDialog）、新建本地分组（LocalGroupDialog）、
// 添加设备（AddDevice）。这里只决定列哪几项、点了打开哪一个。
import { type DeviceView, keys } from '@litch/core'
import { type RefObject, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Plus } from '../app/icons.tsx'
import { useKey, useKeys } from '../app/services.tsx'
import { AddDevice } from '../devices/AddDevice.tsx'
import { LocalGroupDialog } from './LocalGroupDialog.tsx'
import { type RowAction, RowMenu, type RowMenuHandle } from './RowMenu.tsx'
import { useOrganizer } from './shortcuts.ts'
import { WorkspaceDialog } from './WorkspaceDialog.tsx'

const NO_IDS: readonly string[] = []

type Open = { kind: 'workspace'; deviceId: string } | { kind: 'local' } | { kind: 'device' }

export function CreateMenu({
  handle,
  onCompose,
}: {
  handle: RefObject<RowMenuHandle | null>
  onCompose(): void
}) {
  const t = useT()
  const organizer = useOrganizer()
  const ids = useKey<string[]>(keys.devices) ?? NO_IDS
  const devices = useKeys<DeviceView>(ids.map((id) => keys.device(id)))
  const [open, setOpen] = useState<Open | null>(null)
  // 能添加项目的：能整理、连着的设备。只有一台时直接打开，多台时先挑设备
  const hosts = devices.filter(
    (device): device is DeviceView =>
      device?.organizable === true && device.connection === 'online',
  )
  const fault =
    organizer && organizer.status !== 'ok'
      ? t(organizer.status === 'newer' ? 'fault.organizerNewer' : 'fault.organizerBlocked')
      : undefined
  const actions: RowAction[] = [
    { id: 'session', title: t('sidebar.newSession') },
    hosts.length > 1
      ? {
          id: 'workspace',
          title: t('workspace.add'),
          choices: {
            title: t('sidebar.create.workspaceOn'),
            back: t('session.move.back'),
            options: hosts.map((device) => ({
              id: device.id,
              title: t.text(device.name),
              wire: device.wire,
            })),
          },
        }
      : {
          id: 'workspace',
          title: t('workspace.add'),
          ...(hosts.length === 0 ? { disabled: t('sidebar.create.noWorkspace') } : {}),
        },
    {
      id: 'local',
      title: t('local.join.new'),
      help: t('local.help'),
      ...(organizer ? (fault ? { disabled: fault } : {}) : { disabled: true as const }),
    },
    { id: 'device', title: t('sidebar.create.device') },
  ]
  return (
    <>
      <RowMenu
        handle={handle}
        className="sb-create"
        icon={<Plus />}
        label={t('sidebar.create')}
        actions={actions}
        onAction={(id, choice) => {
          if (id === 'session') onCompose()
          else if (id === 'workspace') {
            const deviceId = choice ?? hosts[0]?.id
            if (deviceId) setOpen({ kind: 'workspace', deviceId })
          } else if (id === 'local') setOpen({ kind: 'local' })
          else if (id === 'device') setOpen({ kind: 'device' })
        }}
      />
      {open?.kind === 'workspace' ? (
        <WorkspaceDialog deviceId={open.deviceId} workspace={null} onClose={() => setOpen(null)} />
      ) : null}
      {open?.kind === 'local' ? (
        <LocalGroupDialog group={null} members={[]} onClose={() => setOpen(null)} />
      ) : null}
      {open?.kind === 'device' ? <AddDevice edit={null} onClose={() => setOpen(null)} /> : null}
    </>
  )
}
