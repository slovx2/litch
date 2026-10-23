// 会话列表里的各种行。会话行自己订阅自己的摘要（keys.summary），收起来的组标题自己订阅汇总（keys.tallies）：
// 一个会话有了动静只重画它那一行，整张列表不跟着重画。行高固定，FlashList 回收得稳。
import {
  type DeviceView,
  type GroupTallies,
  keys,
  type SessionSummary,
  type WireColor,
} from '@litch/core'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ago } from '../../../../../packages/ui/src/app/format.ts'
import { useKey } from '../../shell/services'
import { type Translator, useT } from '../../ui/i18n'
import { StatusMark } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { useNow } from './clock'
import { type GroupHead, groupKeyOf } from './list'

export const SESSION_ROW_H = 60
export const GROUP_ROW_H = 44

const lastSegment = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || path
}

export const titleOf = (summary: SessionSummary, t: Translator): string =>
  t.text(summary.title) || t('session.untitled')

export const badgeOf = (device: DeviceView | undefined, harness: string): string =>
  device?.harnesses.find((entry) => entry.id === harness)?.badge ??
  harness.slice(0, 2).toUpperCase()

function markOf(summary: SessionSummary) {
  if (summary.status === 'running') return 'running'
  if (summary.status === 'waiting') return 'waiting'
  if (summary.status === 'error') return 'error'
  // 回合停了、后台任务还在跑
  if ((summary.background?.running ?? 0) > 0) return 'background'
  return summary.unread ? 'unread' : 'idle'
}

/** 一个会话的一行：状态记号、标题、多久以前；第二行是 harness 徽标、在等什么、工作目录的最后一段 */
function SummaryLine({
  summary,
  device,
  onPress,
  onLongPress,
  testID,
}: {
  summary: SessionSummary
  device: DeviceView | undefined
  onPress(): void
  onLongPress?(): void
  testID: string
}) {
  const theme = useTheme()
  const t = useT()
  const now = useNow()
  const { c } = theme
  // 所属的 harness 现在用不了（设备连着才算；整台没连上由横条去说）：徽标划掉
  const down =
    device?.connection === 'online' &&
    device.harnesses.find((entry) => entry.id === summary.harness)?.state !== 'ready'
  const waiting =
    summary.status === 'waiting'
      ? t(summary.waitingFor === 'answer' ? 'sidebar.waitAnswer' : 'sidebar.waitApproval')
      : null
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.session,
        { borderBottomColor: c.line1, backgroundColor: pressed ? c.press : c.panel },
      ]}
    >
      <StatusMark status={markOf(summary)} />
      <View style={styles.sessionText}>
        <View style={styles.line}>
          <Text
            numberOfLines={1}
            style={[
              styles.title,
              {
                color: c.ink,
                fontSize: theme.font.size.body,
                fontWeight: summary.unread ? '700' : '500',
              },
            ]}
          >
            {titleOf(summary, t)}
          </Text>
          <Text style={[styles.meta, { color: c.ink3, fontFamily: theme.font.mono }]}>
            {ago(summary.updatedAt, now, t)}
          </Text>
        </View>
        <View style={styles.line}>
          <Text
            style={[
              styles.badge,
              {
                color: down ? c.ink3 : c.ink2,
                borderColor: down ? c.line1 : c.line2,
                fontFamily: theme.font.mono,
                borderRadius: theme.radius.s,
                textDecorationLine: down ? 'line-through' : 'none',
              },
            ]}
          >
            {badgeOf(device, summary.harness)}
          </Text>
          {summary.task ? (
            <Text
              testID={`${testID}:task`}
              style={[
                styles.badge,
                {
                  color: c.ink2,
                  borderColor: c.line2,
                  fontFamily: theme.font.mono,
                  borderRadius: theme.radius.s,
                },
              ]}
            >
              ⏱ {t('timed.mark')}
            </Text>
          ) : null}
          {waiting ? (
            <Text style={[styles.pill, { color: c.invFg, backgroundColor: c.wait }]}>
              {waiting}
            </Text>
          ) : null}
          <Text
            numberOfLines={1}
            style={[styles.cwd, { color: c.ink3, fontFamily: theme.font.mono }]}
          >
            {lastSegment(summary.cwd)}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

