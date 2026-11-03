// 设备列表页上的「最近」组：所有设备合在一起，以主对话为单位、按最后一次主动交互倒序（核心的 keys.sidebarProjections，
// 口径见 src/shell/activity.ts）。每行左边是设备的线色，跨设备时远程设备的行第二行写设备名（本机不写）；可按项目聚合，默认显示几条、
// “显示更多”每次多十条，都照桌面侧栏。快捷设置在组标题的“⋯”里，不放设置页。
// 子会话的交互算到主项上；子树照桌面投影默认收起，开合单独记在手机上。
import {
  type DeviceView,
  keys,
  pageSidebarProjection,
  type SessionChildren,
  type SessionSummary,
  type SidebarProjectionBlock,
  type SidebarProjectionRow,
  type SidebarProjections,
  type WorkspaceView,
} from '@litch/core'
import { type ReactNode, useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Sheet } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { foldsOf, subscribeFolds, toggleFolded } from '../sessions/folds'
import { ChildLine, SessionFold, SummaryLine, titleOf } from '../sessions/rows'
import { recentTree, type TreeRow } from '../sessions/tree'
import { FIRST_CHOICES, MORE_STEP } from './recent-settings'
import { setRecentSettings, useRecentSettings } from './recent-state'

const NONE: string[] = []
const NO_CHILDREN: SessionChildren = {}

/** 所有设备的「最近」主项合在一起；任何一台的投影没换就还是同一个数组，不让列表白白重画 */
function useRecentRows(): SidebarProjectionRow[] {
  const { store } = useReplica()
  const devices = useKey<string[]>(keys.devices) ?? NONE
  const joined = devices.join('\n')
  const cache = useRef<{ values: unknown[]; rows: SidebarProjectionRow[] } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 设备列表按内容比较（joined）
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = devices.map((id) => store.subscribe(keys.sidebarProjections(id), listener))
      return () => {
        for (const stop of stops) stop()
      }
    },
    [store, joined],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上
  const get = useCallback(() => {
    const values = devices.map((id) => store.get<SidebarProjections>(keys.sidebarProjections(id)))
    const was = cache.current
    if (was && was.values.length === values.length && was.values.every((v, i) => v === values[i]))
      return was.rows
    const rows = values.flatMap((value) => value?.recent ?? [])
    cache.current = { values, rows }
    return rows
  }, [store, joined])
  return useSyncExternalStore(subscribe, get)
}

/**
 * 首页一节的标题（「最近」「设备」同一种样式）：能收起的有 ▾/▸，没有的留出同样的位置对齐；右边可放一个按钮
 */
export function SectionHead({
  label,
  testID,
  collapsed,
  onToggle,
  action,
}: {
  label: string
  testID: string
  collapsed?: boolean
  onToggle?(): void
  action?: ReactNode
}) {
  const theme = useTheme()
  const { c } = theme
  const text = (
    <>
      <Text style={[styles.chevron, { color: c.ink3, fontFamily: theme.font.mono }]}>
        {onToggle ? (collapsed ? '▸' : '▾') : ''}
      </Text>
      <Text
        role="heading"
        style={[styles.headName, { color: c.ink2, fontFamily: theme.font.mono }]}
      >
        {label}
      </Text>
    </>
  )
  return (
    <View
      style={[
        styles.head,
        { minHeight: theme.hit, backgroundColor: c.win, borderBottomColor: c.line2 },
      ]}
    >
      {onToggle ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={!collapsed}
          testID={testID}
          onPress={onToggle}
          style={styles.headMain}
        >
          {text}
        </Pressable>
      ) : (
        <View testID={testID} style={styles.headMain}>
          {text}
        </View>
      )}
      {action}
    </View>
  )
}

