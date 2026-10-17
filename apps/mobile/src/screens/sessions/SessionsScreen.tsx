// 一台设备上的工作区和会话（相当于桌面端侧栏里这台设备的那一段）：置顶、自定义分区、各个工作区、不属于工作区的，
// 最后是已归档（展开时才去设备上取）。整张列表只订阅分组这几个键（keys.groups、sections、workspaces、archived），
// 每一行自己订阅自己的摘要：一个会话有了动静只重画那一行。
// 长按会话出菜单（置顶、移出分区、移到别的工作区、改名、归档、删除），工作区标题的“⋯”出工作区的菜单；
// 下拉刷新是重新取一遍会话目录（device.refresh）。
import {
  type DeviceView,
  keys,
  type SectionView,
  type SessionGroups,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Confirm, Prompt, Sheet } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { DeviceBanner } from './Banner'
import { reasonOf } from './format'
import { buildList, type GroupHead, type ListItem } from './list'
import { ArchivedHead, ArchivedNote, ArchivedRow, GroupRow, SessionRow, titleOf } from './rows'
import { type Ask, type Menu, useSheet } from './useSheet'
import { WorkspaceDialog, type WorkspaceEdit } from './WorkspaceDialog'

type Props = NativeStackScreenProps<RootStackParamList, 'Sessions'>

const NO_GROUPS: SessionGroups = {}
const NO_SECTIONS: SectionView[] = []
const NO_WORKSPACES: WorkspaceView[] = []

