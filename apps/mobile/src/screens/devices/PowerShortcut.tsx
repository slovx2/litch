import { type DevicePowerView, type DeviceView, keys, type SettingsSnapshotView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { Alert, Switch, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  PLUGGED_POWER_SETTING,
  powerShortcutTitle,
} from '../../../../../packages/ui/src/devices/power-shortcut.ts'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

/** 手机的 SSH 连接可操作已登记为本机的电脑；不能按手机侧的 ssh kind 隐藏它。 */
export function PowerShortcut({ device }: { device: DeviceView }) {
  const replica = useReplica()
  const channel = useChannel()
  const t = useT()
  const theme = useTheme()
  const { id: deviceId, manageable } = device
  useEffect(
    () => (manageable ? replica.openManage(deviceId) : undefined),
    [replica, deviceId, manageable],
  )
  const power = useKey<DevicePowerView | null>(keys.managePower(deviceId))
  const snapshot = useKey<SettingsSnapshotView>(keys.manageSnapshot(deviceId))
  const failure = useKey<unknown>(keys.manageError(deviceId))
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  if (!manageable || !power?.supported || !snapshot || !(PLUGGED_POWER_SETTING in snapshot.values))
    return null
  const enabled = snapshot.values[PLUGGED_POWER_SETTING] === true
  const online = device.connection === 'online'
  const toggle = async (value: boolean) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await channel.command('device.settings.write', {
        deviceId,
        expectedVersion: snapshot.version,
        edits: [{ key: PLUGGED_POWER_SETTING, value }],
      })
    } catch (error) {
      Alert.alert(t('power.quick.failed', { reason: whyNot(error, t) }))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  // 标题栏里只放闪电和开关：开着且接电（正在耗电）用等待色，开着但用电池、还没生效的淡一档；
  // 供电状态写在开关的无障碍说明和下面电源设置的状态行里，标题栏不再挤两行小字
  const tone = !enabled
    ? theme.c.ink3
    : power.powerSource === 'ac' && online
      ? theme.c.wait
      : theme.c.ink2
  return (
    <View testID="power-shortcut" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Text accessible={false} style={{ fontSize: theme.font.size.title, color: tone }}>
        ϟ
      </Text>
      <Switch
        value={enabled}
        testID="power-shortcut:switch"
        accessibilityLabel={powerShortcutTitle(power, enabled, online, t)}
        trackColor={{ true: theme.c.accent, false: theme.c.line2 }}
        disabled={busy || !online || Boolean(failure)}
        onValueChange={(value) => void toggle(value)}
      />
    </View>
  )
}
