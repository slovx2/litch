// 设置里的“任务卡”：和桌面设置页“按 harness 开关”同一棵树，只有任务卡一列（手机不执行浏览器和 Computer Use）。
// 每台设备一行（点名字展开、收起），下面是它启用着的各 harness（设置里停用的不列，启用后出现、值照旧）；
// 设备那一格是算出来的三态，点了把列出来的各 harness 一起设。
// 任务卡存在设备上（设备设置 harness.<id>.taskCards），写入走设备设置的写入，要带版本号：开着这一页时订阅能管理的设备的设置，
// 核心也靠这份订阅给出现值。离线、旧设备服务没有这一项的只读（一条横线）。判断和桌面共用 harness-switches-logic.ts。
import { type DeviceView, keys, type SettingsSnapshotView, taskCardsSettingKey } from '@litch/core'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import {
  type CellState,
  deviceCell,
  editable,
  harnessCell,
  harnessRows,
  nextForDevice,
  taskCardTargets,
} from '../../../../../packages/ui/src/settings/harness-switches-logic.ts'
import { useBusy, useChannel, useKey, useReplica } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

const NO_DEVICES: readonly string[] = []

export function TaskCardsSection() {
  const ids = useKey<string[]>(keys.devices) ?? NO_DEVICES
  const { c } = useTheme()
  if (ids.length === 0) return null
  return (
    <View testID="settings:task-cards" style={[styles.group, { borderColor: c.line2 }]}>
      {ids.map((id) => (
        <DeviceRows key={id} deviceId={id} />
      ))}
    </View>
  )
}

function DeviceRows({ deviceId }: { deviceId: string }) {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const channel = useChannel()
  const replica = useReplica()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const snapshot = useKey<SettingsSnapshotView>(keys.manageSnapshot(deviceId))
  const [open, setOpen] = useState(true)
  const [busy, run] = useBusy()
  const [failure, setFailure] = useState<string | null>(null)
  const manageable = device?.manageable === true
  useEffect(
    () => (manageable ? replica.openManage(deviceId) : undefined),
    [replica, deviceId, manageable],
  )
  if (!device) return null
  const name = t.text(device.name)
  const rows = harnessRows(device)
  const offline = device.connection !== 'online'
  const why: Key = offline
    ? 'switches.unknown.offline'
    : !manageable || snapshot
      ? 'switches.unknown.old'
      : 'switches.unknown.loading'

  const write = (harnesses: string[], on: boolean) => {
    if (!snapshot || harnesses.length === 0) return
    setFailure(null)
    run(
      channel.command('device.settings.write', {
        deviceId,
        expectedVersion: snapshot.version,
        edits: harnesses.map((id) => ({ key: taskCardsSettingKey(id), value: on })),
      }),
    ).catch((error: unknown) => setFailure(t('switches.failed', { reason: reasonOf(error, t) })))
  }

  const mark = (state: CellState, label: string, onPress: () => void, testID: string) => {
    const locked = busy || !editable(device, 'taskCards', state)
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={state === 'unknown' ? `${label} — ${t(why)}` : label}
        accessibilityState={{
          checked: state === 'mixed' ? 'mixed' : state === 'on',
          disabled: locked,
        }}
        disabled={locked}
        hitSlop={8}
        testID={testID}
        onPress={onPress}
        style={({ pressed }) => [styles.mark, pressed ? { backgroundColor: c.press } : null]}
      >
        <Text
          style={[styles.markText, { color: locked ? c.ink3 : c.ink, fontFamily: theme.font.mono }]}
        >
          {state === 'unknown' ? ' – ' : theme.check[state]}
        </Text>
      </Pressable>
    )
  }

  const column = t('switches.col.taskCards')
  const whole = deviceCell(device, 'taskCards')
  return (
    <View testID={`task-cards:${deviceId}`}>
      <View
        style={[
          styles.row,
          { minHeight: theme.hit, borderBottomColor: c.line1, backgroundColor: c.panel },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={t(open ? 'switches.collapse' : 'switches.expand', { name })}
          disabled={rows.length === 0}
          onPress={() => setOpen(!open)}
          style={styles.grow}
        >
          <Text style={[styles.device, { color: c.ink }]} numberOfLines={1}>
            <Text style={{ color: c.ink3, fontFamily: theme.font.mono }}>
              {rows.length === 0 ? '  ' : open ? '▾ ' : '▸ '}
            </Text>
            {name}
            {offline ? <Text style={{ color: c.ink3 }}>{`  ${t('switches.offline')}`}</Text> : null}
          </Text>
        </Pressable>
        {mark(
          whole,
          t('switches.cell.device', { name, column }),
          () => write(taskCardTargets(device), nextForDevice(whole)),
          `task-cards:${deviceId}:device`,
        )}
      </View>
      {open
        ? rows.map((row) => {
            const state = harnessCell(row.switches, 'taskCards')
            return (
              <View
                key={row.id}
                style={[
                  styles.row,
                  styles.harness,
                  { minHeight: theme.hit, borderBottomColor: c.line1, backgroundColor: c.panel },
                ]}
              >
                <Text
                  style={[styles.grow, styles.harnessName, { color: c.ink2 }]}
                  numberOfLines={1}
                >
                  {row.name}
                </Text>
                {mark(
                  state,
                  t('switches.cell', { name: `${name} · ${row.name}`, column }),
                  () => write([row.id], state !== 'on'),
                  `task-cards:${deviceId}:${row.id}`,
                )}
              </View>
            )
          })
        : null}
      {failure ? (
        <Text accessibilityRole="alert" style={[styles.failure, { color: c.err }]}>
          {failure}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  group: { borderTopWidth: 1, borderBottomWidth: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  harness: { paddingLeft: 36 },
  grow: { flex: 1, minWidth: 0 },
  device: { fontSize: 15, fontWeight: '600' },
  harnessName: { fontSize: 15 },
  mark: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 4 },
  markText: { fontSize: 14 },
  failure: { paddingHorizontal: 16, paddingVertical: 6, fontSize: 12 },
})
