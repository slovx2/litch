// 手机经理工作台（35-manager 第十七节）：标题栏是经理名和状态，下面一排页签“对话 · 控制台 · 工作线 · 概览”。
// 对话就是经理会话本身（与会话页同一套组件，detail/session-page.tsx），切到别的页签时不卸载、只是不显示，
// 回来时滚动位置和草稿都在；只有对话页签显示着才标已读。默认落在对话；带 issue 的入口（经理事件、#D-n、受阻事项、
// 工作线回经理）落到控制台（经理事项落到概览）并定位。当前页签存在路由参数里，回经理时可以直接改。
// 议题卡在 Issue.tsx，对话里点编号拉起的半屏议题卡在 IssueSheet.tsx，工作线列表在 ManagerLines.tsx。
import {
  keys,
  MANAGER_ISSUE_ORDERS,
  type ManagerBoardTopicView,
  type ManagerView,
  managerAttentionCount,
  type SessionSummary,
  type SuggestionView,
} from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import type { ManagerPost } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { sessionMark } from '../../../../../packages/ui/src/sidebar/session-mark.ts'
import { useSessionPage } from '../../detail/session-page'
import type { ManagerTab, RootStackParamList } from '../../nav/routes'
import { useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Sheet } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { Issue } from './Issue'
import { IssueContext } from './IssueRelations'
import { IssueSheet } from './IssueSheet'
import { setIssueOrder, useIssueOrder } from './issue-order'
import { ManagerLines } from './ManagerLines'
import { ManagerOverview } from './ManagerOverview'
import { issueCounts, managerRowState, orderedIssues } from './presentation'

type Props = NativeStackScreenProps<RootStackParamList, 'ManagerConsole'>
type Category = ManagerPost['kind']

const TABS: readonly ManagerTab[] = ['chat', 'console', 'lines', 'overview']
const TAB_LABEL = {
  chat: 'mgr.tab.chat',
  console: 'manager.inbox',
  lines: 'mgr.tab.lines',
  overview: 'manager.overview',
} as const
const KINDS = {
  decision: 'manager.decisions',
  suggestion: 'manager.suggestions',
  request: 'manager.requests',
  report: 'manager.reports',
} as const
/** 比这窄（320 一类的小屏），控制台的排序只画图标，和类别挤在一行 */
const NARROW = 360

export function ManagerConsoleScreen({ route, navigation }: Props) {
  const { deviceId, managerId } = route.params
  const replica = useReplica()
  const t = useT()
  useEffect(() => replica.openManagerBoard(deviceId, managerId), [replica, deviceId, managerId])
  const manager = useKey<ManagerView>(keys.manager(deviceId, managerId))
  if (!manager)
    return (
      <Screen title={t('manager.title')} testID="manager-console">
        <Empty title={t('manager.loading')} />
      </Screen>
    )
  // 经理会话换了（接手）就整页重来：对话的仓库按会话取
  return (
    <Workbench key={manager.threadId} manager={manager} route={route} navigation={navigation} />
  )
}

