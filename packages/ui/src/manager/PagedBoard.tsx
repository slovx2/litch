import { managerBoardPages } from '@litch/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { boardPageMemory, managerBoardMemory } from '../../../core/src/manager-board-memory.mts'
import type {
  ManagerBoardTopicView,
  ManagerObjectId,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import {
  type ManagerDraftMark,
  managerDraftMark,
  pagedDraftBoard,
} from '../../../core/src/projection/manager-drafts.mts'
import {
  managerHistorySnapshot,
  managerPageKey,
  managerPageLabel,
  managerPageStates,
} from '../../../core/src/projection/manager-paging.mts'
import type { ManagerPageKind } from '../../../protocol/src/manager-paging.mts'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { ManagerSuggestions } from '../tree/SuggestionsPage.tsx'
import { Activity } from './Activity.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { BoardPanels, Item } from './BoardPanels.tsx'
import { useBoardScroll } from './board-memory.ts'
import { useCardMotion, useCardPress } from './card-motion.ts'
import { Decisions } from './Decisions.tsx'
import { useAnswerDrafts } from './drafts.ts'
import { IssueOrderSelect, useIssueOrder } from './issue-order.tsx'
import { InlinePostContext } from './PostCard.tsx'
import { usePostDrafts } from './post-drafts.ts'
import { Reports } from './Reports.tsx'
import { Requests } from './Requests.tsx'
import { useRequestDrafts } from './request-drafts.ts'

const kinds: Record<string, ManagerPageKind> = {
  decisions: 'decision',
  requests: 'request',
  suggestions: 'suggestion',
  reports: 'report',
  items: 'item',
}
export function PagedBoard({
  manager,
  view,
  tab,
  disabled,
  target,
  onLocated,
  onSuggestionSource,
}: {
  manager: ManagerView
  view: ManagerBoardTopicView & {
    board: NonNullable<ManagerBoardTopicView['board']>
    paging: NonNullable<ManagerBoardTopicView['paging']>
  }
  tab: string
  disabled: boolean
  target: ManagerObjectId | null
  onLocated(): void
  onSuggestionSource(selection: Selection, archived: boolean): void
}) {
  const t = useT()
  const { channel } = useServices()
  const paging = view.paging
  const board = view.board
  const order = useIssueOrder()
  const kind = kinds[tab] ?? 'decision'
  const memory = managerBoardMemory(manager.deviceId, manager.id)
  const [, renderMemory] = useState(0)
  const status = memory.filters[kind] ?? managerPageStates[kind][0]
  const query = useMemo(() => ({ kind, status, order }), [kind, status, order])
  const key = managerPageKey(query)
  const page = paging.pages[key]
  const reading = boardPageMemory(memory, tab, kinds[tab] ? key : '')
  const selected = reading.selected
  const setSelected = useCallback(
    (id: ManagerObjectId | null) => {
      reading.selected = id
      renderMemory((value) => value + 1)
    },
    [reading],
  )
  const [linkedPage, setLinkedPage] = useState<typeof reading | null>(null)
  const linked = linkedPage === reading
  const setLinked = useCallback(
    (value: boolean) => setLinkedPage(value ? reading : null),
    [reading],
  )
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  /** 点开或收起的那张卡：这一轮过渡让它留在原处 */
  const anchor = useRef<string | null>(null)
  const press = useCardPress()
  const address = useMemo(
    () => ({ deviceId: manager.deviceId, managerId: manager.id }),
    [manager.deviceId, manager.id],
  )
  const invoke = useCallback(
    (request: Promise<unknown>) => {
      void request.then(
        () => setError(''),
        (e) => setError(reasonOf(e, t)),
      )
    },
    [t],
  )
  const open = useCallback(
    (id: ManagerObjectId) => {
      setSelected(id)
      invoke(channel.command('managers.board.detail', { ...address, id }))
    },
    [invoke, channel, address, setSelected],
  )
  useEffect(() => {
    setLinked(false)
    if (kinds[tab]) invoke(channel.command('managers.board.page', { ...address, ...query }))
  }, [tab, invoke, channel, address, query, setLinked])
  useEffect(() => {
    if (target) {
      setLinked(true)
      open(target)
      onLocated()
    }
  }, [target, open, onLocated, setLinked])
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
          setError(reasonOf(error, t))
          setDetailAttempt(active)
        }
      },
    )
    return () => {
      live = false
    }
  }, [active, post, item, channel, address, t])
  const restoring = useBoardScroll(
    root,
    reading,
    (!kinds[tab] || Boolean(page) || Boolean(error || paging.error)) &&
      (!active || Boolean(post || item) || detailAttempt === active),
  )
  const pages = managerBoardPages(board)
  const history = active ? paging.histories[active] : undefined
  const { drafts: answerDrafts } = useAnswerDrafts(manager.deviceId, manager.id)
  const { drafts: requestDrafts } = useRequestDrafts(manager.deviceId, manager.id)
  const { drafts: postDrafts } = usePostDrafts(manager.deviceId, manager.id)
  const draftBoard = useMemo(
    () =>
      pagedDraftBoard(
        board,
        Object.values(paging.pages).flatMap((one) => one.entries),
      ),
    [board, paging.pages],
  )
  // 草稿所在的对象不在任何已读的分页里（比如在后面的页），读一次详情，免得被当成失效、漏交
  const fetched = useRef(new Set<string>())
  useEffect(() => {
    const known = new Set(
      [...draftBoard.decisions, ...(draftBoard.requests ?? []), ...(draftBoard.posts ?? [])].map(
        (one) => one.id,
      ),
    )
    for (const id of new Set([
      ...Object.keys(answerDrafts),
      ...Object.keys(requestDrafts),
      ...Object.keys(postDrafts),
    ])) {
      if (known.has(id) || fetched.current.has(id)) continue
      fetched.current.add(id)
      void channel
        .command('managers.board.detail', { ...address, id: id as ManagerObjectId })
        .catch(() => {})
    }
  }, [draftBoard, answerDrafts, requestDrafts, postDrafts, channel, address])
  const markOf = (id: string) =>
    managerDraftMark(draftBoard, id, {
      decision: answerDrafts[id],
      request: requestDrafts[id],
      post: postDrafts[id],
    })
  const focused = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!active) {
      focused.current = null
      return
    }
    if ((!post && !item) || focused.current === active) return
    focused.current = active
    if (linked)
      root.current?.querySelector('[data-paging-detail]')?.scrollIntoView({ block: 'nearest' })
  }, [active, post, item, linked])
  // 展开哪张、详情到没到、卡片增减都过渡；换页签或筛选不过渡
  useCardMotion(
    root,
    JSON.stringify([manager.deviceId, manager.id, tab, key]),
    [
      active,
      Boolean(post || item),
      paging.loading.includes(active ?? ''),
      ...(page?.entries.map((head) => head.id) ?? []),
    ].join('|'),
    anchor,
    !restoring,
  )
  const activeRevision =
    page?.entries.find((head) => head.id === active)?.revision ??
    post?.revision ??
    draftBoard.decisions.find((one) => one.id === active)?.revision ??
    // 版本不明（编号跳转来的、不在已读分页里）：照旧给出按钮
    2
  const detail = active ? (
    <InlinePostContext.Provider value={true}>
      <section data-paging-detail={active}>
        {!post && !item && !paging.loading.includes(active) ? (
          <p role="alert">
            {error || paging.error}
            <button type="button" onClick={() => open(active)}>
              {t('manager.paging.retry')}
            </button>
          </p>
        ) : null}
        {paging.loading.includes(active) ? <p>{t('manager.loading')}</p> : null}
        {post?.kind === 'report' ? (
          <Reports manager={manager} posts={[post]} disabled={disabled} />
        ) : null}
        {post?.kind === 'request' ? (
          <Requests
            manager={manager}
            posts={[post]}
            requests={(board.requests ?? []).filter((r) => r.id === active)}
            disabled={disabled}
            target={null}
            onLocated={() => {}}
          />
        ) : null}
        {post?.kind === 'suggestion' ? (
          <ManagerSuggestions
            onlyId={post.id}
            posts={[post]}
            manager={manager}
            onOpen={onSuggestionSource}
          />
        ) : null}
        {item ? <Item item={item} /> : null}

        <Decisions
          manager={manager}
          posts={board.posts ?? []}
          decisions={board.decisions}
          changes={board.changes}
          requests={board.requests ?? []}
          groups={pages.decisions}
          onlyId={active}
          visible={Boolean(active?.startsWith('D-'))}
          disabled={disabled}
          target={null}
          onLocated={() => {}}
          onBusy={() => {}}
          part="cards"
          draftBoard={draftBoard}
        />
        {/* 只有改过的对象才有旧版本可看；按钮放在卡内末尾，写明是看什么 */}
        {active && kinds[tab] && (history || activeRevision > 1) ? (
          <section className="mg-paging-history">
            {!history || history.nextCursor ? (
              <button
                type="button"
                className="btn ghost"
                data-paging-history
                disabled={paging.loading.includes(`history:${active}`)}
                onClick={() =>
                  invoke(
                    channel.command('managers.board.history', {
                      ...address,
                      id: active,
                      ...(history ? { more: true } : {}),
                    }),
                  )
                }
              >
                <span aria-hidden="true">↺</span>{' '}
                {t(history ? 'manager.paging.more' : 'manager.postHistory')}
              </button>
            ) : null}
            {history?.changes.map((change) => {
              const snapshot = managerHistorySnapshot(change)
              return (
                <article key={change.id}>
                  <b>
                    {snapshot?.revision ? `v${snapshot.revision} · ` : ''}
                    {snapshot?.title}
                  </b>{' '}
                  · <Stamp at={change.at} />
                  <BoardMarkdown text={change.why} />
                  {snapshot ? <BoardMarkdown text={snapshot.body} /> : null}
                </article>
              )
            })}
          </section>
        ) : null}
      </section>
    </InlinePostContext.Provider>
  ) : null
  const lines = paging.summary.lines
  return (
    <div
      ref={root}
      className="mg-stack"
      data-manager-paging
      style={{ visibility: restoring ? 'hidden' : undefined }}
    >
      {error || paging.error ? (
        <p role="alert" className="err">
          {error || paging.error}
        </p>
      ) : null}
      <div className="mg-list-head">
        <button
          type="button"
          disabled={paging.loading.includes('summary')}
          onClick={() => invoke(channel.command('managers.board.refresh', address))}
        >
          {t('manager.paging.refresh')}
        </button>
        {kinds[tab] ? <IssueOrderSelect /> : null}
      </div>
      {tab === 'overview' ? (
        <>
          {paging.summary.situation ? <BoardMarkdown text={paging.summary.situation.text} /> : null}
          <div className="mg-stats">
            {Object.entries(paging.summary.counts).map(([category, counts]) => (
              <p key={category}>
                {t(
                  `manager.${category === 'decision' ? 'decisions' : category === 'item' ? 'items' : `${category}s`}` as Parameters<
                    typeof t
                  >[0],
                )}{' '}
                · {counts.pending ?? 0} / {counts.all ?? 0}
              </p>
            ))}
          </div>
          {board.activities.map((activity) => (
            <Activity key={activity.id} activity={activity} deviceId={manager.deviceId} />
          ))}
        </>
      ) : null}
      {tab === 'lines' || tab === 'overview' ? (
        <>
          <div className="mg-list-head">
            <span>
              {lines.checkedAt === null ? (
                t('manager.paging.unchecked')
              ) : (
                <>
                  {t('manager.paging.checked')} · <Stamp at={lines.checkedAt} />
                </>
              )}
            </span>
            <button
              type="button"
              disabled={paging.loading.includes('lines')}
              onClick={() =>
                invoke(channel.command('managers.board.refresh', { ...address, lines: true }))
              }
            >
              {t('manager.paging.refresh')}
            </button>
          </div>
          {lines.failed ? (
            <p role="alert">{t('manager.paging.failed', { n: lines.failed })}</p>
          ) : null}
          <BoardPanels
            pages={pages}
            deviceId={manager.deviceId}
            tab="lines"
            lineHeads={lines.lines}
            onTab={() => {}}
            target={null}
            onLocated={() => {}}
          />
        </>
      ) : null}
      {kinds[tab] ? (
        <>
          <div className="mg-decision-filter">
            {managerPageStates[kind].map((filter) => (
              <button
                type="button"
                key={filter}
                data-paging-filter={filter}
                aria-pressed={filter === status}
                onClick={() => {
                  memory.filters[kind] = filter
                  renderMemory((value) => value + 1)
                  setLinked(false)
                }}
              >
                {t(managerPageLabel(kind, filter) as Parameters<typeof t>[0])} ·{' '}
                {paging.summary.counts[kind][filter] ?? 0}
              </button>
            ))}
          </div>
          {linked && active && !page?.entries.some((head) => head.id === active) ? detail : null}
          {!page ? (
            <p>
              {t('manager.loading')}{' '}
              <button
                type="button"
                onClick={() =>
                  invoke(channel.command('managers.board.page', { ...address, ...query }))
                }
              >
                {t('manager.paging.retry')}
              </button>
            </p>
          ) : (
            <>
              {page.entries.map((head) => {
                const mark = markOf(head.id)
                const toggle = () => {
                  anchor.current = head.id
                  setLinked(false)
                  if (active === head.id) setSelected(null)
                  else open(head.id)
                }
                return (
                  // 收起的卡整张代理鼠标点击；键盘由卡头按钮负责（Enter、空格，带 aria-expanded）
                  <article
                    className="mg-card"
                    key={head.id}
                    data-paging-object={head.id}
                    data-motion-key={head.id}
                    data-draft-mark={mark?.state}
                    data-card-press={active === head.id ? undefined : ''}
                    tabIndex={-1}
                    {...(active === head.id ? {} : press(toggle))}
                  >
                    <button
                      className="mg-paging-head"
                      type="button"
                      aria-expanded={active === head.id}
                      onClick={toggle}
                    >
                      <span aria-hidden="true">{active === head.id ? '▾' : '▸'}</span>{' '}
                      <span className="mono">{head.id}</span> · {head.title} ·{' '}
                      {t(managerPageLabel(kind, head.status) as Parameters<typeof t>[0])}
                      {mark ? <DraftPill mark={mark} status={head.status} kind={kind} /> : null}
                    </button>
                    {active === head.id ? (
                      detail
                    ) : (
                      <>
                        {mark ? (
                          <DraftSummary
                            mark={mark}
                            option={
                              board.decisions
                                .find((one) => one.id === head.id)
                                ?.options.find((one) => one.id === mark.optionId)?.label ?? null
                            }
                            request={kind === 'request'}
                          />
                        ) : null}
                        <p className="mg-paging-preview" data-short={Boolean(mark) || undefined}>
                          {head.preview}
                        </p>
                      </>
                    )}
                  </article>
                )
              })}
              <p>{t('manager.paging.loaded', { n: page.entries.length, total: page.total })}</p>
              {page.nextCursor ? (
                <button
                  type="button"
                  data-paging-more
                  disabled={paging.loading.includes(key)}
                  onClick={() =>
                    invoke(
                      channel.command('managers.board.page', { ...address, ...query, more: true }),
                    )
                  }
                >
                  {t('manager.paging.more')}
                </button>
              ) : null}
            </>
          )}
        </>
      ) : null}
      {/* 提交条只有一份，固定在列表可视区底部，不跟着某张卡走；有草稿才出现 */}
      <Decisions
        manager={manager}
        posts={board.posts ?? []}
        decisions={board.decisions}
        changes={board.changes}
        requests={board.requests ?? []}
        groups={pages.decisions}
        onlyId={null}
        visible={false}
        disabled={disabled}
        target={null}
        onLocated={() => {}}
        onBusy={() => {}}
        part="send"
        draftBoard={draftBoard}
      />
    </div>
  )
}

