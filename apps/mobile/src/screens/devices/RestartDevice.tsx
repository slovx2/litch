// 重启设备服务（设备列表的菜单里那一项）：一个对话框从头陪到尾。手机上没有一闪而过的提示，进度和结果都在这里说。
// 做法和桌面端一样（packages/ui/src/devices/RestartService.tsx）：先问核心会打断哪些会话，有就列出来确认，
// 确认了不等空闲直接停；没有就空闲时停，服务说不闲时列出原因再问一次。状态机在核心（device/service-restart.mts）。
// 现在做不了的（没连上、服务有别的东西管着）也打开这个框，说明原因。
import { type DeviceView, keys, type ServiceRestartSession } from '@litch/core'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { nameOf } from '../../../../../packages/ui/src/app/device.ts'
import {
  busyLine,
  restartFailureKey,
  restarting,
} from '../../../../../packages/ui/src/devices/service.ts'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

/** 确认框里最多列几个会话，多的说“另有几个” */
const LISTED = 8

type Mode = 'start' | 'force' | 'dismiss'

export function RestartDevice({
  deviceId,
  onClose,
}: {
  /** 要重启的设备；null 是不显示 */
  deviceId: string | null
  onClose(): void
}) {
  const t = useT()
  const theme = useTheme()
  const channel = useChannel()
  const device = useKey<DeviceView>(keys.device(deviceId ?? ''))
  /** 列出来等确认的会话。null：没在问 */
  const [asking, setAsking] = useState<ServiceRestartSession[] | null>(null)
  /** 已经发出去了：之后照核心给的进度和结果说 */
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const send = (mode: Mode) => {
    if (!deviceId) return
    if (mode !== 'dismiss') setSent(true)
    channel.command('device.restartService', { deviceId, mode }).catch((failed: unknown) => {
      setError(failed instanceof Error ? failed.message : String(failed))
    })
  }

  // 打开时：做得了的先问会打断哪些会话
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换了设备（打开）时做一次
  useEffect(() => {
    setAsking(null)
    setSent(false)
    setError(null)
    if (!deviceId || !device?.restart || device.restart.blocked !== null || restarting(device)) {
      return
    }
    setChecking(true)
    channel.command('device.restartSessions', { deviceId }).then(
      ({ sessions }) => {
        setChecking(false)
        if (sessions.length > 0) setAsking(sessions)
        else send('start')
      },
      (failed: unknown) => {
        setChecking(false)
        setError(failed instanceof Error ? failed.message : String(failed))
      },
    )
  }, [deviceId])

  if (!deviceId || !device?.restart) return null
  const view = device.restart
  const name = t.text(device.name)
  const phase = view.phase
  /** 关上：做完了的结果、等决定的那一步一起收起 */
  const close = () => {
    if (sent && (phase.step === 'done' || phase.step === 'failed' || phase.step === 'busy')) {
      send('dismiss')
    }
    onClose()
  }
  const title = (text: string) => <Text style={[styles.title, { color: theme.c.ink }]}>{text}</Text>
  const line = (text: string, testID?: string) => (
    <Text style={[styles.detail, { color: theme.c.ink2 }]} testID={testID}>
      {text}
    </Text>
  )
  const ok = (label = t('devices.restart.ok')) => (
    <View style={styles.buttons}>
      <Button label={label} testID="restart:ok" onPress={close} />
    </View>
  )
  const body = (() => {
    if (error) return [title(t('restart.menu')), line(error, 'restart:error'), ok()]
    if (asking) {
      return [
        title(t('restart.confirm.title', { name })),
        line(t('restart.confirm.note')),
        ...asking
          .slice(0, LISTED)
          .map((entry) =>
            line(
              `· ${t.text(entry.title)} · ${
                entry.running
                  ? t('restart.confirm.turn')
                  : t('restart.confirm.background', { count: entry.background })
              }`,
              `restart:session:${entry.id}`,
            ),
          ),
        ...(asking.length > LISTED
          ? [line(t('restart.confirm.more', { count: asking.length - LISTED }))]
          : []),
        <View key="buttons" style={styles.buttons}>
          <Button kind="plain" label={t('restart.confirm.no')} onPress={onClose} />
          <Button
            kind="danger"
            label={t('restart.confirm.yes')}
            testID="restart:yes"
            onPress={() => {
              setAsking(null)
              send('force')
            }}
          />
        </View>,
      ]
    }
    if (!sent && view.blocked !== null && !restarting(device)) {
      return [title(t('restart.menu')), line(t(`restart.blocked.${view.blocked}`)), ok()]
    }
    if (phase.step === 'busy') {
      return [
        title(t('restart.busy.title', { name })),
        line(t('restart.busy.note')),
        ...phase.busy.map((entry) => {
          const said = busyLine(entry, (id) => nameOf(device, id), t('list.comma'))
          return line(`· ${t(said.key, said.args)}`, `restart:busy:${entry.reason}`)
        }),
        <View key="buttons" style={styles.buttons}>
          <Button kind="plain" label={t('restart.confirm.no')} onPress={close} />
          <Button
            kind="danger"
            label={t('restart.busy.yes')}
            testID="restart:force"
            onPress={() => send('force')}
          />
        </View>,
      ]
    }
    if (sent && phase.step === 'done') {
      return [
        title(t('restart.menu')),
        line(
          phase.interrupted > 0
            ? t('restart.done.interrupted', { name, count: phase.interrupted })
            : t('restart.done', { name }),
          'restart:done',
        ),
        ok(),
      ]
    }
    if (sent && phase.step === 'failed') {
      const reason = t(restartFailureKey(phase.reason))
      const said = phase.text ? t.text(phase.text) : null
      return [
        title(t('restart.menu')),
        line(
          t('restart.failed', {
            name,
            reason: said ? t('restart.failed.because', { reason, said }) : reason,
          }),
          'restart:failed',
        ),
        ok(),
      ]
    }
    // 正在问、正在停、正在重连：关上不打断，进度在设备那一行上也看得到
    return [
      title(t('restart.menu')),
      line(
        checking ? t('restart.menu.busy') : t('devices.restart.running', { name }),
        'restart:running',
      ),
      ok(t('devices.restart.close')),
    ]
  })()
  return (
    <Dialog visible onClose={close}>
      {body.map((node, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 每一屏的几行固定，位置就是身份
        <View key={index}>{node}</View>
      ))}
    </Dialog>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600' },
  detail: { fontSize: 14, lineHeight: 20 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
})
