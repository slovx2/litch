// 会话动作单里的“加入本机分组”“从某组移出”，以及选组的动作单、新建组时问名字的框。
// 设备会话列表、首页置顶区、本机组详情三处共用。本机分组只在这台手机上，任何设备的会话都能放进来，
// 设备连没连着都能做（不经过设备）。
import { GROUP_NAME_MAX, type MemberRef } from '@litch/core'
import { type ReactNode, useState } from 'react'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Prompt, Sheet, type SheetAction } from '../../ui/kit/overlays'
import { groupOfMember, organize, organizerBlocked, useOrganizer } from './organizer-state'

export function useLocalJoin(act: (work: Promise<unknown>) => void): {
  /** 放进会话动作单的几项 */
  entries(ref: MemberRef): SheetAction[]
  overlays: ReactNode
} {
  const t = useT()
  const channel = useChannel()
  const organizer = useOrganizer()
  const [choosing, setChoosing] = useState<MemberRef | null>(null)
  const [naming, setNaming] = useState<MemberRef | null>(null)
  const entries = (ref: MemberRef): SheetAction[] => {
    if (!organizer || organizerBlocked(organizer)) return []
    const current = groupOfMember(organizer, ref)
    return [
      { label: t('local.join'), testID: 'menu:local', onPress: () => setChoosing(ref) },
      ...(current
        ? [
            {
              label: t('local.leave', { name: current.name }),
              testID: 'menu:unlocal',
              onPress: () => act(organize(channel, { type: 'member.remove', member: ref })),
            },
          ]
        : []),
    ]
  }
  const current = choosing ? groupOfMember(organizer, choosing) : undefined
  const overlays = (
    <>
      <Sheet
        visible={choosing !== null}
        title={t('local.join.title')}
        onClose={() => setChoosing(null)}
        actions={
          choosing
            ? [
                ...(organizer?.groups ?? [])
                  .filter((group) => group.id !== current?.id)
                  .map((group) => ({
                    label: group.name,
                    testID: `menu:local:${group.id}`,
                    onPress: () =>
                      act(
                        organize(channel, {
                          type: 'member.add',
                          groupId: group.id,
                          member: choosing,
                        }),
                      ),
                  })),
                {
                  label: t('local.join.new'),
                  testID: 'menu:local:new',
                  onPress: () => setNaming(choosing),
                },
              ]
            : []
        }
      />
      <LocalGroupName
        visible={naming !== null}
        initial=""
        onSubmit={(name) => {
          if (naming) act(organize(channel, { type: 'group.create', name, members: [naming] }))
        }}
        onClose={() => setNaming(null)}
      />
    </>
  )
  return { entries, overlays }
}

/** 新建或改名时问组名。只在这台手机上保存，新建时说一句 */
export function LocalGroupName({
  visible,
  initial,
  onSubmit,
  onClose,
}: {
  visible: boolean
  /** 空的是新建 */
  initial: string
  onSubmit(name: string): void
  onClose(): void
}) {
  const t = useT()
  const adding = initial === ''
  return (
    <Prompt
      visible={visible}
      title={t(adding ? 'local.add.title' : 'local.rename.title')}
      initial={initial}
      placeholder={t('section.name')}
      maxLength={GROUP_NAME_MAX}
      {...(adding ? { note: t('local.note') } : {})}
      submitLabel={t(adding ? 'section.create' : 'workspace.save')}
      onSubmit={(name) => {
        // 空的、没改的 Prompt 自己当取消
        onSubmit(name)
      }}
      onClose={onClose}
    />
  )
}
