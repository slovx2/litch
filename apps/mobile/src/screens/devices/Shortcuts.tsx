// 首页的「置顶」和「本机分组」两节。置顶区把所有设备的置顶并成一个区（资格来自设备，先后记在这台手机上），
// 置顶了的会话只在这里出现一次，设备会话列表里不再画；本机分组只存在这台手机上，可以混装各台设备的会话，
// 首页一组一行，点进组详情。手机不拖放：排先后、加入移出都在长按的动作单里。
import {
  type DeviceView,
  GROUPS_FOLD,
  keys,
  type LocalGroup,
  movePin,
  PINS_FOLD,
  type PinRef,
  pinKey,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Sheet, type SheetAction } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { titleOf } from '../sessions/rows'
import { useGroupMenu } from './GroupMenu'
import { LocalGroupName, useLocalJoin } from './LocalJoin'
import { organize, organizerBlocked, useMergedPins, useOrganizer } from './organizer-state'
import { SectionHead } from './RecentGroup'
import { ShortcutSession, ShortcutWorkspace } from './ShortcutRows'

const NONE: string[] = []

type Act = (work: Promise<unknown>) => void
type PinMenu =
  | { kind: 'session'; summary: SessionSummary; deviceId: string; ref: PinRef | null }
  | { kind: 'workspace'; workspace: WorkspaceView; deviceId: string; ref: PinRef }

export function PinsGroup({
  act,
  onOpen,
  onDevice,
}: {
  act: Act
  onOpen(summary: SessionSummary, deviceId: string): void
  onDevice(deviceId: string): void
}) {
  const t = useT()
  const channel = useChannel()
  const { store } = useReplica()
  const organizer = useOrganizer()
  const merged = useMergedPins()
  const devices = useKey<string[]>(keys.devices) ?? NONE
  const [menu, setMenu] = useState<PinMenu | null>(null)
  const join = useLocalJoin(act)
  const shown = merged.shown
  if (!organizer || shown.length === 0) return <>{join.overlays}</>
  const showDevice = devices.length > 1
  const closed = organizer.folds[PINS_FOLD] === true
  const explicit = new Set(
    shown.flatMap((ref) => (ref.kind === 'session' ? [`${ref.deviceId}\n${ref.sessionId}`] : [])),
  )
  const at = menu?.ref ? shown.findIndex((ref) => pinKey(ref) === pinKey(menu.ref as PinRef)) : -1
  const reorder = (ref: PinRef, to: number) => {
    const order = movePin(merged, ref, to)
    if (order) act(organize(channel, { type: 'pins.order', order, base: organizer.revision }))
  }
  const organizable = (deviceId: string) =>
    store.get<DeviceView>(keys.device(deviceId))?.organizable === true
  const actions = (): SheetAction[] => {
    if (!menu) return []
    const list: SheetAction[] = []
    const { ref } = menu
    if (ref && organizable(menu.deviceId)) {
      // 先让设备取消置顶，成了再清掉本机记着的位置（再置顶时当新的接在最后）
      const unpin = () =>
        menu.kind === 'session'
          ? channel.command('session.place', {
              deviceId: menu.deviceId,
              sessionId: menu.summary.id,
              place: null,
            })
          : channel.command('workspace.update', {
              deviceId: menu.deviceId,
              workspaceId: menu.workspace.id,
              pinned: false,
            })
      list.push({
        label: t(menu.kind === 'session' ? 'session.unpin' : 'workspace.unpin'),
        testID: 'menu:pins:unpin',
        onPress: () => act(unpin().then(() => organize(channel, { type: 'pins.drop', ref }))),
      })
    }
    if (ref && at > 0)
      list.push({
        label: t('organizer.up'),
        testID: 'menu:pins:up',
        onPress: () => reorder(ref, at - 1),
      })
    if (ref && at >= 0 && at < shown.length - 1)
      list.push({
        label: t('organizer.down'),
        testID: 'menu:pins:down',
        onPress: () => reorder(ref, at + 1),
      })
    if (menu.kind === 'session')
      list.push(...join.entries({ deviceId: menu.deviceId, sessionId: menu.summary.id }))
    list.push({
      label: t('organizer.open'),
      testID: 'menu:pins:device',
      onPress: () => onDevice(menu.deviceId),
    })
    return list
  }
  const sessionMenu = (summary: SessionSummary, deviceId: string) =>
    setMenu({
      kind: 'session',
      summary,
      deviceId,
      ref: explicit.has(`${deviceId}\n${summary.id}`)
        ? { kind: 'session', deviceId, sessionId: summary.id }
        : null,
    })
  return (
    <View testID="pins">
      <SectionHead
        label={t('sidebar.pinned')}
        testID="pins:head"
        collapsed={closed}
        onToggle={() => act(organize(channel, { type: 'fold', key: PINS_FOLD, closed: !closed }))}
      />
      {closed
        ? null
        : shown.map((ref) =>
            ref.kind === 'session' ? (
              <ShortcutSession
                key={pinKey(ref)}
                deviceId={ref.deviceId}
                sessionId={ref.sessionId}
                scope="pins"
                showDevice={showDevice}
                testID="pins"
                onOpen={onOpen}
                onMenu={sessionMenu}
              />
            ) : (
              <ShortcutWorkspace
                key={pinKey(ref)}
                deviceId={ref.deviceId}
                workspaceId={ref.workspaceId}
                explicit={explicit}
                showDevice={showDevice}
                onOpen={onOpen}
                onMenu={(workspace, deviceId) =>
                  setMenu({ kind: 'workspace', workspace, deviceId, ref })
                }
                onSessionMenu={sessionMenu}
              />
            ),
          )}
      <Sheet
        visible={menu !== null}
        title={
          menu ? (menu.kind === 'session' ? titleOf(menu.summary, t) : menu.workspace.name) : ''
        }
        onClose={() => setMenu(null)}
        actions={actions()}
      />
      {join.overlays}
    </View>
  )
}

