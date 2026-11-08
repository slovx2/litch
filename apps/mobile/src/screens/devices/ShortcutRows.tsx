// 跨设备各区（置顶、本机分组、最近、未读）里的行：会话（连同它的子会话，默认收起）和置顶的项目。混着各台设备，
// 左边是设备的线色；会话行省去重复设备名，离线提示保留，设备信息通过读屏和打开后的会话页查询。
import {
  type DeviceView,
  keys,
  type SessionChildren,
  type SessionGroups,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Caret } from '../../ui/kit/Icon'
import { useTheme } from '../../ui/theme'
import { foldsOf, subscribeFolds, toggleFolded } from '../sessions/folds'
import { ChildLine, SessionFold, SummaryLine } from '../sessions/rows'
import { recentTree } from '../sessions/tree'

const NO_CHILDREN: SessionChildren = {}
const NO_IDS: string[] = []

/** 行上写的设备：只有一台设备时不写；离线时带上 */
export function useDeviceNote(device: DeviceView | undefined, showDevice: boolean): string {
  const t = useT()
  if (!device) return ''
  const parts = showDevice ? [t.text(device.name)] : []
  if (device.connection !== 'online') parts.push(t('devices.state.offline'))
  return parts.join(' · ')
}

/** 一个会话和它的子会话。scope 是收合记在哪儿（各区分开记）；行的 testID 是 `${testID}:设备:会话` */
export function ShortcutSession({
  deviceId,
  sessionId,
  scope,
  showDevice,
  testID,
  at,
  onOpen,
  onMenu,
}: {
  deviceId: string
  sessionId: string
  scope: string
  showDevice: boolean
  testID: string
  /** 主项右上角的时间：「最近」「未读」给投影的时间，不给是会话的更新时间 */
  at?: number
  onOpen(summary: SessionSummary, deviceId: string): void
  onMenu?(summary: SessionSummary, deviceId: string): void
}) {
  const { c } = useTheme()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const children = useKey<SessionChildren>(keys.children(deviceId)) ?? NO_CHILDREN
  const foldScope = `${scope}:${deviceId}`
  // 和「最近」一样只记主动展开的父项：默认收起，省地方
  const folds = useSyncExternalStore(subscribeFolds, () => foldsOf(foldScope))
  const where = useDeviceNote(device, showDevice)
  return (
    <>
      {recentTree(sessionId, children, folds.folded).map((node) => (
        <View key={node.id} style={styles.row}>
          <View
            style={[styles.wire, { backgroundColor: device ? c.wire[device.wire] : c.line2 }]}
          />
          <View style={styles.grow}>
            <TreeLine
              deviceId={deviceId}
              sessionId={node.id}
              depth={node.depth}
              kids={node.kids}
              folded={node.folded}
              device={device}
              where={where}
              {...(node.depth === 0 && at !== undefined ? { at } : {})}
              testID={`${testID}:${deviceId}:${node.id}`}
              onFold={() => toggleFolded(foldScope, 'folded', node.id)}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          </View>
        </View>
      ))}
    </>
  )
}

function TreeLine({
  deviceId,
  sessionId,
  depth,
  kids,
  folded,
  device,
  where,
  at,
  testID,
  onFold,
  onOpen,
  onMenu,
}: {
  deviceId: string
  sessionId: string
  depth: number
  kids: number
  folded: boolean
  device: DeviceView | undefined
  where: string
  at?: number
  testID: string
  onFold(): void
  onOpen(summary: SessionSummary, deviceId: string): void
  onMenu?(summary: SessionSummary, deviceId: string): void
}) {
  const t = useT()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  if (!summary) return null
  const fold =
    kids > 0 ? (
      <SessionFold
        deviceId={deviceId}
        sessionId={sessionId}
        kids={kids}
        folded={folded}
        onPress={onFold}
        testID={`${testID}:fold`}
      />
    ) : undefined
  const open = () => onOpen(summary, deviceId)
  if (depth > 0)
    return (
      <ChildLine
        summary={summary}
        device={device}
        depth={depth}
        testID={testID}
        onPress={open}
        fold={fold}
      />
    )
  return (
    <SummaryLine
      summary={summary}
      device={device}
      testID={testID}
      deviceNote={where}
      {...(device && device.connection !== 'online' ? { where: t('devices.state.offline') } : {})}
      {...(at !== undefined ? { at } : {})}
      onPress={open}
      {...(onMenu ? { onLongPress: () => onMenu(summary, deviceId) } : {})}
      fold={fold}
    />
  )
}