export const SessionRow = memo(function SessionRow({
  deviceId,
  sessionId,
  onOpen,
  onMenu,
}: {
  deviceId: string
  sessionId: string
  onOpen(summary: SessionSummary): void
  onMenu(summary: SessionSummary): void
}) {
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  if (!summary) return <View style={{ height: SESSION_ROW_H }} />
  return (
    <SummaryLine
      summary={summary}
      device={device}
      testID={`session:${sessionId}`}
      onPress={() => onOpen(summary)}
      onLongPress={() => onMenu(summary)}
    />
  )
})

/** 已归档的一行：摘要随列表来。点一下出菜单（恢复、只读打开、删除） */
export const ArchivedRow = memo(function ArchivedRow({
  deviceId,
  summary,
  onPress,
}: {
  deviceId: string
  summary: SessionSummary
  onPress(summary: SessionSummary): void
}) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  return (
    <SummaryLine
      summary={summary}
      device={device}
      testID={`archived:${summary.id}`}
      onPress={() => onPress(summary)}
      onLongPress={() => onPress(summary)}
    />
  )
})

/**
 * 收起来的组的汇总：几个等人、在跑、只剩后台任务在跑、未读。只在收起时画，自己订阅 keys.tallies。
 * groupKeys 是要合起来的几组（“项目”是它里面的各个工作区）
 */
function Tally({ deviceId, groupKeys }: { deviceId: string; groupKeys: readonly string[] }) {
  const tallies = useKey<GroupTallies>(keys.tallies(deviceId))
  const theme = useTheme()
  const t = useT()
  const sum = { approval: 0, answer: 0, running: 0, unread: 0, background: 0 }
  for (const tally of groupKeys.flatMap((key) => Object.values(tallies?.[key] ?? {}))) {
    sum.approval += tally.approval
    sum.answer += tally.answer
    sum.running += tally.running
    sum.unread += tally.unread
    sum.background += tally.background
  }
  const parts = (['approval', 'answer', 'running', 'background', 'unread'] as const)
    .filter((kind) => sum[kind] > 0)
    .map((kind) => t(`sidebar.tally.${kind}`, { count: sum[kind] }))
  if (parts.length === 0) return null
  const urgent = sum.approval + sum.answer > 0
  return (
    <Text numberOfLines={1} style={[styles.tally, { color: urgent ? theme.c.wait : theme.c.ink3 }]}>
      {parts.join(t('sidebar.tally.join'))}
    </Text>
  )
}

export function headLabel(head: GroupHead, t: Translator): string {
  switch (head.kind) {
    case 'pinned':
      return t('sidebar.pinned')
    case 'section':
      return head.section.name
    case 'projects':
      return t('sidebar.projects')
    case 'workspace':
      return head.workspace.name
    case 'loose':
      return t('workspace.none')
  }
}

/**
 * 一组的标题：点一下收起、展开；工作区和“无项目”的另有“＋”（在这里新建），“项目”的“＋”是添加项目，
 * 工作区的还有长按菜单
 */