/** 「本机分组」：一组一行（名字、几个对话），点进组详情，长按出组的动作单。没有组时整节不出（建组在会话的长按菜单里） */
export function LocalGroupsGroup({ act, onGroup }: { act: Act; onGroup(group: LocalGroup): void }) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const channel = useChannel()
  const organizer = useOrganizer()
  const [adding, setAdding] = useState(false)
  const menu = useGroupMenu(act)
  if (!organizer) return null
  const blocked = organizerBlocked(organizer)
  const groups = organizer.groups
  if (groups.length === 0 && !blocked) return null
  const closed = organizer.folds[GROUPS_FOLD] === true
  return (
    <View testID="localGroups">
      <SectionHead
        label={t('local.title')}
        testID="localGroups:head"
        collapsed={closed}
        onToggle={() => act(organize(channel, { type: 'fold', key: GROUPS_FOLD, closed: !closed }))}
        action={
          blocked ? undefined : (
            <Pressable
              accessibilityRole="button"
              aria-label={t('local.add')}
              testID="localGroups:add"
              onPress={() => setAdding(true)}
              style={styles.headAction}
            >
              <Text style={[styles.headActionText, { color: c.ink2 }]}>＋</Text>
            </Pressable>
          )
        }
      />
      {blocked ? (
        <Text testID="localGroups:blocked" style={[styles.note, { color: c.ink3 }]}>
          {t('organizer.blocked')}
        </Text>
      ) : null}
      {closed
        ? null
        : groups.map((group) => (
            <Pressable
              key={group.id}
              accessibilityRole="button"
              aria-label={`${group.name} · ${t('organizer.count', { count: group.members.length })}`}
              testID={`localGroups:${group.id}`}
              onPress={() => onGroup(group)}
              onLongPress={blocked ? undefined : () => menu.open(group)}
              style={({ pressed }) => [
                styles.group,
                {
                  minHeight: theme.hit,
                  borderBottomColor: c.line1,
                  backgroundColor: pressed ? c.press : c.panel,
                },
              ]}
            >
              <Text numberOfLines={1} style={[styles.name, { color: c.ink }]}>
                {group.name}
              </Text>
              <Text style={[styles.count, { color: c.ink3, fontFamily: theme.font.mono }]}>
                {group.members.length}
              </Text>
              <Text style={[styles.count, { color: c.ink3 }]}>›</Text>
            </Pressable>
          ))}
      <LocalGroupName
        visible={adding}
        initial=""
        onSubmit={(name) => act(organize(channel, { type: 'group.create', name }))}
        onClose={() => setAdding(false)}
      />
      {menu.overlays}
    </View>
  )
}

const styles = StyleSheet.create({
  headAction: { width: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  headActionText: { fontSize: 18, fontWeight: '600' },
  note: { paddingHorizontal: 16, paddingVertical: 10, fontSize: 12 },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 32,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  name: { flex: 1, fontSize: 14 },
  count: { fontSize: 12 },
})
