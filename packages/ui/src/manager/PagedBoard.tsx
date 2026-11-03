import { managerBoardPages } from '@litch/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ManagerBoardTopicView,
  ManagerObjectId,
  ManagerView,
} from '../../../core/src/model-manager.mts'
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
import { Decisions } from './Decisions.tsx'
import { IssueOrderSelect, useIssueOrder } from './issue-order.tsx'
import { Reports } from './Reports.tsx'
import { Requests } from './Requests.tsx'

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
  const [filters, setFilters] = useState<Record<string, string>>({})
  const status = filters[kind] ?? managerPageStates[kind][0]
  const query = useMemo(() => ({ kind, status, order }), [kind, status, order])
  const key = managerPageKey(query)
  const page = paging.pages[key]
  const [selected, setSelected] = useState<ManagerObjectId | null>(null)
  const [linked, setLinked] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())
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
    [invoke, channel, address],
  )
  useEffect(() => {
    setLinked(false)
    if (kinds[tab]) invoke(channel.command('managers.board.page', { ...address, ...query }))
  }, [tab, invoke, channel, address, query])
  useEffect(() => {
    if (target) {
      setLinked(true)
      open(target)
      onLocated()
    }
  }, [target, open, onLocated])
  useLayoutEffect(() => {
    const host = root.current?.closest('.mg-body')
    if (!host) return
    const positionKey = `${tab}/${key}`
    host.scrollTop = positions.current.get(positionKey) ?? 0
    const remember = () => positions.current.set(positionKey, host.scrollTop)
    host.addEventListener('scroll', remember)
    return () => {
      host.removeEventListener('scroll', remember)
    }
  }, [tab, key])
  const active =
    selected && (linked || page?.entries.some((head) => head.id === selected)) ? selected : null
  const post = board.posts?.find((post) => post.id === active)
  const item = board.items.find((item) => item.id === active)
  const pages = managerBoardPages(board)
  const history = active ? paging.histories[active] : undefined
  const focused = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!active) {
      focused.current = null
      return
    }
    if ((!post && !item) || focused.current === active) return
    focused.current = active
    root.current?.querySelector('[data-paging-detail]')?.scrollIntoView({ block: 'start' })
  }, [active, post, item])
  const lines = paging.summary.lines
  return (
    <div ref={root} className="mg-stack" data-manager-paging>
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
                  setFilters({ ...filters, [kind]: filter })
                  setLinked(false)
                }}
              >
                {t(managerPageLabel(kind, filter) as Parameters<typeof t>[0])} ·{' '}
                {paging.summary.counts[kind][filter] ?? 0}
              </button>
            ))}
          </div>
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
              {page.entries.map((head) => (
                <article className="mg-card" key={head.id} data-paging-object={head.id}>
                  <button
                    className="mg-paging-head"
                    type="button"
                    aria-expanded={active === head.id}
                    onClick={() => {
                      setLinked(false)
                      if (active === head.id) setSelected(null)
                      else open(head.id)
                    }}
                  >
                    <span className="mono">{head.id}</span> · {head.title} ·{' '}
                    {t(managerPageLabel(kind, head.status) as Parameters<typeof t>[0])}
                  </button>
                  <p className="mg-paging-preview">{head.preview}</p>
                </article>
              ))}
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
          {active ? (
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
            </section>
          ) : null}
        </>
      ) : null}
      <Decisions
        manager={manager}
        posts={board.posts ?? []}
        decisions={board.decisions}
        changes={board.changes}
        requests={board.requests ?? []}
        groups={pages.decisions}
        onlyId={active}
        visible={Boolean(kinds[tab] && active?.startsWith('D-'))}
        disabled={disabled}
        target={null}
        onLocated={() => {}}
        onBusy={() => {}}
      />
      {active && kinds[tab] ? (
        <section>
          {!history || history.nextCursor ? (
            <button
              type="button"
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
    </div>
  )
}
