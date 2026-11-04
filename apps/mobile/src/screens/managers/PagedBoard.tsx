import type {
  ManagerBoardTopicView,
  ManagerObjectId,
  ManagerView,
  SuggestionView,
} from '@litch/core'
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  type BoardPageMemory,
  boardPageMemory,
  managerBoardMemory,
} from '../../../../../packages/core/src/manager-board-memory.mts'
import {
  type ManagerDraftMark,
  pagedDraftBoard,
} from '../../../../../packages/core/src/projection/manager-drafts.mts'
import { nextOpenDecision } from '../../../../../packages/core/src/projection/manager-next.mts'
import {
  managerHistorySnapshot,
  managerPageKey,
  managerPageLabel,
  managerPageStates,
} from '../../../../../packages/core/src/projection/manager-paging.mts'
import type { ManagerPageKind } from '../../../../../packages/protocol/src/manager-paging.mts'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import type { Palette } from '../../ui/palettes'
import { useTheme } from '../../ui/theme'
import { animateNextLayout } from './card-motion'
import { draftMarks } from './draft-marks'
import { Issue } from './Issue'
import { Markdown } from './IssueMarkdown'
import { setIssueOrder, useIssueOrder } from './issue-order'
import { ManagerLines } from './ManagerLines'
import {
  ItemRow,
  ManagerOverview,
  type OverviewCategory,
  type OverviewCounts,
} from './ManagerOverview'
import { canAnimateToggle } from './presentation'
import { useDraftVersion } from './use-draft-files'

/** “下一个”展开后卡头离可视区顶端的边距 */
const PIN_MARGIN = 8