/** 置顶的项目：标题一行（线色、名字、设备名、会话数），展开是它下面的主会话 */
export function ShortcutWorkspace({
  deviceId,
  workspaceId,
  explicit,
  showDevice,
  onOpen,
  onMenu,
  onSessionMenu,
}: {
  deviceId: string
  workspaceId: string
  /** 单独置顶了的会话（各自占一项，不在项目下面重画），键是 deviceId\nsessionId */
  explicit: ReadonlySet<string>
  showDevice: boolean
  onOpen(summary: SessionSummary, deviceId: string): void
  onMenu(workspace: WorkspaceView, deviceId: string): void
  onSessionMenu(summary: SessionSummary, deviceId: string): void
}) {
  const theme = useTheme()
  const { c } = theme
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspace = useKey<WorkspaceView[]>(keys.workspaces(deviceId))?.find(
    (entry) => entry.id === workspaceId,
  )
  const groups = useKey<SessionGroups>(keys.groups(deviceId))
  const children = useKey<SessionChildren>(keys.children(deviceId)) ?? NO_CHILDREN
  const folds = useSyncExternalStore(subscribeFolds, () => foldsOf(`pins:${deviceId}`))
  const where = useDeviceNote(device, showDevice)
  if (!workspace) return null
  const ids = groups?.[workspaceId] ?? NO_IDS
  const nested = new Set(
    ids.flatMap((id) => (children[id] ?? []).filter((kid) => ids.includes(kid))),
  )
  const top = ids.filter((id) => !nested.has(id) && !explicit.has(`${deviceId}\n${id}`))
  const open = !folds.closed.includes(workspaceId)
  const testID = `pins:ws:${deviceId}:${workspaceId}`
  return (
    <>
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        aria-label={[workspace.name, where, t('organizer.count', { count: top.length })]
          .filter(Boolean)
          .join(' · ')}
        testID={testID}
        onPress={() => toggleFolded(`pins:${deviceId}`, 'closed', workspaceId)}
        onLongPress={() => onMenu(workspace, deviceId)}
        style={({ pressed }) => [
          styles.head,
          {
            minHeight: theme.hit,
            borderBottomColor: c.line1,
            backgroundColor: pressed ? c.press : c.panel,
          },
        ]}
      >
        <View
          style={[styles.headWire, { backgroundColor: device ? c.wire[device.wire] : c.line2 }]}
        />
        <View style={styles.chevron}>
          <Caret open={open} size={12} />
        </View>
        <Text numberOfLines={1} style={[styles.name, { color: c.ink }]}>
          {workspace.name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.meta, { color: c.ink3, fontFamily: theme.font.mono }]}
        >
          {[where, String(top.length)].filter(Boolean).join(' · ')}
        </Text>
      </Pressable>
      {open
        ? top.map((id) => (
            <ShortcutSession
              key={id}
              deviceId={deviceId}
              sessionId={id}
              scope="pins"
              showDevice={showDevice}
              testID="pins"
              onOpen={onOpen}
              onMenu={onSessionMenu}
            />
          ))
        : null}
    </>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  wire: { width: 3 },
  grow: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 12,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headWire: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  chevron: { width: 14, alignItems: 'center' },
  name: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  meta: { flex: 1, fontSize: 11, textAlign: 'right' },
})
