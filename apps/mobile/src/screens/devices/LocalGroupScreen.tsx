// 一个本机分组的详情：组里的会话按组里的先后排，混着各台设备（左边线色、第二行设备名）。
// 长按一行：上移、下移、移出本组、换到别的组；标题栏的“⋯”是组的动作单（改名、上下移、删除）。
// 置顶了的成员只在首页置顶区出现，这里只数一下；会话不在了（归档、删除、设备没配、目录没到）的成员留一行说明，
// 不自动清掉，由人决定移出。平板上它是左栏的目录页，右栏照旧是当前会话。
import {
  type DeviceView,
  keys,
  memberState,
  type SessionRef,
  type SessionSummary,
} from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Sheet, type SheetAction } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { titleOf } from '../sessions/rows'
import { useGroupMenu } from './GroupMenu'
import { useLocalJoin } from './LocalJoin'
import { organize, organizerBlocked, useKeyList, useOrganizer } from './organizer-state'
import { ShortcutSession, useDeviceNote } from './ShortcutRows'

type Props = NativeStackScreenProps<RootStackParamList, 'LocalGroup'>

const NO_IDS: string[] = []

export function LocalGroupScreen({ navigation, route }: Props) {
  const { groupId } = route.params
  const t = useT()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const channel = useChannel()
  const organizer = useOrganizer()
  const devices = useKey<string[]>(keys.devices) ?? NO_IDS
  const [failure, setFailure] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ ref: SessionRef; title: string } | null>(null)
  const act = useCallback(
    (work: Promise<unknown>) => {
      setFailure(null)
      work.catch((error: unknown) =>
        setFailure(t('session.failed', { reason: reasonOf(error, t) })),
      )
    },
    [t],
  )
  const join = useLocalJoin(act)
  const groupMenu = useGroupMenu(act, () => navigation.goBack())
  const group = organizer?.groups.find((entry) => entry.id === groupId)
  const blocked = organizerBlocked(organizer)
  const members = group?.members ?? []
  const covers = useKeyList<string[]>(devices.map(keys.pinCover))
  // 置顶区里有的成员：这里不画，只数一下
  const covered = (ref: SessionRef) =>
    covers[devices.indexOf(ref.deviceId)]?.includes(ref.sessionId) === true
  const pinned = members.filter(covered).length
  const showDevice = devices.length > 1
  const at = menu
    ? members.findIndex(
        (m) => m.deviceId === menu.ref.deviceId && m.sessionId === menu.ref.sessionId,
      )
    : -1
  const actions = (): SheetAction[] => {
    if (!menu || blocked) return []
    const { ref } = menu
    const list: SheetAction[] = []
    if (at > 0)
      list.push({
        label: t('organizer.up'),
        testID: 'menu:member:up',
        onPress: () => act(organize(channel, { type: 'member.move', member: ref, to: at - 1 })),
      })
    if (at >= 0 && at < members.length - 1)
      list.push({
        label: t('organizer.down'),
        testID: 'menu:member:down',
        onPress: () => act(organize(channel, { type: 'member.move', member: ref, to: at + 1 })),
      })
    list.push({
      label: t('organizer.leave'),
      testID: 'menu:member:leave',
      onPress: () => act(organize(channel, { type: 'member.remove', member: ref })),
    })
    // 换到别的组（“加入本机分组”里不列现在这一组）
    list.push(...join.entries(ref).filter((entry) => entry.testID === 'menu:local'))
    list.push({
      label: t('organizer.open'),
      testID: 'menu:member:device',
      onPress: () => navigation.navigate('Sessions', { deviceId: ref.deviceId }),
    })
    return list
  }
  const title = group?.name ?? route.params.title ?? ''
  return (
    <Screen
      title={title}
      subtitle={t('local.title')}
      actions={
        group && !blocked
          ? [{ label: '⋯', testID: 'localGroup:more', onPress: () => groupMenu.open(group) }]
          : []
      }
      testID="localGroup"
    >
      {failure ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint={t('sessions.failed.dismiss')}
          testID="localGroup:failure"
          onPress={() => setFailure(null)}
          style={[styles.failure, { backgroundColor: c.sunken, borderBottomColor: c.err }]}
        >
          <Text style={{ color: c.err, fontSize: 13 }}>{failure}</Text>
        </Pressable>
      ) : null}
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        {!group ? (
          <Empty title={t('fault.localGroupGone')} />
        ) : members.length === 0 ? (
          <Text testID="localGroup:empty" style={[styles.note, { color: c.ink3 }]}>
            {t('organizer.empty')}
          </Text>
        ) : (
          members
            .filter((member) => !covered(member))
            .map((member) => (
              <Member
                key={`${member.deviceId}\n${member.sessionId}`}
                member={member}
                showDevice={showDevice}
                onOpen={(summary, deviceId) =>
                  navigation.navigate('Detail', {
                    deviceId,
                    sessionId: summary.id,
                    title: titleOf(summary, t),
                  })
                }
                onMenu={(title) => setMenu({ ref: member, title })}
                onArchived={() => navigation.navigate('Sessions', { deviceId: member.deviceId })}
              />
            ))
        )}
        {pinned > 0 ? (
          <Text testID="localGroup:pinned" style={[styles.note, { color: c.ink3 }]}>
            {t('local.pinnedMore', { count: pinned })}
          </Text>
        ) : null}
      </ScrollView>
      <Sheet
        visible={menu !== null}
        title={menu?.title}
        onClose={() => setMenu(null)}
        actions={actions()}
      />
      {join.overlays}
      {groupMenu.overlays}
    </Screen>
  )
}

