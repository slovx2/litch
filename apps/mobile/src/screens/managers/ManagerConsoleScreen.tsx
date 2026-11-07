// 手机经理工作台（35-manager 第十七节）：标题栏是经理名和状态，下面一排页签“控制台 · 对话 · 工作线 · 概览”。
// 对话就是经理会话本身（与会话页同一套组件，detail/session-page.tsx），切到别的页签时不卸载、只是不显示，
// 回来时滚动位置和草稿都在；只有对话页签显示着才标已读。默认落在控制台；带 issue 的入口（经理事件、#D-n、受阻事项、
// 工作线回经理）落到控制台（经理事项落到概览）并定位。当前页签存在路由参数里，回经理时可以直接改。
// 议题卡在 Issue.tsx，对话里点编号拉起的半屏议题卡在 IssueSheet.tsx，工作线列表在 ManagerLines.tsx。
import {
  keys,
  MANAGER_ISSUE_ORDERS,
  type ManagerBoardTopicView,
  type ManagerView,
  managerAttentionCount,
  managerReferencesResolver,
  type SessionSummary,
  type SuggestionView,
} from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import type { KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller'
import {
  type BoardPageMemory,
  managerBoardMemory,
} from '../../../../../packages/core/src/manager-board-memory.mts'
import { pagedDraftBoard } from '../../../../../packages/core/src/projection/manager-drafts.mts'
import type { ManagerPost } from '../../../../../packages/protocol/src/manager-posts.mjs'
import { sessionMark } from '../../../../../packages/ui/src/sidebar/session-mark.ts'
import { useSessionPage } from '../../detail/session-page'
import { usePane } from '../../nav/pane'
import type { ManagerTab, RootStackParamList } from '../../nav/routes'
import { useChannel, useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Icon } from '../../ui/kit/Icon'
import { KeyboardArea, KeyboardFormScrollView } from '../../ui/kit/KeyboardForm'
import { Sheet } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { DraftSubmitBar } from './DraftSubmitBar'
import { Issue } from './Issue'
import { IssueContext } from './IssueRelations'
import { IssueSheet } from './IssueSheet'
import { setIssueOrder, useIssueOrder } from './issue-order'
import { ManagerLines } from './ManagerLines'
import { ManagerOverview, type OverviewCounts, OverviewItems } from './ManagerOverview'
import { PagedBoard } from './PagedBoard'
import { issueCounts, managerRowState, orderedIssues } from './presentation'
import { useManagerReset } from './use-reset'

type Props = NativeStackScreenProps<RootStackParamList, 'ManagerConsole'>
type Category = ManagerPost['kind']

const TABS: readonly ManagerTab[] = ['console', 'chat', 'lines', 'overview']
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
/** 比这窄时排序只留图标，四个分类胶囊不被挤出屏 */
const ORDER_TEXT = 400

export function ManagerConsoleScreen({ route, navigation }: Props) {
  const { deviceId, managerId } = route.params
  const replica = useReplica()
  const t = useT()
  useEffect(() => replica.openManagerBoard(deviceId, managerId), [replica, deviceId, managerId])
  const manager = useKey<ManagerView>(keys.manager(deviceId, managerId))
  if (!manager)
    return (
      <Screen title={t('manager.title')} testID="manager-console">
        <Empty busy title={t('manager.loading')} />
      </Screen>
    )
  // 经理会话换了（接手）就整页重来：对话的仓库按会话取
  return (
    <Workbench key={manager.threadId} manager={manager} route={route} navigation={navigation} />
  )
}

function Workbench({ manager, route, navigation }: Props & { manager: ManagerView }) {
  const channel = useChannel()
  const { deviceId, id: managerId } = manager
  const tab: ManagerTab = route.params.tab ?? 'console'
  const t = useT()
  const theme = useTheme()
  const { c, radius, font, hit } = theme
  const { width } = useWindowDimensions()
  const pane = usePane()
  const nativeFocused = useIsFocused()
  const focused = pane?.visible ?? nativeFocused
  const view = useKey<ManagerBoardTopicView>(keys.managerBoard(deviceId, managerId))
  const board = view?.board ?? null
  const pagingOn = Boolean(view?.paging)
  const features = view?.features ?? {
    feedback: true,
    posts: true,
    ignore: true,
    requestIgnore: true,
  }
  const suggestions = useKey<readonly SuggestionView[]>(keys.suggestions) ?? []
  const summary = useKey<SessionSummary>(keys.summary(deviceId, manager.threadId))
  const device = useKey<{ connection?: string }>(keys.device(deviceId))
  const reset = useManagerReset(manager, device?.connection === 'online')
  const order = useIssueOrder()
  const memory = managerBoardMemory(deviceId, managerId)
  const [, renderKind] = useState(0)
  const kind = memory.category
  const setKind = useCallback(
    (kind: Category) => {
      memory.category = kind
      renderKind((value) => value + 1)
    },
    [memory],
  )
  const [ordering, setOrdering] = useState(false)
  const [talkId, setTalkId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [targetVersion, setTargetVersion] = useState(0)
  const [focusItem, setFocusItem] = useState<string | null>(null)
  const [sheet, setSheet] = useState<string | null>(null)
  const positions = useRef(new Map<string, number>())
  const itemsAt = useRef(0)
  const scroll = useRef<KeyboardAwareScrollViewRef>(null)
  const locator = useRef<((from: number) => number | null) | null>(null)
  const nexter = useRef<(() => void) | null>(null)
  /** 提交条“下一个”能不能点；null 是当前列表不适用 */
  const [nextAvailable, setNextAvailable] = useState<boolean | null>(null)
  const [restoringBoard, setRestoringBoard] = useState(false)
  const pagingScroll = useRef<{
    memory: BoardPageMemory | null
    y: number
    ready: boolean
    pending: boolean
  }>({ memory: null, y: 0, ready: false, pending: true })
  // 对话页会隐藏并缩短看板容器；期间的原生滚动归零不是新的阅读位置。
  if (tab === 'chat') {
    pagingScroll.current.pending = true
    pagingScroll.current.ready = false
  }
  const restoreBoard = useCallback(() => {
    const state = pagingScroll.current
    if (!state.pending || !state.ready || !state.memory) return
    scroll.current?.scrollTo({ y: state.memory.y, animated: false })
    // 原生布局完成再显露；异步 scroll 事件在恢复期间不能把旧页签的坐标写进新页签。
    requestAnimationFrame(() => {
      if (pagingScroll.current !== state || !state.ready) return
      scroll.current?.scrollTo({ y: state.memory?.y ?? 0, animated: false })
      state.y = state.memory?.y ?? 0
      state.pending = false
      setRestoringBoard(false)
    })
  }, [])
  const pagingQuery = useCallback(
    (memory: BoardPageMemory, ready: boolean) => {
      const state = pagingScroll.current
      if (state.memory !== memory) {
        pagingScroll.current = { memory, y: memory.y, ready, pending: true }
        setRestoringBoard(true)
      } else {
        state.ready = ready
        if (state.pending) setRestoringBoard(true)
      }
      requestAnimationFrame(restoreBoard)
    },
    [restoreBoard],
  )
  useEffect(() => {
    if (!pagingOn || !sheet) return
    void channel
      .command('managers.board.detail', {
        deviceId,
        managerId,
        id: sheet as import('@litch/core').ManagerObjectId,
      })
      .catch(() => {})
  }, [sheet, pagingOn, channel, deviceId, managerId])

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
    if (!view?.paging) scroll.current?.scrollTo({ y: 0, animated: false })
  }
  // 定位到一条议题：经理事项到概览展开那一项，其他到控制台只列这一条（点类别或页签恢复整列）
  const openIssue = useCallback(
    (id: string, talk = false) => {
      setSheet(null)
      setTargetVersion((value) => value + 1)
      if (id.startsWith('I-')) {
        setSelected(null)
        setFocusItem(id)
        setTab('overview')
        return
      }
      setFocusItem(null)
      setSelected(id)
      setKind(
        id.startsWith('R-')
          ? 'request'
          : id.startsWith('P-')
            ? 'report'
            : id.startsWith('S-')
              ? 'suggestion'
              : 'decision',
      )
      setTalkId(talk ? id : null)
      setTab('console')
      scroll.current?.scrollTo({ y: 0, animated: false })
    },
    [setTab, setKind],
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: 看板变化后重新核对之前不存在的编号
  const resolveReferences = useMemo(
    () =>
      managerReferencesResolver(
        async (ids) =>
          (await channel.command('managers.references.resolve', { deviceId, managerId, ids })).ids,
      ),
    [channel, deviceId, managerId, manager?.updatedAt],
  )
  const issues = useMemo(() => {
    const ids = Object.assign(new Set(idsKey ? idsKey.split(',') : []), {
      deferred: pagingOn,
    })
    return ids.size || ids.deferred
      ? {
          ids,
          resolve: resolveReferences,
          open: (id: string) => {
            // 输入框还拿着焦点时，面板关上后安卓会把焦点还给它、键盘又弹出来：先放掉
            Keyboard.dismiss()
            if (id.startsWith('I-')) openIssue(id)
            else setSheet(id)
          },
        }
      : null
  }, [idsKey, openIssue, pagingOn, resolveReferences])
  const page = useSessionPage({
    deviceId,
    sessionId: manager.threadId,
    title: manager.name || undefined,
    manager: true,
    menu: reset.menu,
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
  // 概览上的控制台四类：未完成数与类别胶囊同源，总数取分页摘要或整份看板
  const totals = view?.paging?.summary.counts
  const postsOf = (category: Category) =>
    (board?.posts ?? []).filter((post) => post.kind === category).length
  const overviewCounts: OverviewCounts = {
    decision: {
      pending: counts.decision,
      total: totals?.decision.all ?? board?.decisions.length ?? 0,
    },
    request: {
      pending: counts.request,
      total: totals?.request.all ?? board?.requests?.length ?? 0,
    },
    report: { pending: counts.report, total: totals?.report.all ?? postsOf('report') },
    suggestion: {
      pending: counts.suggestion,
      total: totals?.suggestion.all ?? postsOf('suggestion'),
    },
  }
  const missing = (['feedback', 'posts', 'ignore', 'requestIgnore'] as const).filter(
    (key) => !features[key],
  )
  const chatMark = sessionMark(summary)
  const waitingLines = (board?.lines ?? []).filter(
    (line) => line.status === 'waiting' || line.status === 'error',
  ).length
  const linesWaiting = waitingLines > 0
  const narrow = width < NARROW

  /**
   * 页签上的记号：对话是经理自己在跑（转圈）、等人（等待色圆点）、有新回复（未读色圆点）；
   * 控制台是待处理数，工作线是在跑条数（有线等人时是等人的条数、换等待色）。数字一律带框，不用文字符号
   */
  const badge = (
    key: ManagerTab,
  ): { kind: 'count' | 'dot' | 'spin'; text?: string; color: string; label: string } | null => {
    if (key === 'chat') {
      if (chatMark === 'run')
        return { kind: 'spin', color: c.accent, label: t('mgr.tab.chatRunning') }
      if (chatMark === 'wait')
        return { kind: 'dot', color: c.wait, label: t('mgr.tab.chatRunning') }
      if (chatMark === 'unread' && tab !== 'chat')
        return { kind: 'dot', color: c.seal, label: t('mgr.tab.chatUnread') }
      return null
    }
    if (key === 'console')
      return pending
        ? {
            kind: 'count',
            text: String(pending),
            color: c.wait,
            label: t('manager.pending', { n: pending }),
          }
        : null
    if (key === 'lines') {
      const running = manager.runningLines
      if (!running && !linesWaiting) return null
      return {
        kind: 'count',
        text: String(linesWaiting ? waitingLines : running),
        color: linesWaiting ? c.wait : c.accent,
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
      actions={[
        ...reset.cancelActions,
        ...page.actions.map((action) =>
          action.testID === 'detail:menu'
            ? {
                ...action,
                attention: reset.attention,
                ...(reset.attention
                  ? {
                      accessibilityLabel: t(
                        manager.reset?.outdated ? 'manager.resetOutdated' : 'manager.reset',
                      ),
                    }
                  : {}),
              }
            : action,
        ),
      ]}
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
              {mark?.kind === 'spin' ? (
                <ActivityIndicator
                  testID={`manager-tab-badge:${key}`}
                  size="small"
                  color={mark.color}
                  style={styles.spin}
                />
              ) : mark?.kind === 'dot' ? (
                <View
                  testID={`manager-tab-badge:${key}`}
                  style={[styles.dot, { backgroundColor: mark.color }]}
                />
              ) : mark ? (
                <Text
                  testID={`manager-tab-badge:${key}`}
                  style={[
                    styles.count,
                    // 选中页签上的计数跟随前景色（复古暗色的浅绿底上不放琥珀字，11.7）
                    {
                      color: on ? c.ink : mark.color,
                      borderColor: on ? c.ink : mark.color,
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
        {/* 输入区常驻保留草稿；对话列表仅在可见时挂载，用贴底状态或消息锚点恢复阅读位置。 */}
        <View testID="manager-chat" style={[styles.fill, tab === 'chat' ? null : styles.hidden]}>
          {page.body}
        </View>
        <KeyboardArea style={tab === 'chat' ? styles.hidden : undefined}>
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
                style={({ pressed }) => [
                  styles.order,
                  {
                    minHeight: hit,
                    minWidth: hit,
                    borderRadius: radius.s,
                    backgroundColor: pressed ? c.press : 'transparent',
                  },
                ]}
              >
                {/* 窄屏只留排序图标；宽一些时图标后写当前排序 */}
                <Icon name="sort" size={16} color={c.ink2} />
                {width < ORDER_TEXT ? null : (
                  <Text style={{ color: c.ink2, fontSize: font.size.meta + 1 }}>
                    {t(`manager.order.${order}`)}
                  </Text>
                )}
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
            <Text testID="manager-old-device" role="note" style={[styles.note, { color: c.ink2 }]}>
              {t('manager.oldDevice', {
                items: missing
                  .map((key) => t(`manager.feature.${key}`))
                  .join(t('manager.feature.join')),
              })}
            </Text>
          ) : null}
          <KeyboardFormScrollView
            testID="manager-board-scroll"
            ref={scroll}
            style={[styles.fill, restoringBoard && { opacity: 0 }]}
            onContentSizeChange={restoreBoard}
            onScroll={(event) => {
              const state = pagingScroll.current
              if (state.pending) return
              state.y = event.nativeEvent.contentOffset.y
              if (state.memory) state.memory.y = state.y
            }}
            scrollEventThrottle={32}
          >
            {view?.loadError ? (
              <>
                <Text accessibilityRole="alert" style={{ color: c.err }}>
                  {view.loadError}
                </Text>
                <Pressable
                  onPress={() => {
                    void channel
                      .command('managers.board.refresh', { deviceId, managerId })
                      .catch(() => {})
                  }}
                >
                  <Text>{t('manager.paging.retry')}</Text>
                </Pressable>
              </>
            ) : board ? (
              <IssueContext.Provider value={{ manager, board, features, open: openIssue }}>
                {view?.paging ? (
                  <PagedBoard
                    manager={manager}
                    view={{ ...view, board, paging: view.paging }}
                    tab={tab}
                    kind={kind}
                    target={selected ?? (focusItem === '*' ? null : focusItem)}
                    targetVersion={targetVersion}
                    suggestions={suggestions}
                    onLine={openSession}
                    overviewCounts={overviewCounts}
                    onCategory={(category) => go('console', category)}
                    onQuery={pagingQuery}
                    locator={locator}
                    nexter={nexter}
                    onNextChange={setNextAvailable}
                    onDetail={(y, relative) => {
                      const next = relative ? pagingScroll.current.y + y : y
                      pagingScroll.current.y = next
                      scroll.current?.scrollTo({ y: next, animated: false })
                    }}
                  />
                ) : (
                  <>
                    {tab === 'overview' ? (
                      <ManagerOverview
                        situation={board.situation}
                        counts={overviewCounts}
                        onCategory={(category) => go('console', category)}
                      >
                        <OverviewItems
                          items={board.items}
                          focusItem={focusItem}
                          onItemsAt={(y) => {
                            itemsAt.current = y
                          }}
                        />
                      </ManagerOverview>
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
                  </>
                )}
              </IssueContext.Provider>
            ) : (
              <Empty busy title={t('manager.loading')} />
            )}
          </KeyboardFormScrollView>
          {/* 批量提交条在滚动区下面，不随卡片滚动，也不挡住最后一张卡 */}
          {tab === 'console' && board && view ? (
            <DraftSubmitBar
              paged={Boolean(view.paging)}
              manager={manager}
              board={board}
              draftBoard={
                view.paging
                  ? pagedDraftBoard(
                      board,
                      Object.values(view.paging.pages).flatMap((one) => one.entries),
                    )
                  : board
              }
              features={features}
              next={
                view.paging && nextAvailable !== null
                  ? { go: () => nexter.current?.(), disabled: !nextAvailable }
                  : undefined
              }
              disabled={device?.connection !== 'online' || manager.status !== 'active'}
              onLocate={
                view.paging
                  ? () => {
                      const y = locator.current?.(pagingScroll.current.y)
                      if (y === null || y === undefined) return
                      pagingScroll.current.y = y
                      scroll.current?.scrollTo({ y, animated: true })
                    }
                  : undefined
              }
            />
          ) : null}
        </KeyboardArea>
      </View>
      {page.overlays}
      {sheet && view?.paging && !board?.posts?.some((post) => post.id === sheet) ? (
        <Sheet
          visible
          title={sheet}
          note={view.paging.error ?? t('manager.loading')}
          onClose={() => setSheet(null)}
          actions={
            view.paging.error
              ? [
                  {
                    label: t('manager.paging.retry'),
                    onPress: () => {
                      void channel
                        .command('managers.board.detail', {
                          deviceId,
                          managerId,
                          id: sheet as import('@litch/core').ManagerObjectId,
                        })
                        .catch(() => {})
                    },
                  },
                ]
              : []
          }
        />
      ) : null}
      {reset.overlay}
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
  count: {
    borderWidth: 1,
    paddingHorizontal: 4,
    minWidth: 18,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '600',
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  spin: { transform: [{ scale: 0.7 }], width: 14, height: 14 },
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
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  note: { padding: 12 },
})