export function PagedBoard({
  manager,
  view,
  tab,
  kind: category,
  target,
  suggestions,
  onLine,
  overviewCounts,
  onCategory,
  onQuery,
  onDetail,
  locator,
  nexter,
  onNextChange,
}: {
  manager: ManagerView
  view: ManagerBoardTopicView & {
    board: NonNullable<ManagerBoardTopicView['board']>
    paging: NonNullable<ManagerBoardTopicView['paging']>
  }
  tab: string
  kind: Exclude<ManagerPageKind, 'item'>
  target: string | null
  suggestions: readonly SuggestionView[]
  onLine(id: string, title?: string): void
  overviewCounts: OverviewCounts
  onCategory(category: OverviewCategory): void
  onQuery(memory: BoardPageMemory, ready: boolean): void
  onDetail(y: number, relative?: boolean): void
  /** 底部提交条点草稿数时问这里：当前滚动位置之后下一张有草稿的卡在哪，到底了回到第一张 */
  locator?: MutableRefObject<((from: number) => number | null) | null>
  /** 提交条点“下一个”时调这里：展开下一个待答的决策，卡头停在顶部 */
  nexter?: MutableRefObject<(() => void) | null>
  /** “下一个”能不能点：null 是这一页不适用（不是决策列表） */
  onNextChange?(available: boolean | null): void
}) {
  const channel = useChannel()
  const t = useT()
  const { c, hit, font } = useTheme()
  const board = view.board
  const paging = view.paging
  const order = useIssueOrder()
  const memory = managerBoardMemory(manager.deviceId, manager.id)
  const [, renderMemory] = useState(0)
  const items = memory.items
  const setItems = (value: boolean) => {
    memory.items = value
    renderMemory((value) => value + 1)
  }
  const kind: ManagerPageKind = tab === 'overview' ? 'item' : category
  const status = memory.filters[kind] ?? managerPageStates[kind][0]
  const query = useMemo(() => ({ kind, status, order }), [kind, status, order])
  const key = managerPageKey(query)
  const page = paging.pages[key]
  const reading = boardPageMemory(
    memory,
    tab,
    tab === 'console' || (tab === 'overview' && items) ? key : '',
  )
  const selected = reading.selected
  const setSelected = useCallback(
    (id: ManagerObjectId | null) => {
      reading.selected = id
      renderMemory((value) => value + 1)
    },
    [reading],
  )
  const [linkedPage, setLinkedPage] = useState<BoardPageMemory | null>(null)
  const linked = linkedPage === reading
  const setLinked = useCallback(
    (value: boolean) => setLinkedPage(value ? reading : null),
    [reading],
  )
  const [talking, setTalking] = useState(false)
  const [error, setError] = useState('')
  const positions = useRef(new Map<string, number>())
  const focused = useRef<string | null>(null)
  const address = useMemo(
    () => ({ deviceId: manager.deviceId, managerId: manager.id }),
    [manager.deviceId, manager.id],
  )
  const invoke = useCallback((request: Promise<unknown>) => {
    void request.then(
      () => setError(''),
      (error) => setError(String(error)),
    )
  }, [])
  const open = useCallback(
    (id: ManagerObjectId) => {
      setSelected(id)
      invoke(channel.command('managers.board.detail', { ...address, id }))
    },
    [invoke, channel, address, setSelected],
  )
  const list = tab === 'console' || (tab === 'overview' && items)
  useLayoutEffect(() => {
    if (tab === 'chat') return
    focused.current = null
    positions.current.clear()
    setLinked(false)
    if (list) invoke(channel.command('managers.board.page', { ...address, ...query }))
  }, [list, tab, invoke, channel, address, query, setLinked])
  const locatedTarget = useRef<string | null>(null)
  useEffect(() => {
    if (target && locatedTarget.current !== target) {
      // 先进入事项列表，再把目标写进该列表的记忆，不能写进概览摘要的格子。
      if (target.startsWith('I-') && !items) {
        memory.items = true
        renderMemory((value) => value + 1)
        return
      }
      setLinked(true)
      open(target as ManagerObjectId)
    }
    locatedTarget.current = target
  }, [target, open, memory, setLinked, items])
  const active =
    selected && (linked || page?.entries.some((head) => head.id === selected)) ? selected : null
  const post = board.posts?.find((post) => post.id === active)
  const item = board.items.find((item) => item.id === active)
  const [detailAttempt, setDetailAttempt] = useState<ManagerObjectId | null>(null)
  useEffect(() => {
    if (selected && page && !linked && !page.entries.some((head) => head.id === selected))
      setSelected(null)
  }, [selected, page, linked, setSelected])
  useEffect(() => {
    if (!active || post || item) return
    let live = true
    void channel.command('managers.board.detail', { ...address, id: active }).then(
      () => {},
      (error) => {
        if (live) {
          setError(String(error))
          setDetailAttempt(active)
        }
      },
    )
    return () => {
      live = false
    }
  }, [active, post, item, channel, address])
  const ready =
    (!list || Boolean(page) || Boolean(error || paging.error)) &&
    (!active || Boolean(post || item) || detailAttempt === active)
  useLayoutEffect(() => {
    if (tab !== 'chat') onQuery(reading, ready)
  }, [tab, reading, ready, onQuery])
  const history = active ? paging.histories[active] : undefined
  const draftBoard = useMemo(
    () =>
      pagedDraftBoard(
        board,
        Object.values(paging.pages).flatMap((one) => one.entries),
      ),
    [board, paging.pages],
  )
  // 收起的卡头标出草稿：每次重画读一遍手机上的草稿文件（展开、收起都会重画）
  useDraftVersion()
  const located = useRef<string | null>(null)
  const marks = draftMarks(draftBoard, address, page?.entries ?? [])
  if (locator)
    locator.current = (from) => {
      const heads = (page?.entries ?? []).flatMap((head) => {
        const state = marks.get(head.id)?.state
        const y = positions.current.get(head.id)
        return (state === 'live' || state === 'conflict') && y !== undefined
          ? [{ id: head.id, y }]
          : []
      })
      let next = heads.find((head) => head.y > from + 8) ?? heads[0]
      // 列表末尾的卡滚不到顶：又落到上次那张时换下一张，到底了回到第一张
      if (next && next.id === located.current)
        next = heads[(heads.indexOf(next) + 1) % heads.length]
      located.current = next?.id ?? null
      return next?.y ?? null
    }
  // 提交条上的“下一个”（规则同桌面）：展开后等这一轮布局排好，把卡头滚到顶部留一点边距
  const pinned = useRef<string | null>(null)
  const detailTo = useRef(onDetail)
  detailTo.current = onDetail
  const nextApplies = tab === 'console' && kind === 'decision' && Boolean(page)
  const nextId = nextApplies
    ? nextOpenDecision(page?.entries ?? [], active, (id) => marks.get(id)?.state === 'live')
    : null
  if (nexter)
    nexter.current = () => {
      if (!nextId) return
      if (canAnimateToggle(active, nextId, positions.current)) animateNextLayout()
      focused.current = null
      pinned.current = nextId
      setLinked(false)
      open(nextId)
    }
  useEffect(
    () => onNextChange?.(nextApplies ? Boolean(nextId) : null),
    [nextApplies, nextId, onNextChange],
  )
  useEffect(() => () => onNextChange?.(null), [onNextChange])
  useEffect(() => {
    const id = pinned.current
    if (!id || active !== id) return
    const timer = setTimeout(() => {
      pinned.current = null
      const y = positions.current.get(id)
      if (y !== undefined) detailTo.current(Math.max(0, y - PIN_MARGIN))
    }, 120)
    return () => clearTimeout(timer)
  }, [active])
  // 只有改过的对象才有旧版本可看
  const activeRevision =
    page?.entries.find((head) => head.id === active)?.revision ?? post?.revision ?? 2
  const lines = paging.summary.lines
  const style = { color: c.ink, fontSize: font.size.body }
  const detail = active ? (
    <View
      testID={`paging-detail:${active}`}
      onLayout={(event) => {
        // 编号跳转可能不在当前分页里；只有这种导航才主动定位详情。
        if (linked && !page?.entries.some((head) => head.id === active))
          onDetail(event.nativeEvent.layout.y + 12)
      }}
    >
      {!post && !item && !paging.loading.includes(active) ? (
        <>
          <Text accessibilityRole="alert" style={{ color: c.err }}>
            {error || paging.error}
          </Text>
          <Button kind="plain" label={t('manager.paging.retry')} onPress={() => open(active)} />
        </>
      ) : null}
      {post ? (
        <Issue
          inline
          key={post.id}
          manager={manager}
          post={post}
          board={board}
          suggestions={suggestions}
          talking={talking}
          onTalk={setTalking}
          onBack={() => setTalking(false)}
          onPosition={() => {}}
        />
      ) : null}
      {item ? <ItemRow item={item} focused /> : null}
      {(history || activeRevision > 1) && (!history || history.nextCursor) ? (
        <Button
          testID="paging-history"
          kind="plain"
          label={t(history ? 'manager.paging.more' : 'manager.postHistory')}
          busy={paging.loading.includes(`history:${active}`)}
          onPress={() =>
            invoke(
              channel.command('managers.board.history', {
                ...address,
                id: active,
                more: Boolean(history),
              }),
            )
          }
        />
      ) : null}
      {history?.changes.map((change) => {
        const snapshot = managerHistorySnapshot(change)
        return (
          <View key={change.id}>
            <Text style={style}>
              {snapshot?.revision ? `v${snapshot.revision} · ` : ''}
              {snapshot?.title} · {new Date(change.at).toLocaleString()}
            </Text>
            <Markdown text={change.why} />
            {snapshot ? <Markdown text={snapshot.body} /> : null}
          </View>
        )
      })}
    </View>
  ) : null
  return (
    <View testID="manager-paging" style={{ gap: 12, padding: 12 }}>
      {error || paging.error ? (
        <Text accessibilityRole="alert" style={{ color: c.err }}>
          {error || paging.error}
        </Text>
      ) : null}
      {tab === 'overview' ? (
        // 概览贴着页面两边排，抵掉外层的留白；刷新是现状卡头上的小图标
        <View style={{ marginHorizontal: -12, marginTop: -12 }}>
          <ManagerOverview
            situation={paging.summary.situation}
            counts={overviewCounts}
            onCategory={onCategory}
            refresh={{
              busy: paging.loading.includes('summary'),
              run: () => invoke(channel.command('managers.board.refresh', address)),
            }}
          />
          <Pressable
            testID="paging-items"
            accessibilityRole="button"
            aria-expanded={items}
            onPress={() => setItems(!items)}
            style={{ minHeight: hit, justifyContent: 'center', paddingHorizontal: 16 }}
          >
            <Text style={{ color: c.ink2, fontSize: font.size.meta + 1, fontWeight: '600' }}>
              {items ? '▾' : '▸'} {t('manager.items')}
            </Text>
          </Pressable>
        </View>
      ) : (
        <Button
          kind="plain"
          label={t('manager.paging.refresh')}
          busy={paging.loading.includes('summary')}
          onPress={() => invoke(channel.command('managers.board.refresh', address))}
        />
      )}
      {tab === 'lines' ? (
        <>
          <Text style={style}>
            {lines.checkedAt === null
              ? t('manager.paging.unchecked')
              : `${t('manager.paging.checked')} · ${new Date(lines.checkedAt).toLocaleString()}`}
          </Text>
          {lines.failed ? (
            <Text accessibilityRole="alert" style={{ color: c.err }}>
              {t('manager.paging.failed', { n: lines.failed })}
            </Text>
          ) : null}
          <Button
            kind="plain"
            label={t('manager.paging.refresh')}
            busy={paging.loading.includes('lines')}
            onPress={() =>
              invoke(channel.command('managers.board.refresh', { ...address, lines: true }))
            }
          />
          <ManagerLines
            deviceId={manager.deviceId}
            board={board}
            lineHeads={lines.lines}
            onOpen={onLine}
          />
        </>
      ) : null}
      {list ? (
        <>
          {tab === 'overview' ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(['newest', 'oldest', 'pending'] as const).map((sort) => (
                <Button
                  key={sort}
                  testID={`paging-order:${sort}`}
                  kind="plain"
                  label={t(`manager.order.${sort}`)}
                  onPress={() => setIssueOrder(sort)}
                />
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {managerPageStates[kind].map((filter) => (
              <Pressable
                key={filter}
                accessibilityRole="button"
                accessibilityState={{ selected: status === filter }}
                testID={`paging-filter:${filter}`}
                onPress={() => {
                  setLinked(false)
                  memory.filters[kind] = filter
                  renderMemory((value) => value + 1)
                }}
                style={{
                  minHeight: hit,
                  justifyContent: 'center',
                  borderBottomWidth: status === filter ? 2 : 0,
                  borderBottomColor: c.accent,
                }}
              >
                <Text style={style}>
                  {t(managerPageLabel(kind, filter) as Parameters<typeof t>[0])} ·{' '}
                  {paging.summary.counts[kind][filter] ?? 0}
                </Text>
              </Pressable>
            ))}
          </View>
          {linked && active && !page?.entries.some((head) => head.id === active) ? detail : null}
          {!page ? (
            <Button
              label={t('manager.paging.retry')}
              onPress={() =>
                invoke(channel.command('managers.board.page', { ...address, ...query }))
              }
            />
          ) : (
            <>
              {page.entries.map((head) => {
                const mark = marks.get(head.id)
                return (
                  <View
                    key={head.id}
                    onLayout={(event) => {
                      const y = event.nativeEvent.layout.y
                      const previous = positions.current.get(head.id)
                      positions.current.set(head.id, y)
                      if (focused.current === head.id && previous !== undefined)
                        onDetail(y - previous, true)
                      if (linked && active === head.id) onDetail(y + 12)
                    }}
                  >
                    <Pressable
                      testID={`paging-object:${head.id}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: active === head.id }}
                      aria-expanded={active === head.id}
                      onPress={() => {
                        if (canAnimateToggle(active, head.id, positions.current))
                          animateNextLayout()
                        focused.current = head.id
                        setLinked(false)
                        if (active === head.id) setSelected(null)
                        else open(head.id)
                      }}
                      style={({ pressed }) => ({
                        minHeight: hit,
                        padding: 12,
                        backgroundColor: pressed ? c.press : c.panel,
                        gap: 8,
                      })}
                    >
                      <Text style={style}>
                        {active === head.id ? '▾' : '▸'} {head.id} · {head.title} ·{' '}
                        {t(managerPageLabel(kind, head.status) as Parameters<typeof t>[0])}
                        {mark ? <DraftPill mark={mark} c={c} size={font.size.meta} /> : null}
                      </Text>
                      {/* 有草稿：摘要占一行、预览让出一行，卡头高度不变 */}
                      {mark && active !== head.id ? (
                        <DraftSummary
                          mark={mark}
                          option={
                            board.decisions
                              .find((one) => one.id === head.id)
                              ?.options.find((one) => one.id === mark.optionId)?.label ?? null
                          }
                          request={kind === 'request'}
                          c={c}
                          id={head.id}
                        />
                      ) : null}
                      <Text numberOfLines={mark ? 1 : 2} style={{ color: c.ink2 }}>
                        {head.preview}
                      </Text>
                    </Pressable>
                    {active === head.id ? detail : null}
                  </View>
                )
              })}
              <Text style={style}>
                {t('manager.paging.loaded', { n: page.entries.length, total: page.total })}
              </Text>
              {page.nextCursor ? (
                <Button
                  testID="paging-more"
                  label={t('manager.paging.more')}
                  busy={paging.loading.includes(key)}
                  onPress={() =>
                    invoke(
                      channel.command('managers.board.page', { ...address, ...query, more: true }),
                    )
                  }
                />
              ) : null}
            </>
          )}
        </>
      ) : null}
    </View>
  )
}

/** 卡头末尾的草稿记号：照常、待确认、已失效 */
function DraftPill({ mark, c, size }: { mark: ManagerDraftMark; c: Palette; size: number }) {
  const t = useT()
  return (
    <Text
      testID={`draft-pill:${mark.state}`}
      style={{
        color: mark.state === 'live' ? c.wait : mark.state === 'conflict' ? c.err : c.ink2,
        fontSize: size,
        fontWeight: '600',
      }}
    >
      {'  '}
      {mark.state === 'live'
        ? t('manager.draft')
        : t(mark.state === 'conflict' ? 'manager.draftMark.conflict' : 'manager.draftMark.ended')}
    </Text>
  )
}

/** 收起时一行写草稿里有什么；失效的划掉 */
function DraftSummary({
  mark,
  option,
  request,
  c,
  id,
}: {
  mark: ManagerDraftMark
  option: string | null
  request: boolean
  c: Palette
  id: string
}) {
  const t = useT()
  const parts = [
    mark.optionId
      ? option
        ? t('manager.draftMark.chose', { option })
        : t('manager.draftMark.chosen')
      : null,
    mark.text ? t(request ? 'manager.draftMark.reply' : 'manager.draftMark.text') : null,
    mark.question ? t('manager.draftMark.question') : null,
  ].filter(Boolean)
  return (
    <Text
      testID={`draft-summary:${id}`}
      numberOfLines={1}
      style={{
        color: mark.state === 'live' ? c.wait : mark.state === 'conflict' ? c.err : c.ink2,
        textDecorationLine: mark.state === 'ended' ? 'line-through' : 'none',
      }}
    >
      ✎ {parts.join(' · ')}
    </Text>
  )
}
