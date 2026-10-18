// 会话列表上弹出来的动作单：现在是哪一张（会话的、移到哪个工作区、工作区的、已归档的、整页的），
// 里面有哪几项、点了做什么。哪几项由 menus.ts 定，这里只把它们接到命令和别的浮层上。
import type { DeviceView, SessionSummary, WorkspaceView } from '@litch/core'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import type { SheetAction } from '../../ui/kit/overlays'
import { archivedMenu, sessionMenu, workspaceMenu } from './menus'
import { titleOf } from './rows'
import type { WorkspaceEdit } from './WorkspaceDialog'

export type Menu =
  | { kind: 'session'; summary: SessionSummary }
  | { kind: 'move'; summary: SessionSummary }
  | { kind: 'workspace'; workspace: WorkspaceView }
  | { kind: 'archived'; summary: SessionSummary }
  | { kind: 'screen' }

/** 找不回来的事先问一句 */
export interface Ask {
  title: string
  detail: string
  label: string
  run(): void
}

export function useSheet({
  menu,
  device,
  workspaces,
  deviceId,
  act,
  setMenu,
  setRenaming,
  setAsk,
  setWorkspaceEdit,
  navigation,
}: {
  menu: Menu | null
  device: DeviceView | undefined
  workspaces: WorkspaceView[]
  deviceId: string
  act(work: Promise<unknown>): void
  setMenu(menu: Menu | null): void
  setRenaming(summary: SessionSummary | null): void
  setAsk(ask: Ask | null): void
  setWorkspaceEdit(edit: WorkspaceEdit | null): void
  navigation: NativeStackNavigationProp<RootStackParamList, 'Sessions'>
}): { title?: string; actions: SheetAction[] } {
  const t = useT()
  const channel = useChannel()
  if (!menu) return { actions: [] }
  const target = (summary: SessionSummary) => ({ deviceId, sessionId: summary.id })
  const askDelete = (summary: SessionSummary) =>
    setAsk({
      title: t('session.delete.title'),
      detail: t('session.delete.note'),
      label: t('session.delete'),
      run: () => act(channel.command('session.delete', target(summary))),
    })

  switch (menu.kind) {
    case 'session': {
      const { summary } = menu
      const entries = sessionMenu(summary, device, workspaces, t)
      const run = {
        pin: () => act(channel.command('session.place', { ...target(summary), place: 'pinned' })),
        unpin: () => act(channel.command('session.place', { ...target(summary), place: null })),
        unsection: () => act(channel.command('session.place', { ...target(summary), place: null })),
        move: () => setMenu({ kind: 'move', summary }),
        rename: () => setRenaming(summary),
        archive: () => act(channel.command('session.archive', target(summary))),
        delete: () => askDelete(summary),
      }
      return {
        title: titleOf(summary, t),
        actions: entries.map((entry) => ({
          label: entry.label,
          danger: entry.danger,
          testID: `menu:${entry.act}`,
          onPress: run[entry.act],
        })),
      }
    }
    case 'move': {
      const { summary } = menu
      return {
        title: t('session.move.title'),
        actions: workspaces
          .filter((entry) => entry.id !== summary.workspaceId)
          .map((workspace) => ({
            label: workspace.name,
            testID: `menu:move:${workspace.id}`,
            onPress: () =>
              act(
                channel.command('session.move', {
                  ...target(summary),
                  workspaceId: workspace.id,
                }),
              ),
          })),
      }
    }
    case 'workspace': {
      const { workspace } = menu
      const at = workspaces.findIndex((entry) => entry.id === workspace.id)
      const moveBefore = (before: string | null) =>
        act(channel.command('workspace.move', { deviceId, workspaceId: workspace.id, before }))
      const run = {
        new: () => navigation.navigate('NewSession', { deviceId, workspaceId: workspace.id }),
        files: () => navigation.navigate('Files', { deviceId, root: workspace.roots[0] ?? '' }),
        edit: () => setWorkspaceEdit({ kind: 'edit', workspace }),
        up: () => moveBefore(workspaces[at - 1]?.id ?? null),
        down: () => moveBefore(workspaces[at + 2]?.id ?? null),
        delete: () =>
          setAsk({
            title: t('workspace.delete.title', { name: workspace.name }),
            detail: t('workspace.delete.note'),
            label: t('workspace.delete'),
            run: () =>
              act(channel.command('workspace.delete', { deviceId, workspaceId: workspace.id })),
          }),
      }
      return {
        title: workspace.name,
        actions: workspaceMenu(workspace, device, workspaces, t).map((entry) => ({
          label: entry.label,
          danger: entry.danger,
          testID: `menu:workspace:${entry.act}`,
          onPress: run[entry.act],
        })),
      }
    }
    case 'archived': {
      const { summary } = menu
      const run = {
        restore: () => act(channel.command('session.unarchive', target(summary))),
        open: () =>
          navigation.navigate('Detail', {
            deviceId,
            sessionId: summary.id,
            title: titleOf(summary, t),
          }),
        delete: () => askDelete(summary),
      }
      return {
        title: titleOf(summary, t),
        actions: archivedMenu(summary, device, t).map((entry) => ({
          label: entry.label,
          danger: entry.danger,
          testID: `menu:archived:${entry.act}`,
          onPress: run[entry.act],
        })),
      }
    }
    case 'screen': {
      const actions: SheetAction[] = [
        {
          label: t('sessions.new'),
          testID: 'menu:screen:new',
          onPress: () => navigation.navigate('NewSession', { deviceId }),
        },
      ]
      if (device?.organizable)
        actions.push({
          label: t('workspace.add'),
          testID: 'menu:screen:addWorkspace',
          onPress: () => setWorkspaceEdit({ kind: 'add' }),
        })
      actions.push({
        label: t('tasks.title'),
        testID: 'menu:screen:tasks',
        onPress: () => navigation.navigate('Tasks', { deviceId }),
      })
      return { actions }
    }
  }
}
