import { keys, type SessionChildren } from '@litch/core'
import { markReadScope, unreadInScope } from '../../../../../packages/ui/src/app/read.ts'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import type { SheetAction } from '../../ui/kit/overlays'

/** 只订阅当前菜单的范围；离线缓存也可标已读，不受 harness 能力限制。 */
export function useReadMenu(
  deviceId: string | undefined,
  root: string | undefined,
  act: (work: Promise<unknown>) => void,
): SheetAction[] {
  const channel = useChannel()
  const { store } = useReplica()
  const t = useT()
  const unread = useKey<string[]>(keys.catalogUnread(deviceId ?? '')) ?? []
  const children = useKey<SessionChildren>(keys.children(deviceId ?? '')) ?? {}
  if (!deviceId || !unreadInScope(unread, children, root).length) return []
  return [
    {
      label: t(root === undefined ? 'session.markAllRead' : 'session.markRead'),
      testID: root === undefined ? 'menu:markAllRead' : 'menu:markRead',
      onPress: () => act(markReadScope(channel, store, deviceId, root)),
    },
  ]
}
