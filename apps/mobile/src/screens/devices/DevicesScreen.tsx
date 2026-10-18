// 首页：设备列表。一行一台：线色、名字和主机、连接状态（没连上时一句原因）、harness 的徽标、忙闲、最近活动。
// 点一行进这台设备的会话；右边的“⋯”和长按出菜单（详情、重新连接、改名、移除）。
// 一行只订阅它自己的两个键（keys.device、keys.activity），不遍历会话。
// 应用回到前台时，没连着的设备立刻重连一次（手机切到后台时连接常被系统掐掉，不等退避的下一拍）。
// 顶上有新版本时出更新的横条（UpdateBanner）；定时查更新也挂在这一页（首页一直在栈底）。
import { type DeviceActivity, type DeviceView, keys } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState } from 'react'
import { AppState, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { ago } from '../../../../../packages/ui/src/app/format.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Empty, Row, StatusMark } from '../../ui/kit/controls'
import { Confirm, Prompt, Sheet } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { useUpdateSchedule } from '../../update/use-update'
import { reasonText, type ShownState, shownState } from './failure'
import { forgetUnusedKey } from './forget'
import { UpdateBanner } from './UpdateBanner'

type Props = NativeStackScreenProps<RootStackParamList, 'Devices'>

const MARK: Record<ShownState, Parameters<typeof StatusMark>[0]['status']> = {
  online: 'idle',
  connecting: 'running',
  reconnecting: 'running',
  offline: 'offline',
  error: 'error',
}

/** 一分钟换一次的“现在”：没有新动静的行也要把“3分”走成“4分” */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** 应用回到前台：没连着的设备都重连一次 */
function useForegroundReconnect() {
  const channel = useChannel()
  const { store } = useReplica()
  useEffect(() => {
    let last = AppState.currentState
    const subscription = AppState.addEventListener('change', (next) => {
      const back = last !== 'active' && next === 'active'
      last = next
      if (!back) return
      for (const id of store.get<string[]>(keys.devices) ?? []) {
        const device = store.get<DeviceView>(keys.device(id))
        if (device && device.connection !== 'online' && device.connection !== 'connecting') {
          void channel.command('device.reconnect', { deviceId: id }).catch(() => {})
        }
      }
    })
    return () => subscription.remove()
  }, [channel, store])
}

function DeviceRow({
  deviceId,
  now,
  onPress,
  onMenu,
}: {
  deviceId: string
  now: number
  onPress(device: DeviceView): void
  onMenu(device: DeviceView): void
}) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const activity = useKey<DeviceActivity>(keys.activity(deviceId))
  const theme = useTheme()
  const t = useT()
  if (!device) return null
  const state = shownState(device)
  const parts = [t(`devices.state.${state}`)]
  if (device.failure && state !== 'online') parts.push(reasonText(device.failure, t))
  else if (device.note && state !== 'online') parts.push(t.text(device.note))
  if (activity?.waiting) parts.push(t('devices.busy.waiting', { count: activity.waiting }))
  if (activity?.running) parts.push(t('devices.busy.running', { count: activity.running }))
  if (device.stale && state !== 'online') parts.push(t('devices.stale'))
  const badges = device.harnesses.map((harness) => harness.badge).join(' ')
  return (
    <Row
      testID={`device:${deviceId}`}
      title={t.text(device.name)}
      detail={[device.host, parts.join(' · ')].join('\n')}
      meta={[badges, activity?.lastActiveAt ? ago(activity.lastActiveAt, now, t) : '']
        .filter(Boolean)
        .join('  ')}
      left={
        <View style={styles.left}>
          <View style={[styles.wire, { backgroundColor: theme.c.wire[device.wire] }]} />
          <StatusMark status={activity?.waiting ? 'waiting' : MARK[state]} />
        </View>
      }
      right={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('devices.more')}
          testID={`device:${deviceId}:more`}
          hitSlop={8}
          style={styles.more}
          onPress={() => onMenu(device)}
        >
          <Text style={[styles.moreText, { color: theme.c.ink2 }]}>⋯</Text>
        </Pressable>
      }
      onPress={() => onPress(device)}
      onLongPress={() => onMenu(device)}
    />
  )
}

