import type { DeviceView, SectionView, WorkspaceView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { LocalGroupDialog } from './LocalGroupDialog.tsx'
import { type RowAction, RowMenu } from './RowMenu.tsx'
import { groupOfMember, organize as organizeLocal, useOrganizer } from './shortcuts.ts'

const PROJECTS = ':projects'
const NEW_SECTION = ':new'

/** 原树与投影共用项目操作，排序仍修改真实设备目录。 */
export function WorkspaceActions({
  device,
  workspace,
  workspaces,
  sections,
  onEdit,
  onNewSection,
  place,
}: {
  device: DeviceView
  workspace: WorkspaceView
  workspaces: readonly WorkspaceView[]
  sections: readonly SectionView[]
  onEdit(workspace: WorkspaceView): void
  onNewSection(then: (sectionId: string) => void): void
  /** 在全局置顶区里：上移、下移改的是本机的置顶先后，不是设备上项目的顺序 */
  place?: { index: number; count: number; shift(step: -1 | 1): void } | undefined
}) {
  const { channel } = useServices()
  const t = useT()
  const organizer = useOrganizer()
  const [creating, setCreating] = useState(false)
  const deviceId = device.id
  const organize = (done: Promise<unknown>) => {
    done.catch((error: unknown) =>
      showToast({
        id: 'organize-failed',
        tone: 'err',
        lifeMs: 8000,
        text: (say) => say('session.failed', { reason: reasonOf(error, say) }),
      }),
    )
  }
  const siblingsOf = (workspace: WorkspaceView) =>
    workspaces.filter((entry) =>
      workspace.pinned
        ? entry.pinned
        : workspace.sectionId
          ? entry.sectionId === workspace.sectionId
          : !entry.pinned && !entry.sectionId,
    )
  const siblings = siblingsOf(workspace)
  const at = siblings.indexOf(workspace)
  const home = sections.find((entry) => entry.id === workspace.sectionId)
  const actions: RowAction[] = []
  if (device.organizable) {
    actions.push({ id: 'edit', title: t('workspace.edit') })
    if (home) actions.push({ id: 'ungroup', title: t('workspace.ungroup', { name: home.name }) })
    else
      actions.push({ id: 'pin', title: t(workspace.pinned ? 'workspace.unpin' : 'workspace.pin') })
    actions.push({
      id: 'group',
      title: t('section.move'),
      choices: {
        title: t('section.move.title'),
        back: t('session.move.back'),
        options: [
          // 在置顶、用户组里的可以挪回内置的“项目”
          ...(workspace.pinned || workspace.sectionId
            ? [{ id: PROJECTS, title: t('sidebar.projects') }]
            : []),
          ...sections
            .filter((entry) => entry.id !== workspace.sectionId)
            .map((entry) => ({ id: entry.id, title: entry.name })),
          { id: NEW_SECTION, title: t('section.add') },
        ],
      },
    })
    actions.push({
      id: 'delete',
      title: t('workspace.delete'),
      confirm: {
        title: t('workspace.delete.title', { name: workspace.name }),
        note: t('workspace.delete.note'),
        yes: t('workspace.delete'),
        no: t('workspace.cancel'),
      },
    })
  }
  const [index, count] = place ? [place.index, place.count] : [at, siblings.length]
  if (place || device.organizable) {
    if (index > 0) actions.push({ id: 'up', title: t('workspace.up') })
    if (index < count - 1) actions.push({ id: 'down', title: t('workspace.down') })
  }
  const member = { kind: 'workspace' as const, deviceId, workspaceId: workspace.id }
  const homeGroup = groupOfMember(organizer, member)
  if (organizer?.status === 'ok') {
    actions.push({
      id: 'local',
      title: t('local.join'),
      choices: {
        title: t('local.join.title'),
        back: t('session.move.back'),
        options: [
          ...organizer.groups
            .filter((group) => group.id !== homeGroup?.id)
            .map((group) => ({ id: group.id, title: group.name })),
          { id: NEW_SECTION, title: t('local.join.new') },
        ],
      },
    })
    if (homeGroup)
      actions.push({ id: 'unlocal', title: t('local.leave', { name: homeGroup.name }) })
  }
  const joined = (name: string) => {
    if (workspace.pinned)
      showToast({
        id: 'local-pinned',
        lifeMs: 5000,
        text: (say) => say('local.stillPinned', { name }),
      })
  }
  const target = { deviceId, workspaceId: workspace.id }
  const regroup = (sectionId: string) =>
    organize(channel.command('workspace.update', { ...target, sectionId }))
  return (
    <>
      <RowMenu
        label={t('workspace.menu')}
        actions={actions}
        onAction={(id, choice) => {
          if (id === 'local') {
            if (choice === NEW_SECTION) setCreating(true)
            else if (choice)
              void organizeLocal(channel, { type: 'member.add', groupId: choice, member }).then(
                (done) => {
                  if (done)
                    joined(organizer?.groups.find((group) => group.id === choice)?.name ?? '')
                },
              )
          } else if (id === 'unlocal')
            void organizeLocal(channel, { type: 'member.remove', member })
          else if (id === 'edit') onEdit(workspace)
          else if (id === 'delete') organize(channel.command('workspace.delete', target))
          else if (id === 'pin') {
            organize(channel.command('workspace.update', { ...target, pinned: !workspace.pinned }))
          } else if (id === 'ungroup') {
            organize(channel.command('workspace.update', { ...target, sectionId: null }))
          } else if (id === 'group') {
            if (choice === NEW_SECTION) onNewSection(regroup)
            else if (choice === PROJECTS) {
              const out = workspace.pinned ? { pinned: false } : { sectionId: null }
              organize(channel.command('workspace.update', { ...target, ...out }))
            } else if (choice) regroup(choice)
          } else if (place) place.shift(id === 'up' ? -1 : 1)
          else {
            // 上移：挪到同一处前一个的前面；下移：挪到同一处后面第二个的前面，
            // 后面只剩一个就挪到它在整张表里的下一个前面（没有就是最后）
            const next = siblings[at + 1]
            const before =
              id === 'up'
                ? (siblings[at - 1]?.id ?? null)
                : (siblings[at + 2]?.id ??
                  (next ? (workspaces[workspaces.indexOf(next) + 1]?.id ?? null) : null))
            organize(channel.command('workspace.move', { ...target, before }))
          }
        }}
      />
      {creating ? (
        <LocalGroupDialog
          group={null}
          members={[member]}
          onCreated={() => {
            // 新组名已由核心写入，提示只需说明置顶仍然保留。
            if (workspace.pinned)
              showToast({
                id: 'local-pinned',
                lifeMs: 5000,
                text: (say) => say('local.joinedPinned'),
              })
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  )
}
