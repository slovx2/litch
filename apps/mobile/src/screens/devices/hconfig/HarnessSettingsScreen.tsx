// 一台设备上一个 harness 的详情设置（15 号设计，决 317）：从设备详情里那个 harness 的“详情设置”进来。
// 四块各占一个标签：配置（能改）、账号（登录、API key、切换 provider、自定义 provider）、MCP 和指令文件（只能看）。
// 内容全按对面的声明画，界面不认识哪一项是干什么的。改过要重启才生效的，顶上一直提示，可以就地重启。
// 开着这一页才订阅（harnessConfig 主题），核心这时才去设备上读。
import type { DeviceView } from '@litch/core'
import { keys } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { whyNot } from '../../../../../../packages/ui/src/app/errors.ts'
import type { RootStackParamList } from '../../../nav/routes'
import { useChannel, useKey } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Chip } from '../../../ui/kit/controls'
import { Confirm } from '../../../ui/kit/overlays'
import { Screen } from '../../../ui/kit/Screen'
import { useTheme } from '../../../ui/theme'
import { AccountsTab } from './AccountsTab'
import { ConfigTab } from './ConfigTab'
import { pageState } from './logic'
import { Note, SaidNote, useHarnessConfig, useSaid } from './parts'
import { InstructionsTab, McpTab } from './ReadOnlyTabs'

type Props = NativeStackScreenProps<RootStackParamList, 'HarnessSettings'>
type Tab = 'config' | 'accounts' | 'mcp' | 'instructions'
const TABS: readonly Tab[] = ['config', 'accounts', 'mcp', 'instructions']

export function HarnessSettingsScreen({ route }: Props) {
  const { deviceId, harness: harnessId } = route.params
  const theme = useTheme()
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const view = useHarnessConfig(deviceId, harnessId)
  const [tab, setTab] = useState<Tab>('config')
  const name =
    device?.harnesses.find((entry) => entry.id === harnessId)?.name ??
    route.params.name ??
    harnessId
  const state = pageState(view)
  const ready = state === 'ready' && view !== undefined && view !== 'error' ? view : null

  let body = null
  if (ready) {
    body =
      tab === 'config' ? (
        <ConfigTab deviceId={deviceId} harnessId={harnessId} slot={ready.config} />
      ) : tab === 'accounts' ? (
        <AccountsTab deviceId={deviceId} harnessId={harnessId} view={ready} />
      ) : tab === 'mcp' ? (
        <McpTab deviceId={deviceId} harnessId={harnessId} slot={ready.mcp} />
      ) : (
        <InstructionsTab deviceId={deviceId} harnessId={harnessId} slot={ready.instructions} />
      )
  } else {
    body = (
      <Note
        testID={`hc:state:${state}`}
        tone={state === 'loading' ? 'dim' : 'plain'}
        text={
          state === 'loading'
            ? t('manage.loading')
            : state === 'offline'
              ? t('hc.offline')
              : t('hc.unsupported', { name })
        }
      />
    )
  }
  return (
    <Screen
      title={t('hc.title', { name })}
      subtitle={device ? t.text(device.name) : undefined}
      wire={device ? theme.c.wire[device.wire] : undefined}
      testID="harness-settings"
    >
      {ready ? (
        <>
          {ready.restartRequired ? (
            <RestartBanner deviceId={deviceId} harnessId={harnessId} name={name} />
          ) : null}
          <View
            style={[
              styles.tabs,
              { borderBottomColor: theme.c.line1, backgroundColor: theme.c.panel },
            ]}
          >
            {TABS.map((one) => (
              <Chip
                key={one}
                label={t(`hc.tab.${one}`)}
                on={tab === one}
                testID={`hc:tab:${one}:pick`}
                onPress={() => setTab(one)}
              />
            ))}
          </View>
        </>
      ) : null}
      <View style={styles.fill}>{body}</View>
    </Screen>
  )
}

/** 改过要重启才生效：一直提示，可以就地重启。有回合在跑时问一声要不要照样重启 */
function RestartBanner({
  deviceId,
  harnessId,
  name,
}: {
  deviceId: string
  harnessId: string
  name: string
}) {
  const theme = useTheme()
  const t = useT()
  const channel = useChannel()
  const { said, setSaid, busy, run } = useSaid()
  const [asking, setAsking] = useState(false)
  const restart = async (force: boolean) => {
    setSaid(null)
    try {
      const result = await channel.command('device.harness.restart', {
        deviceId,
        harness: harnessId,
        ...(force ? { force: true } : {}),
      })
      setSaid(
        result.running
          ? { text: t('manage.restart.done', { name }), bad: false }
          : {
              text: t('manage.restart.down', {
                name,
                reason: result.text ? t.said(result.text) : t('harness.unavailable'),
              }),
              bad: true,
            },
      )
    } catch (error) {
      if (!force && (error as { code?: string } | null)?.code === 'busy') {
        setAsking(true)
        return
      }
      setSaid({ text: t('manage.restart.failed', { name, reason: whyNot(error, t) }), bad: true })
    }
  }
  return (
    <View style={[styles.banner, { borderBottomColor: theme.c.wait }]} testID="hc:restart">
      <Note text={t('hc.restart.note', { name })} tone="wait" />
      <View style={styles.bannerActs}>
        <Button
          label={t(busy ? 'manage.restarting' : 'hc.restart.now')}
          busy={busy}
          testID="hc:restart:now"
          onPress={() => void run(() => restart(false))}
        />
      </View>
      <SaidNote said={said} />
      <Confirm
        visible={asking}
        danger
        title={t('manage.restart.busy.title', { name })}
        detail={t('manage.restart.busy.note')}
        confirmLabel={t('manage.restart.busy.yes')}
        onConfirm={() => void run(() => restart(true))}
        onClose={() => setAsking(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  banner: { borderBottomWidth: 1, paddingBottom: 8 },
  bannerActs: { flexDirection: 'row', paddingHorizontal: 16 },
})
