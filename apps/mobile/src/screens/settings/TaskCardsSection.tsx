// 设置里的“任务卡”：和桌面设置页“按 harness 开关”同一棵树，只有任务卡一列（手机不执行浏览器和 Computer Use）。
// 每台设备一行“名字　4/5 已开 ›”，点了出选择单：它启用着的各 harness 逐个勾（设置里停用的不列，启用后出现、值照旧；
// 勾了单不收起），最后一项“全部开启 / 全部关闭”按设备那一格算出来的三态把列出来的各 harness 一起设。
// 任务卡存在设备上（设备设置 harness.<id>.taskCards），写入走设备设置的写入，要带版本号：开着这一页时订阅能管理的设备的设置，
// 核心也靠这份订阅给出现值。离线、旧设备服务没有这一项的只读（一条横线）。判断和桌面共用 harness-switches-logic.ts。
import { type DeviceView, keys, type SettingsSnapshotView, taskCardsSettingKey } from '@litch/core'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import {
  deviceCell,
  editable,
  harnessCell,
  harnessRows,
  nextForDevice,
  taskCardTargets,
} from '../../../../../packages/ui/src/settings/harness-switches-logic.ts'
import { useBusy, useChannel, useKey, useReplica } from '../../shell/services'
import { type Key, useT } from '../../ui/i18n'
import { ValueRow } from '../../ui/kit/controls'
import { Sheet, type SheetAction } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

const NO_DEVICES: readonly string[] = []

export function TaskCardsSection() {
  const ids = useKey<string[]>(keys.devices) ?? NO_DEVICES
  const { c } = useTheme()
  if (ids.length === 0) return null
  return (
    <View testID="settings:task-cards" style={[styles.group, { borderColor: c.line2 }]}>
      {ids.map((id) => (
        <DeviceRow key={id} deviceId={id} />
      ))}
    </View>
  )
}

function DeviceRow({ deviceId }: { deviceId: string }) {
  const t = useT()
  const { c } = useTheme()
  const channel = useChannel()
  const replica = useReplica()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const snapshot = useKey<SettingsSnapshotView>(keys.manageSnapshot(deviceId))
  const [open, setOpen] = useState(false)
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
    if (busy || !snapshot || harnesses.length === 0) return
    setFailure(null)
    run(
      channel.command('device.settings.write', {
        deviceId,
        expectedVersion: snapshot.version,
        edits: harnesses.map((id) => ({ key: taskCardsSettingKey(id), value: on })),
      }),
    ).catch((error: unknown) => setFailure(t('switches.failed', { reason: reasonOf(error, t) })))
  }

  const whole = deviceCell(device, 'taskCards')
  const states = rows.map((row) => harnessCell(row.switches, 'taskCards'))
  // 行上的值：开了几个；读不到（离线、旧设备服务、还在读）写一条横线，原因在选择单里每一项上
  const value =
    rows.length === 0
      ? '–'
      : whole === 'unknown'
        ? offline
          ? t('switches.offline')
          : '–'
        : t('sessions.settings.cards.count', {
            on: states.filter((state) => state === 'on').length,
            n: rows.length,
          })
  // 改不了的项写原因；正在写的那一下不另写字，点了不理（写入要带版本号，不能叠着写）
  const lockedFor = (state: Parameters<typeof editable>[2]) =>
    editable(device, 'taskCards', state) ? undefined : t(why)
  const turnOn = nextForDevice(whole)
  const locked = lockedFor(whole)
  const actions: SheetAction[] = [
    ...rows.map((row, index) => {
      const state = states[index] ?? 'unknown'
      const reason = lockedFor(state)
      return {
        label: t.harness(row.id, row.name),
        checked: state === 'on',
        stay: true,
        testID: `task-cards:${deviceId}:${row.id}`,
        ...(reason ? { disabled: reason } : {}),
        onPress: () => write([row.id], state !== 'on'),
      }
    }),
    ...(rows.length > 1
      ? [
          {
            label: t(turnOn ? 'sessions.settings.cards.allOn' : 'sessions.settings.cards.allOff'),
            stay: true,
            testID: `task-cards:${deviceId}:device`,
            ...(locked ? { disabled: locked } : {}),
            onPress: () => write(taskCardTargets(device), turnOn),
          },
        ]
      : []),
  ]
  return (
    <View testID={`task-cards:${deviceId}`}>
      <ValueRow
        title={name}
        value={value}
        onPress={() => setOpen(true)}
        testID={`task-cards:${deviceId}:open`}
      />
      <Sheet
        visible={open && rows.length > 0}
        title={t('switches.cell', { name, column: t('switches.col.taskCards') })}
        {...(rows.length > 1 ? { note: t('sessions.settings.cards.note') } : {})}
        actions={actions}
        onClose={() => setOpen(false)}
      />
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
  failure: { paddingHorizontal: 16, paddingVertical: 6, fontSize: 12 },
})
