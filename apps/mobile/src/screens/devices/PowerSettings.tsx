// 与桌面共用设备设置通道；手机通过 SSH 连接不改变服务本机登记的含义。
import {
  type DevicePowerView,
  keys,
  type SettingSpecView,
  type SettingsSnapshotView,
} from '@litch/core'
import { useState } from 'react'
import { Switch, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  PLUGGED_POWER_SETTING,
  powerStatusLine,
} from '../../../../../packages/ui/src/devices/power-shortcut.ts'
import { useBusy, useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'

export function PowerSettings({
  deviceId,
  specs,
  snapshot,
}: {
  deviceId: string
  specs: readonly SettingSpecView[]
  snapshot: SettingsSnapshotView
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const state = useKey<DevicePowerView>(keys.managePower(deviceId))
  const [busy, run] = useBusy()
  const [failure, setFailure] = useState<unknown>(null)
  const toggle = async (key: string, value: boolean) => {
    setFailure(null)
    try {
      await run(
        channel.command('device.settings.write', {
          deviceId,
          expectedVersion: snapshot.version,
          edits: [{ key, value }],
        }),
      )
    } catch (error) {
      setFailure(error)
    }
  }
  return (
    <View testID="power-settings" style={{ padding: 16, gap: 12 }}>
      {state ? (
        // 状态行：正在阻止休眠用强调色、失败用出错色，同桌面
        <Text
          accessibilityRole="text"
          style={{
            color:
              state.state === 'requested'
                ? theme.c.accent
                : state.state === 'degraded'
                  ? theme.c.err
                  : theme.c.ink2,
          }}
        >
          {powerStatusLine(state, snapshot.values[PLUGGED_POWER_SETTING] === true, t)}
        </Text>
      ) : null}
      {specs.map((spec) => (
        <View key={spec.key} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text style={{ flex: 1, color: theme.c.ink }}>{t.said(spec.title)}</Text>
            <Switch
              testID={`setting:${spec.key}`}
              accessibilityLabel={t.said(spec.title)}
              value={snapshot.values[spec.key] === true}
              disabled={busy}
              trackColor={{ true: theme.c.accent, false: theme.c.line2 }}
              onValueChange={(value) => void toggle(spec.key, value)}
            />
          </View>
          <Text style={{ color: theme.c.ink3 }}>{t.said(spec.description)}</Text>
        </View>
      ))}
      {failure ? (
        <Text accessibilityRole="alert" style={{ color: theme.c.err }}>
          {whyNot(failure, t)}
        </Text>
      ) : null}
    </View>
  )
}
