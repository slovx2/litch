// 工作线会话页上的经理入口：副标题前半段“↰ 经理名”、菜单里“回到经理”和相关议题、正文里的看板编号链接。
// 不是工作线（摘要上没有 litchManager.role=line）时什么都不给，页面照普通会话画。
import {
  keys,
  type ManagerBoardTopicView,
  type ManagerView,
  managerMark,
  type SessionSummary,
} from '@litch/core'
import { CommonActions, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useEffect, useMemo } from 'react'
import type { IssueLinks } from '../../detail/issue-links'
import type { ManagerTab, RootStackParamList } from '../../nav/routes'
import { useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import type { SheetAction } from '../../ui/kit/overlays'
import type { HeaderLink } from '../../ui/kit/Screen'
import { lineIssues, managerRouteBelow } from './origin'

export interface ManagerOrigin {
  link: HeaderLink
  menu: SheetAction[]
  issues: IssueLinks | null
}

type Navigation = NativeStackNavigationProp<RootStackParamList>

/** 到某个经理页的某一格（可带议题）：栈里下面有就退回去，没有就推一个 */
export function goToManager(
  navigation: Navigation,
  deviceId: string,
  managerId: string,
  tab: ManagerTab,
  issue?: string,
) {
  const state = navigation.getState()
  const params = { deviceId, managerId, tab, ...(issue ? { issue } : {}) }
  const below = managerRouteBelow(state.routes, state.index, deviceId, managerId)
  if (!below) return navigation.push('ManagerConsole', params)
  // 先改下面那一页的参数（落到哪一格、哪条议题），再把上面的页面一起出栈
  navigation.dispatch({ ...CommonActions.setParams(params), source: below.key })
  navigation.pop(state.index - state.routes.findIndex((route) => route.key === below.key))
}

export function useManagerOrigin(
  deviceId: string,
  sessionId: string,
  summary: SessionSummary | undefined,
): ManagerOrigin | null {
  const t = useT()
  const navigation = useNavigation<Navigation>()
  const replica = useReplica()
  const mark = summary ? managerMark(summary) : null
  const managerId = mark?.role === 'line' ? mark.managerId : null
  useEffect(() => {
    if (managerId) return replica.openManagerBoard(deviceId, managerId)
  }, [replica, deviceId, managerId])
  const manager = useKey<ManagerView>(keys.manager(deviceId, managerId ?? ''))
  const board = useKey<ManagerBoardTopicView>(keys.managerBoard(deviceId, managerId ?? ''))?.board
  const idsKey = board
    ? [...(board.posts ?? []).map((p) => p.id), ...board.items.map((i) => i.id)].join(',')
    : ''
  const ids = useMemo(() => new Set(idsKey ? idsKey.split(',') : []), [idsKey])
  const related = useMemo(
    () => (board ? lineIssues(board.relations ?? [], sessionId) : []),
    [board, sessionId],
  )
  return useMemo(() => {
    if (!managerId) return null
    const name = manager?.name || t('manager.title')
    const go = (tab: ManagerTab, issue?: string) =>
      goToManager(navigation, deviceId, managerId, tab, issue)
    const open = (id: string) => go(id.startsWith('I-') ? 'overview' : 'console', id)
    return {
      link: {
        label: `↰ ${name}`,
        accessibilityLabel: t('mgr.back', { name }),
        testID: 'detail:manager',
        onPress: () => go('lines'),
      },
      menu: [
        {
          label: t('mgr.back', { name }),
          testID: 'detail:menu:manager',
          onPress: () => go('lines'),
        },
        ...related.map((id) => ({
          label: `#${id} · ${board?.posts?.find((p) => p.id === id)?.title ?? t('manager.issue')}`,
          testID: `detail:menu:issue:${id}`,
          onPress: () => open(id),
        })),
      ],
      issues: ids.size ? { ids, open } : null,
    }
  }, [managerId, manager?.name, navigation, deviceId, related, board, ids, t])
}