function Workbench({ manager, route, navigation }: Props & { manager: ManagerView }) {
  const { deviceId, id: managerId } = manager
  const tab: ManagerTab = route.params.tab ?? 'chat'
  const t = useT()
  const theme = useTheme()
  const { c, radius, font, hit, marks } = theme
  const { width } = useWindowDimensions()
  const focused = useIsFocused()
  const view = useKey<ManagerBoardTopicView>(keys.managerBoard(deviceId, managerId))
  const board = view?.board ?? null
  const features = view?.features ?? { feedback: true, posts: true, ignore: true }
  const suggestions = useKey<readonly SuggestionView[]>(keys.suggestions) ?? []
  const summary = useKey<SessionSummary>(keys.summary(deviceId, manager.threadId))
  const device = useKey<{ connection?: string }>(keys.device(deviceId))
  const order = useIssueOrder()
  const [kind, setKind] = useState<Category>('decision')
  const [ordering, setOrdering] = useState(false)
  const [talkId, setTalkId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [focusItem, setFocusItem] = useState<string | null>(null)
  const [sheet, setSheet] = useState<string | null>(null)
  const positions = useRef(new Map<string, number>())
  const itemsAt = useRef(0)
  const scroll = useRef<ScrollView>(null)

  const setTab = useCallback(
    (next: ManagerTab) => navigation.setParams({ tab: next, issue: undefined }),
    [navigation],
  )
  const go = (next: ManagerTab, category?: Category) => {
    setTalkId(null)
    setSelected(null)
    setFocusItem(null)
    if (category) setKind(category)
    setTab(next)
    scroll.current?.scrollTo({ y: 0, animated: false })
  }
  // 定位到一条议题：经理事项到概览展开那一项，其他到控制台只列这一条（点类别或页签恢复整列）
  const posts = board?.posts
  const openIssue = useCallback(
    (id: string, talk = false) => {
      setSheet(null)
      if (id.startsWith('I-')) {
        setFocusItem(id)
        setTab('overview')
        return
      }
      setSelected(id)
      setKind(
        id.startsWith('R-') ? 'request' : (posts?.find((p) => p.id === id)?.kind ?? 'decision'),
      )
      setTalkId(talk ? id : null)
      setTab('console')
      scroll.current?.scrollTo({ y: 0, animated: false })
    },
    [posts, setTab],
  )
  // 路由带来的议题（经理事件、工作线回经理、链接）：定位后清掉，免得返回时又跳一次
  const routeIssue = route.params.issue
  useEffect(() => {
    if (routeIssue && board) openIssue(routeIssue)
  }, [routeIssue, board, openIssue])
  // 经理事项一节展开后滚过去
  useEffect(() => {
    if (tab !== 'overview' || !focusItem) return
    const timer = setTimeout(
      () => scroll.current?.scrollTo({ y: itemsAt.current, animated: true }),
      50,
    )
    return () => clearTimeout(timer)
  }, [tab, focusItem])

  // 对话正文里的看板编号：经理事项到概览，其他拉起半屏议题卡
  const idsKey = board
    ? [...(board.posts ?? []).map((p) => p.id), ...board.items.map((i) => i.id)].join(',')
    : ''
  const issues = useMemo(() => {
    const ids = new Set(idsKey ? idsKey.split(',') : [])
    return ids.size
      ? {
          ids,
          open: (id: string) => {
            // 输入框还拿着焦点时，面板关上后安卓会把焦点还给它、键盘又弹出来：先放掉
            Keyboard.dismiss()
            if (id.startsWith('I-')) openIssue(id)
            else setSheet(id)
          },
        }
      : null
  }, [idsKey, openIssue])
  const page = useSessionPage({
    deviceId,
    sessionId: manager.threadId,
    title: manager.name || undefined,
    manager: true,
    active: focused && tab === 'chat',
    above: hit,
    issues,
  })
  const openSession = (sessionId: string, title?: string) =>
    navigation.push('Detail', { deviceId, sessionId, ...(title ? { title } : {}) })

  const { text } = managerRowState(manager, summary)
  const { key: stateKey, ...stateArgs } = text
  const pending = manager.status === 'active' ? managerAttentionCount(manager) : 0
  const counts = issueCounts(manager)
  const missing = (['feedback', 'posts', 'ignore'] as const).filter((key) => !features[key])
  const chatMark = sessionMark(summary)
  const linesWaiting = (board?.lines ?? []).some(
    (line) => line.status === 'waiting' || line.status === 'error',
  )
  const narrow = width < NARROW

  /** 页签上的记号：对话是经理自己在跑/等人/有新回复，控制台是待处理数，工作线是在跑条数（有线等人时换等待色） */
  const badge = (
    key: ManagerTab,
  ): { text: string; color: string; boxed: boolean; label: string } | null => {
    if (key === 'chat') {
      if (chatMark === 'run')
        return {
          text: marks.running,
          color: c.accent,
          boxed: false,
          label: t('mgr.tab.chatRunning'),
        }
      if (chatMark === 'wait')
        return { text: marks.waiting, color: c.wait, boxed: false, label: t('mgr.tab.chatRunning') }
      if (chatMark === 'unread' && tab !== 'chat')
        return { text: marks.unread, color: c.seal, boxed: false, label: t('mgr.tab.chatUnread') }
      return null
    }
    if (key === 'console')
      return pending
        ? {
            text: String(pending),
            color: c.wait,
            boxed: true,
            label: t('manager.pending', { n: pending }),
          }
        : null
    if (key === 'lines') {
      const running = manager.runningLines
      if (!running && !linesWaiting) return null
      return {
        text: linesWaiting ? marks.waiting : String(running),
        color: linesWaiting ? c.wait : c.ink2,
        boxed: false,
        label: linesWaiting
          ? t('mgr.tab.linesWaiting')
          : t('mgr.tab.linesRunning', { count: running }),
      }
    }
    return null
  }

  return (
    <Screen
      title={manager.name || t('manager.manager')}
      subtitle={t(stateKey, stateArgs)}
      wire={page.wire}
      actions={page.actions}
      testID="manager-console"
    >
      {/* 页签是下划线式，一排放不下（大字号）时横着滚，不换行。键盘弹着时第一下点击也要切页签，不只是收键盘 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        role="tablist"
        style={[styles.tabsRow, { borderColor: c.line1, backgroundColor: c.panel, height: hit }]}
        contentContainerStyle={styles.tabs}
      >
        {TABS.map((key) => {
          const on = tab === key
          const mark = badge(key)
          return (
            <Pressable
              key={key}
              role="tab"
              aria-selected={on}
              aria-label={mark ? `${t(TAB_LABEL[key])} · ${mark.label}` : t(TAB_LABEL[key])}
              testID={`manager-tab:${key}`}
              onPress={() => go(key)}
              style={[
                styles.tab,
                narrow ? styles.tabNarrow : null,
                { height: hit, borderBottomColor: on ? c.accent : 'transparent' },
              ]}
            >
              {/* 换粗细时重建这段字：安卓上原地改 fontWeight 会沿用旧的量宽，“Console” 被裁成 “Consol” */}
              <Text
                key={on ? 'on' : 'off'}
                style={{ color: on ? c.ink : c.ink2, fontWeight: on ? '600' : '400' }}
              >
                {t(TAB_LABEL[key])}
              </Text>
              {mark ? (
                <Text
                  testID={`manager-tab-badge:${key}`}
                  style={[
                    mark.boxed ? styles.count : styles.glyph,
                    // 选中页签上的计数跟随前景色（复古暗色的浅绿底上不放琥珀字，11.7）
                    {
                      color: on && mark.boxed ? c.ink : mark.color,
                      borderColor: on && mark.boxed ? c.ink : mark.color,
                      borderRadius: radius.s,
                      fontFamily: font.mono,
                    },
                  ]}
                >
                  {mark.text}
                </Text>
              ) : null}
            </Pressable>
          )
        })}
      </ScrollView>
      <View style={styles.fill}>
        {/* 对话常驻：别的页签显示时只是不画，滚动位置、草稿、键盘前的状态都留着 */}
        <View testID="manager-chat" style={[styles.fill, tab === 'chat' ? null : styles.hidden]}>
          {page.body}
        </View>
        {tab === 'chat' ? null : (
          <View style={styles.fill}>
            {tab === 'console' ? (
              // 类别胶囊放不下（窄屏、英文、大字号）时横着滚，排序固定在行尾
              <View style={styles.categories}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.fill}
                  contentContainerStyle={[styles.pills, narrow ? styles.pillsNarrow : null]}
                >
                  {(Object.keys(KINDS) as Category[]).map((k) => {
                    const on = kind === k
                    const label = t(
                      k === 'report' && counts[k] > 0 ? 'manager.reportUnread' : KINDS[k],
                    )
                    return (
                      <Pressable
                        key={k}
                        role="radio"
                        aria-checked={on}
                        aria-label={counts[k] > 0 ? `${label} ${counts[k]}` : t(KINDS[k])}
                        testID={`manager-category:${k}`}
                        hitSlop={{ top: 6, bottom: 6 }}
                        onPress={() => go('console', k)}
                        style={[
                          styles.pill,
                          narrow ? styles.pillNarrow : null,
                          {
                            borderRadius: radius.l,
                            borderColor: on ? c.accent : c.line2,
                            backgroundColor: on ? c.sunken : 'transparent',
                          },
                        ]}
                      >
                        <Text style={{ color: on ? c.ink : c.ink2, fontSize: font.size.meta + 1 }}>
                          {t(KINDS[k])}
                        </Text>
                        {counts[k] > 0 ? (
                          <Text
                            testID={
                              k === 'report'
                                ? 'manager-reports-unread'
                                : `manager-category-count:${k}`
                            }
                            style={{
                              color: c.wait,
                              fontSize: font.size.meta + 1,
                              fontWeight: '600',
                            }}
                          >
                            {counts[k]}
                          </Text>
                        ) : null}
                      </Pressable>
                    )
                  })}
                </ScrollView>
                <Pressable
                  accessibilityRole="button"
                  aria-label={`${t('manager.order')}: ${t(`manager.order.${order}`)}`}
                  testID="manager-issue-order"
                  onPress={() => setOrdering(true)}
                  style={[styles.order, { minHeight: hit, minWidth: narrow ? hit : undefined }]}
                >
                  <Text style={{ color: c.ink2, fontSize: font.size.meta + 1 }}>
                    {narrow
                      ? theme.skin === 'retro'
                        ? '↕'
                        : '⇅'
                      : `${t(`manager.order.${order}`)} ▾`}
                  </Text>
                </Pressable>
              </View>
            ) : null}
            {device?.connection !== 'online' || manager.status !== 'active' ? (
              <Text testID="manager-state-note" style={[styles.note, { color: c.ink3 }]}>
                {t(
                  device?.connection !== 'online'
                    ? 'manager.offline'
                    : manager.status === 'ending'
                      ? 'manager.ending'
                      : 'manager.ended',
                )}
              </Text>
            ) : missing.length && tab === 'console' ? (
              <Text
                testID="manager-old-device"
                role="note"
                style={[styles.note, { color: c.ink2 }]}
              >
                {t('manager.oldDevice', {
                  items: missing
                    .map((key) => t(`manager.feature.${key}`))
                    .join(t('manager.feature.join')),
                })}
              </Text>
            ) : null}
            <ScrollView ref={scroll} style={styles.fill}>
              {board ? (
                <IssueContext.Provider value={{ manager, board, features, open: openIssue }}>
                  {tab === 'overview' ? (
                    <ManagerOverview
                      board={board}
                      onDecisions={() => go('console', 'decision')}
                      onItems={() => {
                        setFocusItem('*')
                        scroll.current?.scrollTo({ y: itemsAt.current, animated: true })
                      }}
                      onIssue={openIssue}
                      onLine={openSession}
                      focusItem={focusItem}
                      onItemsAt={(y) => {
                        itemsAt.current = y
                      }}
                    />
                  ) : null}
                  {tab === 'lines' ? (
                    <ManagerLines deviceId={deviceId} board={board} onOpen={openSession} />
                  ) : null}
                  {tab === 'console'
                    ? orderedIssues(
                        (board.posts ?? []).filter(
                          (p) => p.kind === kind && (!selected || p.id === selected),
                        ),
                        board,
                        order,
                        suggestions,
                      ).map((post) => (
                        <Issue
                          key={post.id}
                          manager={manager}
                          post={post}
                          board={board}
                          suggestions={suggestions}
                          talking={talkId === post.id}
                          onTalk={(open) => setTalkId(open ? post.id : null)}
                          onPosition={(y) => positions.current.set(post.id, y)}
                          onBack={() => {
                            setTalkId(null)
                            scroll.current?.scrollTo({
                              y: positions.current.get(post.id) ?? 0,
                              animated: false,
                            })
                          }}
                        />
                      ))
                    : null}
                  {tab === 'console' && !(board.posts ?? []).some((p) => p.kind === kind) ? (
                    <Text style={[styles.note, { color: c.ink3 }]}>{t('manager.none')}</Text>
                  ) : null}
                </IssueContext.Provider>
              ) : (
                <Empty title={t('manager.loading')} />
              )}
            </ScrollView>
          </View>
        )}
      </View>
      {page.overlays}
      <Sheet
        visible={ordering}
        title={t('manager.order')}
        onClose={() => setOrdering(false)}
        actions={MANAGER_ISSUE_ORDERS.map((key) => ({
          label: t(`manager.order.${key}`),
          testID: `manager-issue-order:${key}`,
          selected: order === key,
          onPress: () => setIssueOrder(key),
        }))}
      />
      {board ? (
        <IssueSheet
          manager={manager}
          board={board}
          features={features}
          suggestions={suggestions}
          id={sheet}
          onClose={() => setSheet(null)}
          onConsole={(id, talk) => openIssue(id, talk)}
        />
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { display: 'none' },
  tabsRow: { flexGrow: 0, borderBottomWidth: 1 },
  tabs: { paddingHorizontal: 4, alignItems: 'stretch' },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    borderBottomWidth: 2,
  },
  tabNarrow: { paddingHorizontal: 7 },
  count: { borderWidth: 1, paddingHorizontal: 4, minWidth: 18, textAlign: 'center', fontSize: 11 },
  glyph: { fontSize: 12 },
  categories: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  // 滚动区会裁掉 hitSlop，上下留 6 让胶囊的点击区够高；整行高度由行尾 44 高的排序按钮定
  pills: { alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  pillsNarrow: { gap: 4, paddingHorizontal: 8 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillNarrow: { paddingHorizontal: 7 },
  order: {
    marginLeft: 'auto',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  note: { padding: 12 },
})