/** 卡头末尾的草稿记号：照常、待确认、已失效三种，失效的悬停说明原因 */
function DraftPill({
  mark,
  status,
  kind,
}: {
  mark: ManagerDraftMark
  status: string
  kind: string
}) {
  const t = useT()
  if (mark.state === 'live')
    return (
      <span className="pill wait" data-draft-pill="live">
        {t('manager.draft')}
      </span>
    )
  if (mark.state === 'conflict')
    return (
      <span className="pill err" data-draft-pill="conflict" title={t('manager.conflict')}>
        {t('manager.draftMark.conflict')}
      </span>
    )
  return (
    <span
      className="pill mute"
      data-draft-pill="ended"
      title={t(
        kind === 'request'
          ? status === 'cancelled'
            ? 'manager.draftEnded.cancelled'
            : 'manager.draftEnded.handled'
          : kind !== 'decision'
            ? 'manager.draftEnded.post'
            : status === 'answered'
              ? 'manager.draftEnded.answered'
              : status === 'ignored'
                ? 'manager.draftEnded.ignored'
                : 'manager.draftEnded.closed',
      )}
    >
      {t('manager.draftMark.ended')}
    </span>
  )
}

/** 收起时一行写草稿里有什么：选了哪项、写了说明或回复、写了追问；放不下截断 */
function DraftSummary({
  mark,
  option,
  request,
}: {
  mark: ManagerDraftMark
  option: string | null
  request: boolean
}) {
  const t = useT()
  const parts = [
    mark.optionId
      ? option
        ? t('manager.draftMark.chose', { option })
        : t('manager.draftMark.chosen')
      : null,
    mark.delivered ? t('manager.draftMark.delivered') : null,
    mark.text ? t(request ? 'manager.draftMark.reply' : 'manager.draftMark.text') : null,
    mark.question ? t('manager.draftMark.question') : null,
  ].filter(Boolean)
  return (
    <p className="mg-draft-summary ell" data-draft-summary={mark.state}>
      <span aria-hidden="true">✎</span> {parts.join(' · ')}
    </p>
  )
}
