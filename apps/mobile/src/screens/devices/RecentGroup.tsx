// 设备列表页上的「最近」组：所有设备合在一起，以主对话为单位、按最后一次主动交互倒序（核心的 keys.sidebarProjections，
// 口径见 src/shell/activity.ts）。行和置顶区、本机分组同一个组件（ShortcutRows）：左边设备的线色，登记了多台设备时第二行写设备名
// （离线带上）；可按项目聚合，默认显示几条、
// “显示更多”每次多十条，都照桌面侧栏。快捷设置在组标题的“⋯”里，不放设置页。
// 子会话的交互算到主项上；子树照桌面投影默认收起，开合单独记在手机上。
import {
  type DeviceView,
  keys,
  pageSidebarProjection,
  type SessionSummary,
  type SidebarProjectionBlock,
  type SidebarProjectionRow,
  type SidebarProjections,
  type WorkspaceView,
} from '@litch/core'
import { type ReactNode, useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import { markReadScope } from '../../../../../packages/ui/src/app/read.ts'
import { groupClosed } from '../../../../../packages/ui/src/sidebar/folds.ts'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { ErrorBanner } from '../../ui/kit/controls'
import { Caret, Icon } from '../../ui/kit/Icon'
import { Sheet } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'
import { foldsOf, subscribeFolds, toggleFolded } from '../sessions/folds'
import { useReadMenu } from '../sessions/read-menu'
import { titleOf } from '../sessions/rows'
import { FIRST_CHOICES, MORE_STEP } from './recent-settings'
import { type ProjectionKind, setRecentSettings, useRecentSettings } from './recent-state'
import { ShortcutSession, useDeviceNote } from './ShortcutRows'

const NONE: string[] = []

/** 所有设备的「最近」（或「未读」）主项合在一起；任何一台的投影没换就还是同一个数组，不让列表白白重画 */
function useRecentRows(kind: ProjectionKind): SidebarProjectionRow[] {
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
    const rows = values.flatMap((value) => value?.[kind] ?? [])
    cache.current = { values, rows }
    return rows
  }, [store, joined, kind])
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
      <View style={styles.chevron}>{onToggle ? <Caret open={!collapsed} size={12} /> : null}</View>
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
  kind = 'recent',
  onOpen,
}: {
  /** 「最近」或「未读」：同一种画法，各记各的设置 */
  kind?: ProjectionKind
  onOpen(row: SidebarProjectionRow, title: string): void
}) {
  const t = useT()
  const { c, hit } = useTheme()
  const settings = useRecentSettings(kind)
  const rows = useRecentRows(kind)
  const [extra, setExtra] = useState(0)
  const [menu, setMenu] = useState(false)
  const channel = useChannel()
  const { store } = useReplica()
  const [sessionMenu, setSessionMenu] = useState<{
    deviceId: string
    sessionId: string
    title: string
  } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const act = (work: Promise<unknown>) => {
    setFailure(null)
    void work.catch((error) => setFailure(reasonOf(error, t)))
  }
  const readActions = useReadMenu(sessionMenu?.deviceId, sessionMenu?.sessionId, act)
  const page = pageSidebarProjection(rows, settings.byProject, settings.first + extra)
  const showDevice = (useKey<string[]>(keys.devices)?.length ?? 0) > 1
  const name = t(`sidebar.projection.${kind}`)
  // 没有未读时整节不出，省地方
  if (kind === 'unread' && rows.length === 0) return null
  const set = (change: Parameters<typeof setRecentSettings>[0]) => setRecentSettings(change, kind)
  return (
    <View testID={kind}>
      {failure ? <ErrorBanner text={failure} onClose={() => setFailure(null)} /> : null}
      <SectionHead
        label={name}
        testID={`${kind}:head`}
        collapsed={settings.collapsed}
        onToggle={() => set({ collapsed: !settings.collapsed })}
        action={
          <Pressable
            accessibilityRole="button"
            aria-label={t('sidebar.projection.settings', { name })}
            testID={`${kind}:menu`}
            onPress={() => setMenu(true)}
            style={styles.headAction}
          >
            <Icon name="more" size={18} color={c.ink2} />
          </Pressable>
        }
      />
      {settings.collapsed ? null : (
        <>
          {page.blocks.map((block) => (
            <RecentBlock
              key={block.key}
              block={block}
              kind={kind}
              byProject={settings.byProject}
              showDevice={showDevice}
              onOpen={onOpen}
              onMenu={(summary, deviceId) =>
                setSessionMenu({ deviceId, sessionId: summary.id, title: titleOf(summary, t) })
              }
            />
          ))}
          {rows.length === 0 ? (
            <Text testID={`${kind}:empty`} style={[styles.empty, { color: c.ink3 }]}>
              {t(`sidebar.projection.${kind}Empty`)}
            </Text>
          ) : null}
          {page.remaining > 0 || extra > 0 ? (
            <View style={[styles.more, { borderBottomColor: c.line1 }]}>
              {/* 整段可点，高度不低于触控目标 */}
              {page.remaining > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  aria-label={`${t('sidebar.showMore')} · ${t('sidebar.hiddenCount', { count: page.remaining })}`}
                  testID={`${kind}:more`}
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
                  testID={`${kind}:less`}
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
          ...(kind === 'unread'
            ? [
                {
                  label: t('session.markAllRead'),
                  testID: 'unread:markAllRead',
                  onPress: () =>
                    act(
                      Promise.all(
                        (store.get<string[]>(keys.devices) ?? []).map((deviceId) =>
                          markReadScope(channel, store, deviceId),
                        ),
                      ),
                    ),
                },
              ]
            : []),
          {
            label: t('sidebar.projection.project'),
            testID: `${kind}:menu:project`,
            checked: settings.byProject,
            onPress: () => set({ byProject: !settings.byProject }),
          },
          ...FIRST_CHOICES.map((n) => ({
            label: t('sidebar.projection.first', { n }),
            testID: `${kind}:menu:first:${n}`,
            selected: settings.first === n,
            onPress: () => {
              set({ first: n })
              setExtra(0)
            },
          })),
        ]}
      />
      <Sheet
        visible={sessionMenu !== null}
        title={sessionMenu?.title}
        onClose={() => setSessionMenu(null)}
        actions={readActions}
      />
    </View>
  )
}

/** 一块：平铺时是一个主对话；按项目聚合时是一个项目（同名项目按设备分开），上面一行项目名 */
function RecentBlock({
  block,
  kind,
  byProject,
  showDevice,
  onOpen,
  onMenu,
}: {
  block: SidebarProjectionBlock
  kind: ProjectionKind
  byProject: boolean
  showDevice: boolean
  onOpen(row: SidebarProjectionRow, title: string): void
  onMenu(summary: SessionSummary, deviceId: string): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const device = useKey<DeviceView>(keys.device(block.deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(block.deviceId))
  const deviceName = useDeviceNote(device, showDevice)
  const scope = `${kind}:${block.deviceId}`
  const folds = useSyncExternalStore(subscribeFolds, () => foldsOf(scope))
  const projectKey = block.workspaceId ?? ':loose'
  const open = !byProject || !groupClosed(folds, projectKey, true)
  const project = block.workspaceId
    ? (workspaces?.find((entry) => entry.id === block.workspaceId)?.name ?? '')
    : t('workspace.none')
  return (
    <>
      {byProject ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={open}
          aria-label={[project, deviceName, t('organizer.count', { count: block.rows.length })]
            .filter(Boolean)
            .join(' · ')}
          testID={`${kind}:project:${block.key}`}
          onPress={() => toggleFolded(scope, 'closed', projectKey, true)}
          style={({ pressed }) => [
            styles.project,
            {
              minHeight: theme.hit,
              backgroundColor: pressed ? c.press : c.panel,
              borderBottomColor: c.line1,
            },
          ]}
        >
          <View
            style={[
              styles.projectWire,
              { backgroundColor: device ? c.wire[device.wire] : c.line2 },
            ]}
          />
          <View style={styles.chevron}>
            <Caret open={open} size={12} />
          </View>
          <Text
            numberOfLines={1}
            style={[styles.grow, { color: c.ink3, fontFamily: theme.font.mono, fontSize: 11 }]}
          >
            {[project, deviceName].filter(Boolean).join(' · ')}
          </Text>
          <Text style={{ color: c.ink3, fontSize: 11 }}>{block.rows.length}</Text>
        </Pressable>
      ) : null}
      {open
        ? block.rows.map((row) => (
            <ShortcutSession
              key={row.sessionId}
              deviceId={row.deviceId}
              sessionId={row.sessionId}
              scope={kind}
              showDevice={showDevice}
              testID={kind}
              at={row.at}
              onOpen={(summary) => onOpen({ ...row, sessionId: summary.id }, titleOf(summary, t))}
              onMenu={onMenu}
            />
          ))
        : null}
    </>
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
  chevron: { width: 14, alignItems: 'center' },
  headName: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
  headAction: { width: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  project: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 12,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  projectWire: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
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