/** 组里的一个会话（置顶了的上面已经滤掉）：在就照常画（连同子会话）；不在了留一行说明 */
function Member({
  member,
  showDevice,
  onOpen,
  onMenu,
  onArchived,
}: {
  member: SessionRef
  showDevice: boolean
  onOpen(summary: SessionSummary, deviceId: string): void
  onMenu(title: string): void
  onArchived(): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const { deviceId, sessionId } = member
  const device = useKey<DeviceView>(keys.device(deviceId))
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const archived = useKey<SessionSummary[] | null>(keys.archived(deviceId)) ?? null
  const where = useDeviceNote(device, showDevice)
  const state = memberState(member, {
    device,
    listed: summary !== undefined,
    covered: false,
    archived: archived ? archived.map((entry) => entry.id) : null,
  })
  if (state === 'ok')
    return (
      <ShortcutSession
        deviceId={deviceId}
        sessionId={sessionId}
        scope="local"
        showDevice={showDevice}
        testID="localGroup"
        onOpen={onOpen}
        onMenu={(entry) => onMenu(titleOf(entry, t))}
      />
    )
  // 置顶了的成员上面已经滤掉，这里不会是 pinned
  const label = t(`local.member.${state === 'pinned' ? 'missing' : state}`)
  const archivedSummary = archived?.find((entry) => entry.id === sessionId)
  const name = archivedSummary ? titleOf(archivedSummary, t) : label
  return (
    <Pressable
      accessibilityRole="button"
      aria-label={[...new Set([name, label]), where].filter(Boolean).join(' · ')}
      testID={`localGroup:ghost:${sessionId}`}
      onPress={state === 'archived' ? onArchived : () => onMenu(name)}
      onLongPress={() => onMenu(name)}
      style={({ pressed }) => [
        styles.ghost,
        {
          minHeight: theme.hit,
          borderBottomColor: c.line1,
          backgroundColor: pressed ? c.press : c.panel,
        },
      ]}
    >
      <View style={[styles.wire, { backgroundColor: device ? c.wire[device.wire] : c.line2 }]} />
      <Text numberOfLines={1} style={[styles.ghostName, { color: c.ink2 }]}>
        {name}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.ghostNote, { color: c.ink3, fontFamily: theme.font.mono }]}
      >
        {[archivedSummary ? label : '', where].filter(Boolean).join(' · ')}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  failure: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 2 },
  note: { paddingHorizontal: 16, paddingVertical: 14, fontSize: 13 },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  wire: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  ghostName: { flexShrink: 1, fontSize: 14, fontStyle: 'italic' },
  ghostNote: { flex: 1, fontSize: 11, textAlign: 'right' },
})
