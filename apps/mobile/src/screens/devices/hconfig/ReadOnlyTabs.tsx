// MCP 和指令文件两块：手机上只能看（决 317），改在桌面端做，页面顶上说一句。
// MCP：一个服务一块，名字、连接方式、启没启用、连接状态，本地命令给命令和参数、远程给地址。
// 指令文件：路径、是不是软链（指向哪里）、有没有更高优先级的文件盖住它、全文（可以选中复制）。
import type { HcInstructionsView, HcMcpServer, HcMcpView, HcSlot } from '@litch/core'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { useTheme } from '../../../ui/theme'
import { Files, Note, SlotState } from './parts'

type Part = 'mcp' | 'instructions'

function useReload(deviceId: string, harnessId: string, part: Part): () => void {
  const channel = useChannel()
  return () =>
    void channel
      .command('harnessConfig.reload', { deviceId, harness: harnessId, part })
      .catch(() => {})
}

export function McpTab({
  deviceId,
  harnessId,
  slot,
}: {
  deviceId: string
  harnessId: string
  slot: HcSlot<HcMcpView>
}) {
  const t = useT()
  const reload = useReload(deviceId, harnessId, 'mcp')
  const data = slot.data
  if (!data) return <SlotState slot={slot} onRetry={reload} />
  return (
    <ScrollView testID="hc:tab:mcp">
      <Note text={t('hcm.readonly.mcp')} tone="wait" testID="hc:readonly" />
      {data.servers.length === 0 ? (
        <Note text={t('hc.mcp.empty')} tone="dim" testID="hc:mcp:empty" />
      ) : (
        data.servers.map((server) => <McpRow key={server.name} server={server} />)
      )}
      <Files files={data.files} />
    </ScrollView>
  )
}

const STATE_TONE = {
  connected: 'ok',
  failed: 'err',
  needsAuth: 'wait',
  disabled: 'ink3',
  unknown: 'ink3',
} as const

function McpRow({ server }: { server: HcMcpServer }) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const remote = server.transport !== 'stdio'
  const state = server.status?.state ?? null
  const where = remote
    ? (server.url ?? '')
    : [server.command ?? '', ...server.args].filter(Boolean).join(' ')
  const envNames = Object.keys(server.env)
  return (
    <View style={[styles.row, { borderBottomColor: c.line1 }]} testID={`hc:mcp:${server.name}`}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.ink }]} numberOfLines={1}>
          {server.name}
          <Text style={{ color: c.ink3, fontFamily: theme.font.mono, fontSize: 12 }}>
            {'  '}
            {t(`hc.mcp.transport.${server.transport}`)}
          </Text>
        </Text>
        <Text style={[styles.small, { color: server.enabled ? c.ok : c.ink3 }]}>
          {t(server.enabled ? 'hcm.mcp.on' : 'hcm.mcp.off')}
        </Text>
      </View>
      {state ? (
        <Text style={[styles.small, { color: c[STATE_TONE[state]] }]}>
          {t(`hc.mcp.status.${state}`)}
          {server.status?.message ? ` · ${server.status.message}` : ''}
        </Text>
      ) : null}
      {where ? (
        <Text
          selectable
          numberOfLines={3}
          style={[styles.small, { color: c.ink2, fontFamily: theme.font.mono }]}
        >
          {where}
        </Text>
      ) : null}
      {!remote && server.cwd ? (
        <Text style={[styles.small, { color: c.ink3 }]}>
          {t('hc.mcp.cwd')}: <Text style={{ fontFamily: theme.font.mono }}>{server.cwd}</Text>
        </Text>
      ) : null}
      {envNames.length > 0 ? (
        <Text style={[styles.small, { color: c.ink3 }]} numberOfLines={2}>
          {t('hc.mcp.env')}:{' '}
          <Text style={{ fontFamily: theme.font.mono }}>{envNames.join(', ')}</Text>
        </Text>
      ) : null}
    </View>
  )
}

export function InstructionsTab({
  deviceId,
  harnessId,
  slot,
}: {
  deviceId: string
  harnessId: string
  slot: HcSlot<HcInstructionsView>
}) {
  const theme = useTheme()
  const t = useT()
  const reload = useReload(deviceId, harnessId, 'instructions')
  const { c } = theme
  const data = slot.data
  if (!data) return <SlotState slot={slot} onRetry={reload} />
  return (
    <ScrollView testID="hc:tab:instructions">
      <Note text={t('hcm.readonly.instructions')} tone="wait" testID="hc:readonly" />
      <View style={styles.pad}>
        <Text style={[styles.title, { color: c.ink }]}>{data.fileName}</Text>
        <Text
          selectable
          style={[styles.small, { color: c.ink2, fontFamily: theme.font.mono }]}
          testID="hc:instr:path"
        >
          {data.path}
        </Text>
      </View>
      {data.linkTarget ? (
        <Note text={t('hcm.instr.link', { target: data.linkTarget })} testID="hc:instr:link" />
      ) : null}
      {data.overriddenBy ? (
        <Note text={t('hc.instr.overridden', { path: data.overriddenBy })} tone="wait" />
      ) : null}
      {data.exists ? (
        <Text
          selectable
          testID="hc:instr:content"
          style={[
            styles.content,
            { color: c.ink, backgroundColor: c.sunken, fontFamily: theme.font.mono },
          ]}
        >
          {data.content === '' ? t('hcm.instr.empty') : data.content}
        </Text>
      ) : (
        <Note text={t('hcm.instr.missing')} tone="dim" testID="hc:instr:missing" />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { flex: 1, fontSize: 15, fontWeight: '600' },
  small: { fontSize: 12, lineHeight: 17 },
  pad: { paddingHorizontal: 16, paddingVertical: 8, gap: 2 },
  content: { fontSize: 12, lineHeight: 18, margin: 16, padding: 12 },
})
