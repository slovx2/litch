// 一个本机分组的动作单：改名、上移、下移、删除（先问一句）。首页长按组那一行、组详情页标题栏的“⋯”共用。
import type { LocalGroup } from '@litch/core'
import { type ReactNode, useState } from 'react'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Confirm, Sheet } from '../../ui/kit/overlays'
import { LocalGroupName } from './LocalJoin'
import { organize, useOrganizer } from './organizer-state'

export function useGroupMenu(
  act: (work: Promise<unknown>) => void,
  onDeleted?: () => void,
): { open(group: LocalGroup): void; overlays: ReactNode } {
  const t = useT()
  const channel = useChannel()
  const organizer = useOrganizer()
  const [menu, setMenu] = useState<LocalGroup | null>(null)
  const [renaming, setRenaming] = useState<LocalGroup | null>(null)
  const [deleting, setDeleting] = useState<LocalGroup | null>(null)
  const groups = organizer?.groups ?? []
  const at = menu ? groups.findIndex((group) => group.id === menu.id) : -1
  const moveTo = (group: LocalGroup, to: number) =>
    act(organize(channel, { type: 'group.move', groupId: group.id, to }))
  const overlays = (
    <>
      <Sheet
        visible={menu !== null}
        title={menu?.name}
        onClose={() => setMenu(null)}
        actions={
          menu
            ? [
                {
                  label: t('local.rename'),
                  testID: 'menu:group:rename',
                  onPress: () => setRenaming(menu),
                },
                ...(at > 0
                  ? [
                      {
                        label: t('organizer.up'),
                        testID: 'menu:group:up',
                        onPress: () => moveTo(menu, at - 1),
                      },
                    ]
                  : []),
                ...(at >= 0 && at < groups.length - 1
                  ? [
                      {
                        label: t('organizer.down'),
                        testID: 'menu:group:down',
                        onPress: () => moveTo(menu, at + 1),
                      },
                    ]
                  : []),
                {
                  label: t('local.delete'),
                  testID: 'menu:group:delete',
                  danger: true,
                  onPress: () => setDeleting(menu),
                },
              ]
            : []
        }
      />
      <LocalGroupName
        visible={renaming !== null}
        initial={renaming?.name ?? ''}
        onSubmit={(name) => {
          if (renaming) act(organize(channel, { type: 'group.rename', groupId: renaming.id, name }))
        }}
        onClose={() => setRenaming(null)}
      />
      <Confirm
        visible={deleting !== null}
        title={deleting ? t('local.delete.title', { name: deleting.name }) : ''}
        detail={t('local.delete.note')}
        confirmLabel={t('local.delete')}
        danger
        onConfirm={() => {
          if (!deleting) return
          act(organize(channel, { type: 'group.delete', groupId: deleting.id }))
          onDeleted?.()
        }}
        onClose={() => setDeleting(null)}
      />
    </>
  )
  return { open: setMenu, overlays }
}