export function SessionsScreen({ navigation, route }: Props) {
  const { deviceId } = route.params
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const channel = useChannel()
  const insets = useSafeAreaInsets()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const groups = useKey<SessionGroups>(keys.groups(deviceId)) ?? NO_GROUPS
  const sections = useKey<SectionView[]>(keys.sections(deviceId)) ?? NO_SECTIONS
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? NO_WORKSPACES
  const archived = useKey<SessionSummary[] | null>(keys.archived(deviceId)) ?? null
  const online = device?.connection === 'online'
  // 工作区那一行的“＋”要设备连着；“⋯”里的事要连着或者能整理，一件都做不了就不出
  const canMenu = online || device?.organizable === true
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [renaming, setRenaming] = useState<SessionSummary | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [workspaceEdit, setWorkspaceEdit] = useState<WorkspaceEdit | null>(null)

  const items = useMemo(
    () =>
      buildList({
        groups,
        sections,
        workspaces,
        collapsed,
        archivedOpen,
        archived,
        offline: !online,
      }),
    [groups, sections, workspaces, collapsed, archivedOpen, archived, online],
  )
  const noSessions = Object.values(groups).every((ids) => ids.length === 0)

  /** 做一件事；没做成在列表顶上说一句 */
  const act = useCallback(
    (work: Promise<unknown>) => {
      setFailure(null)
      work.catch((error: unknown) =>
        setFailure(t('session.failed', { reason: reasonOf(error, t) })),
      )
    },
    [t],
  )

  const openSession = useCallback(
    (summary: SessionSummary) =>
      navigation.navigate('Detail', {
        deviceId,
        sessionId: summary.id,
        title: titleOf(summary, t),
      }),
    [navigation, deviceId, t],
  )
  const openMenu = useCallback(
    (summary: SessionSummary) => setMenu({ kind: 'session', summary }),
    [],
  )
  const openArchived = useCallback(
    (summary: SessionSummary) => setMenu({ kind: 'archived', summary }),
    [],
  )
  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsed((before) => {
        const next = new Set(before)
        if (!next.delete(key)) next.add(key)
        return next
      }),
    [],
  )
  const newIn = useCallback(
    (head: GroupHead) =>
      navigation.navigate('NewSession', {
        deviceId,
        ...(head.kind === 'workspace' ? { workspaceId: head.workspace.id } : {}),
      }),
    [navigation, deviceId],
  )
  const workspaceOf = useCallback((head: GroupHead) => {
    if (head.kind === 'workspace') setMenu({ kind: 'workspace', workspace: head.workspace })
  }, [])
  const toggleArchived = useCallback(() => setArchivedOpen((open) => !open), [])
  // 展开着、还没取过、设备连着才去取（没连着的等连上）；取过之后核心自己跟着改
  const needArchived = archivedOpen && archived === null && online
  useEffect(() => {
    if (needArchived) act(channel.command('device.loadArchived', { deviceId }))
  }, [needArchived, act, channel, deviceId])

  const refresh = useCallback(() => {
    setRefreshing(true)
    setFailure(null)
    channel
      .command('device.refresh', { deviceId })
      .catch((error: unknown) => setFailure(t('session.failed', { reason: reasonOf(error, t) })))
      .finally(() => setRefreshing(false))
  }, [channel, deviceId, t])

  const renderItem: ListRenderItem<ListItem> = useCallback(
    ({ item }) => {
      switch (item.type) {
        case 'session':
          return (
            <SessionRow
              deviceId={deviceId}
              sessionId={item.id}
              onOpen={openSession}
              onMenu={openMenu}
            />
          )
        case 'group':
          return (
            <GroupRow
              deviceId={deviceId}
              head={item.head}
              count={item.count}
              collapsed={item.collapsed}
              onToggle={toggleGroup}
              onNew={item.head.kind === 'workspace' && online ? newIn : undefined}
              onMenu={item.head.kind === 'workspace' && canMenu ? workspaceOf : undefined}
            />
          )
        case 'archivedHead':
          return <ArchivedHead open={item.open} onToggle={toggleArchived} />
        case 'archived':
          return <ArchivedRow deviceId={deviceId} summary={item.summary} onPress={openArchived} />
        case 'archivedNote':
          return <ArchivedNote note={item.note} />
      }
    },
    [
      deviceId,
      openSession,
      openMenu,
      toggleGroup,
      newIn,
      workspaceOf,
      toggleArchived,
      openArchived,
      online,
      canMenu,
    ],
  )

  const sheet = useSheet({
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
  })

  return (
    <Screen
      title={device ? t.text(device.name) : deviceId}
      subtitle={device?.host}
      wire={device ? c.wire[device.wire] : undefined}
      actions={[
        {
          label: '＋',
          testID: 'sessions:new',
          onPress: () => navigation.navigate('NewSession', { deviceId }),
        },
        { label: '⋯', testID: 'sessions:more', onPress: () => setMenu({ kind: 'screen' }) },
      ]}
      testID="sessions"
    >
      <DeviceBanner deviceId={deviceId} />
      {failure ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint={t('sessions.failed.dismiss')}
          testID="sessions:failure"
          onPress={() => setFailure(null)}
          style={[styles.failure, { backgroundColor: c.sunken, borderBottomColor: c.err }]}
        >
          <Text style={{ color: c.err, fontSize: 13 }}>{failure}</Text>
        </Pressable>
      ) : null}
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        renderItem={renderItem}
        refreshing={refreshing}
        onRefresh={refresh}
        ListHeaderComponent={
          noSessions && workspaces.length === 0 ? (
            <Empty title={t('sessions.empty')} detail={t('sessions.empty.note')} />
          ) : null
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        testID="sessions:list"
      />
      <Sheet
        visible={menu !== null}
        title={sheet.title}
        actions={sheet.actions}
        onClose={() => setMenu(null)}
      />
      <Prompt
        visible={renaming !== null}
        title={t('session.rename')}
        initial={renaming ? titleOf(renaming, t) : ''}
        placeholder={t('session.nameLabel')}
        submitLabel={t('workspace.save')}
        onClose={() => setRenaming(null)}
        onSubmit={(title) => {
          if (renaming)
            act(channel.command('session.rename', { deviceId, sessionId: renaming.id, title }))
        }}
      />
      <Confirm
        visible={ask !== null}
        title={ask?.title ?? ''}
        detail={ask?.detail}
        confirmLabel={ask?.label ?? ''}
        danger
        onConfirm={() => ask?.run()}
        onClose={() => setAsk(null)}
      />
      <WorkspaceDialog
        deviceId={deviceId}
        edit={workspaceEdit}
        onClose={() => setWorkspaceEdit(null)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  failure: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 2 },
})