export function RecentGroup({
  onOpen,
}: {
  onOpen(row: SidebarProjectionRow, title: string): void
}) {
  const t = useT()
  const { c, hit } = useTheme()
  const settings = useRecentSettings()
  const rows = useRecentRows()
  const [extra, setExtra] = useState(0)
  const [menu, setMenu] = useState(false)
  const page = pageSidebarProjection(rows, settings.byProject, settings.first + extra)
  const showDevice = new Set(page.blocks.map((block) => block.deviceId)).size > 1
  const name = t('sidebar.projection.recent')
  return (
    <View testID="recent">
      <SectionHead
        label={name}
        testID="recent:head"
        collapsed={settings.collapsed}
        onToggle={() => setRecentSettings({ collapsed: !settings.collapsed })}
        action={
          <Pressable
            accessibilityRole="button"
            aria-label={t('sidebar.projection.settings', { name })}
            testID="recent:menu"
            onPress={() => setMenu(true)}
            style={styles.headAction}
          >
            <Text style={[styles.headActionText, { color: c.ink2 }]}>⋯</Text>
          </Pressable>
        }
      />
      {settings.collapsed ? null : (
        <>
          {page.blocks.map((block) => (
            <RecentBlock
              key={block.key}
              block={block}
              byProject={settings.byProject}
              showDevice={showDevice}
              onOpen={onOpen}
            />
          ))}
          {rows.length === 0 ? (
            <Text testID="recent:empty" style={[styles.empty, { color: c.ink3 }]}>
              {t('sidebar.projection.recentEmpty')}
            </Text>
          ) : null}
          {page.remaining > 0 || extra > 0 ? (
            <View style={[styles.more, { borderBottomColor: c.line1 }]}>
              {/* 整段可点，高度不低于触控目标 */}
              {page.remaining > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  aria-label={`${t('sidebar.showMore')} · ${t('sidebar.hiddenCount', { count: page.remaining })}`}
                  testID="recent:more"
                  onPress={() => setExtra((was) => was + MORE_STEP)}
                  style={({ pressed }) => [
                    styles.moreButton,
                    styles.grow,
                    { minHeight: hit },
                    pressed ? { backgroundColor: c.press } : null,
                  ]}
                >
                  <Text style={[styles.moreText, { color: c.accent }]}>
                    {t('sidebar.showMore')}
                  </Text>
                  <Text style={[styles.moreCount, { color: c.ink3 }]}>
                    {t('sidebar.hiddenCount', { count: page.remaining })}
                  </Text>
                </Pressable>
              ) : (
                <View style={styles.grow} />
              )}
              {extra > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  testID="recent:less"
                  onPress={() => setExtra(0)}
                  style={({ pressed }) => [
                    styles.moreButton,
                    { minHeight: hit },
                    pressed ? { backgroundColor: c.press } : null,
                  ]}
                >
                  <Text style={[styles.moreText, { color: c.accent }]}>
                    {t('sidebar.showLess')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </>
      )}
      <Sheet
        visible={menu}
        title={t('sidebar.projection.settings', { name })}
        onClose={() => setMenu(false)}
        actions={[
          {
            label: t('sidebar.projection.project'),
            testID: 'recent:menu:project',
            checked: settings.byProject,
            onPress: () => setRecentSettings({ byProject: !settings.byProject }),
          },
          ...FIRST_CHOICES.map((n) => ({
            label: t('sidebar.projection.first', { n }),
            testID: `recent:menu:first:${n}`,
            selected: settings.first === n,
            onPress: () => {
              setRecentSettings({ first: n })
              setExtra(0)
            },
          })),
        ]}
      />
    </View>
  )
}

/** 一块：平铺时是一个主对话；按项目聚合时是一个项目（同名项目按设备分开），上面一行项目名 */
function RecentBlock({
  block,
  byProject,
  showDevice,
  onOpen,
}: {
  block: SidebarProjectionBlock
  byProject: boolean
  showDevice: boolean
  onOpen(row: SidebarProjectionRow, title: string): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const device = useKey<DeviceView>(keys.device(block.deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(block.deviceId))
  const children = useKey<SessionChildren>(keys.children(block.deviceId)) ?? NO_CHILDREN
  // 和桌面投影一样反向使用 folded：只记主动展开的父项，目录晚到不改变开合。
  const folds = useSyncExternalStore(subscribeFolds, () => foldsOf(`recent:${block.deviceId}`))
  const deviceName = showDevice && device ? t.text(device.name) : undefined
  const project = block.workspaceId
    ? (workspaces?.find((entry) => entry.id === block.workspaceId)?.name ?? '')
    : t('workspace.none')
  return (
    <>
      {byProject ? (
        <Text
          numberOfLines={1}
          testID={`recent:project:${block.key}`}
          style={[styles.project, { color: c.ink3, fontFamily: theme.font.mono }]}
        >
          {[project, deviceName].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
      {block.rows.flatMap((row) =>
        recentTree(row.sessionId, children, folds.folded).map((node) => (
          <RecentRow
            key={node.id}
            row={{ ...row, sessionId: node.id }}
            node={node}
            device={device}
            where={byProject || device?.kind === 'local' ? undefined : deviceName}
            onOpen={onOpen}
          />
        )),
      )}
    </>
  )
}

function RecentRow({
  row,
  node,
  device,
  where,
  onOpen,
}: {
  row: SidebarProjectionRow
  node: TreeRow
  device: DeviceView | undefined
  where: string | undefined
  onOpen(row: SidebarProjectionRow, title: string): void
}) {
  const { c } = useTheme()
  const t = useT()
  const summary = useKey<SessionSummary>(keys.summary(row.deviceId, row.sessionId))
  if (!summary) return null
  const open = () => onOpen(row, titleOf(summary, t))
  const testID = `recent:${row.deviceId}:${row.sessionId}`
  const fold =
    node.kids > 0 ? (
      <SessionFold
        deviceId={row.deviceId}
        sessionId={row.sessionId}
        kids={node.kids}
        folded={node.folded}
        onPress={() => toggleFolded(`recent:${row.deviceId}`, 'folded', row.sessionId)}
        testID={`${testID}:fold`}
      />
    ) : undefined
  return (
    <View style={styles.row}>
      <View style={[styles.wire, { backgroundColor: device ? c.wire[device.wire] : c.line2 }]} />
      <View style={styles.grow}>
        {node.depth > 0 ? (
          <ChildLine
            summary={summary}
            device={device}
            depth={node.depth}
            testID={testID}
            onPress={open}
            fold={fold}
          />
        ) : (
          <SummaryLine
            summary={summary}
            device={device}
            testID={testID}
            at={row.at}
            {...(where ? { where } : {})}
            onPress={open}
            fold={fold}
          />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // 行只有 minHeight：安卓上 height: '100%' 不按行高解析，会把标题行撑得很高；拉满行高用 alignSelf
  headMain: {
    flex: 1,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 12,
  },
  chevron: { width: 14, fontSize: 12 },
  headName: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
  headAction: { width: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  headActionText: { fontSize: 18, fontWeight: '600' },
  project: { paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 4, fontSize: 11 },
  row: { flexDirection: 'row' },
  wire: { width: 3 },
  grow: { flex: 1 },
  empty: { paddingHorizontal: 16, paddingVertical: 14, fontSize: 13 },
  more: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  moreButton: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 },
  moreText: { fontSize: 13 },
  moreCount: { fontSize: 12 },
})