export const GroupRow = memo(function GroupRow({
  deviceId,
  head,
  count,
  collapsed,
  inner = false,
  tally,
  onToggle,
  onNew,
  onMenu,
}: {
  deviceId: string
  head: GroupHead
  count: number
  collapsed: boolean
  /** 排在置顶、分区、“项目”里的工作区：往里缩一点 */
  inner?: boolean
  /** 收起时汇总哪几组。没有就是它自己那一组 */
  tally?: readonly string[] | undefined
  onToggle(key: string): void
  onNew?(head: GroupHead): void
  onMenu?(head: GroupHead): void
}) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  const key = groupKeyOf(head)
  const color: WireColor | null = head.kind === 'workspace' ? head.workspace.color : null
  return (
    <View style={[styles.group, { backgroundColor: c.win, borderBottomColor: c.line2 }]}>
      {color ? <View style={[styles.groupWire, { backgroundColor: c.wire[color] }]} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        testID={`group:${key}`}
        onPress={() => onToggle(key)}
        onLongPress={onMenu ? () => onMenu(head) : undefined}
        style={[styles.groupMain, inner ? styles.groupInner : null]}
      >
        <Text style={[styles.chevron, { color: c.ink3, fontFamily: theme.font.mono }]}>
          {collapsed ? '▸' : '▾'}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.groupName, { color: c.ink2, fontFamily: theme.font.mono }]}
        >
          {headLabel(head, t)}
        </Text>
        <Text style={[styles.groupCount, { color: c.ink3, fontFamily: theme.font.mono }]}>
          {count}
        </Text>
        {collapsed ? (
          <Tally deviceId={deviceId} groupKeys={tally ?? [key]} />
        ) : (
          <View style={styles.grow} />
        )}
      </Pressable>
      {onNew ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            head.kind === 'projects'
              ? 'workspace.add'
              : head.kind === 'loose'
                ? 'newSession.buttonLoose'
                : 'sessions.newHere',
          )}
          testID={`group:${key}:new`}
          hitSlop={6}
          onPress={() => onNew(head)}
          style={styles.groupAction}
        >
          <Text style={[styles.groupActionText, { color: c.accent }]}>＋</Text>
        </Pressable>
      ) : null}
      {onMenu ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('workspace.menu')}
          testID={`group:${key}:menu`}
          hitSlop={6}
          onPress={() => onMenu(head)}
          style={styles.groupAction}
        >
          <Text style={[styles.groupActionText, { color: c.ink2 }]}>⋯</Text>
        </Pressable>
      ) : null}
    </View>
  )
})

/** “已归档对话”那一行：点一下展开（第一次展开时才去设备上取） */
export function ArchivedHead({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const theme = useTheme()
  const t = useT()
  const { c } = theme
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      testID="archived:toggle"
      onPress={onToggle}
      style={[styles.group, styles.archivedHead, { backgroundColor: c.win, borderColor: c.line2 }]}
    >
      <View style={styles.groupMain}>
        <Text style={[styles.chevron, { color: c.ink3, fontFamily: theme.font.mono }]}>
          {open ? '▾' : '▸'}
        </Text>
        <Text style={[styles.groupName, { color: c.ink2, fontFamily: theme.font.mono }]}>
          {t('archived.title')}
        </Text>
      </View>
    </Pressable>
  )
}

const NOTE_KEY = {
  loading: 'archived.loading',
  empty: 'archived.empty',
  offline: 'archived.offline',
} as const

export function ArchivedNote({ note }: { note: keyof typeof NOTE_KEY }) {
  const { c } = useTheme()
  const t = useT()
  return <Text style={[styles.note, { color: c.ink3 }]}>{t(NOTE_KEY[note])}</Text>
}

const styles = StyleSheet.create({
  session: {
    height: SESSION_ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 10,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sessionText: { flex: 1, minWidth: 0, gap: 4 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1 },
  meta: { fontSize: 11 },
  badge: { fontSize: 10, borderWidth: 1, paddingHorizontal: 3 },
  pill: { fontSize: 11, paddingHorizontal: 4 },
  cwd: { flex: 1, fontSize: 11 },
  group: {
    height: GROUP_ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  groupWire: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  groupMain: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 12,
  },
  groupInner: { paddingLeft: 26 },
  chevron: { width: 14, fontSize: 12 },
  groupName: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
  groupCount: { fontSize: 11 },
  grow: { flex: 1 },
  tally: { flex: 1, fontSize: 11, textAlign: 'right' },
  groupAction: { width: 44, height: '100%', alignItems: 'center', justifyContent: 'center' },
  groupActionText: { fontSize: 18, fontWeight: '600' },
  archivedHead: { marginTop: 16, borderTopWidth: StyleSheet.hairlineWidth },
  note: { paddingHorizontal: 16, paddingVertical: 14, fontSize: 13 },
})