export function DevicesScreen({ navigation }: Props) {
  const t = useT()
  const channel = useChannel()
  const ids = useKey<string[]>(keys.devices) ?? []
  const now = useMinute()
  const [menu, setMenu] = useState<DeviceView | null>(null)
  const [renaming, setRenaming] = useState<DeviceView | null>(null)
  const [removing, setRemoving] = useState<DeviceView | null>(null)
  useForegroundReconnect()
  useUpdateSchedule()
  const add = () => navigation.navigate('AddDevice')
  return (
    <Screen
      title="Litch"
      back={false}
      actions={[
        { label: '＋', testID: 'devices:add', onPress: add },
        { label: '⚙', testID: 'devices:settings', onPress: () => navigation.navigate('Settings') },
      ]}
      testID="devices"
    >
      <UpdateBanner />
      <FlatList
        data={ids}
        keyExtractor={(id) => id}
        renderItem={({ item }) => (
          <DeviceRow
            deviceId={item}
            now={now}
            onPress={(device) => navigation.navigate('Sessions', { deviceId: device.id })}
            onMenu={setMenu}
          />
        )}
        ListEmptyComponent={
          <Empty
            title={t('devices.empty.title')}
            detail={t('devices.empty.detail')}
            action={<Button label={t('devices.add')} testID="devices:empty:add" onPress={add} />}
          />
        }
      />
      <Sheet
        visible={menu !== null}
        title={menu ? `${t.text(menu.name)} · ${menu.host}` : ''}
        onClose={() => setMenu(null)}
        actions={
          menu
            ? [
                {
                  label: t('devices.menu.sessions'),
                  testID: 'menu:sessions',
                  onPress: () => navigation.navigate('Sessions', { deviceId: menu.id }),
                },
                {
                  label: t('devices.menu.detail'),
                  testID: 'menu:detail',
                  onPress: () => navigation.navigate('DeviceDetail', { deviceId: menu.id }),
                },
                {
                  label: t('devices.reconnect'),
                  testID: 'menu:reconnect',
                  onPress: () => {
                    void channel.command('device.reconnect', { deviceId: menu.id })
                  },
                },
                ...(menu.kind === 'ssh'
                  ? [
                      {
                        label: t('devices.rename'),
                        testID: 'menu:rename',
                        onPress: () => setRenaming(menu),
                      },
                      {
                        label: t('devices.remove'),
                        testID: 'menu:remove',
                        danger: true,
                        onPress: () => setRemoving(menu),
                      },
                    ]
                  : []),
              ].map((action) => ({
                ...action,
                onPress: () => {
                  setMenu(null)
                  action.onPress()
                },
              }))
            : []
        }
      />
      <Prompt
        visible={renaming !== null}
        title={t('devices.rename')}
        initial={renaming ? t.text(renaming.name) : ''}
        placeholder={t('devices.nameLabel')}
        submitLabel={t('devices.save')}
        onSubmit={(name) => {
          if (renaming) void channel.command('device.update', { deviceId: renaming.id, name })
        }}
        onClose={() => setRenaming(null)}
      />
      <Confirm
        visible={removing !== null}
        danger
        title={t('devices.remove.title')}
        detail={t('devices.remove.note')}
        confirmLabel={t('devices.remove')}
        onConfirm={() => {
          if (!removing) return
          const { id, target } = removing
          void channel
            .command('device.remove', { deviceId: id })
            .then(() => forgetUnusedKey(target))
        }}
        onClose={() => setRemoving(null)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  left: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: 6 },
  wire: { width: 3, alignSelf: 'stretch' },
  more: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  moreText: { fontSize: 20 },
})
