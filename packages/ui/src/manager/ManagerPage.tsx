import {
  type DeviceView,
  filterSuggestions,
  keys,
  type SuggestionView,
  suggestionCount,
} from '@litch/core'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import type {
  ManagerDecisionId,
  ManagerItemId,
  ManagerRequestId,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { onFindPreparing } from '../search/actions.ts'
import { Transcript } from '../transcript/Transcript.tsx'
import { ManagerSuggestions } from '../tree/SuggestionsPage.tsx'
import { BoardGrip } from './BoardGrip.tsx'
import { BoardPanels } from './BoardPanels.tsx'
import { BoardReferencesContext } from './BoardReferences.tsx'
import { BOARD_GRIP, CHAT_MIN, setBoardLayout, useBoardLayout } from './board-layout.ts'
import { Decisions } from './Decisions.tsx'
import { useManagerBoard } from './data.ts'
import { ManagerForm } from './ManagerForm.tsx'
import { RelationsContext } from './Relations.tsx'
import { Reports } from './Reports.tsx'
import { Requests } from './Requests.tsx'
import type { BoardReference } from './references.ts'

/** 放在应用导航层，离开经理视图后仍能恢复看板页签和设置页。 */
export interface ManagerPageLocation {
  tab:
    | 'overview'
    | 'decisions'
    | 'items'
    | 'lines'
    | 'suggestions'
    | 'requests'
    | 'reports'
    | 'inbox'
  narrow: 'chat' | 'board'
  settings: boolean
}
const defaultLocation: ManagerPageLocation = { tab: 'overview', narrow: 'chat', settings: false }

export function ManagerPage({
  manager,
  onOpen,
  location = defaultLocation,
  onLocation,
  onSuggestionSource,
}: {
  manager: ManagerView
  onSuggestionSource(selection: Selection, archived: boolean): void
  onOpen(selection: Selection): void
  location: ManagerPageLocation | undefined
  onLocation(location: ManagerPageLocation): void
}) {
  const t = useT()
  const { channel } = useServices()
  const { view, pages, error } = useManagerBoard(manager)
  const allSuggestions = useKey<readonly SuggestionView[]>(keys.suggestions) ?? []
  const suggestions = filterSuggestions(allSuggestions, {
    deviceId: manager.deviceId,
    managerId: manager.id,
  })
  const layout = useBoardLayout()
  const page = useRef<HTMLElement>(null)
  const device = useKey<DeviceView>(keys.device(manager.deviceId))
  const { tab, narrow, settings } = location
  useEffect(
    () =>
      onFindPreparing((deviceId, sessionId) => {
        if (
          deviceId === manager.deviceId &&
          sessionId === manager.threadId &&
          location.narrow !== 'chat'
        )
          onLocation({ ...location, narrow: 'chat' })
      }),
    [manager.deviceId, manager.threadId, location, onLocation],
  )
  const boardBody = useRef<HTMLDivElement>(null)
  const setTab = (tab: ManagerPageLocation['tab']) => {
    if (boardBody.current) boardBody.current.scrollTop = 0
    onLocation({ ...location, tab })
  }
  const setNarrow = (narrow: ManagerPageLocation['narrow']) => onLocation({ ...location, narrow })
  const setSettings = (settings: boolean) => onLocation({ ...location, settings })
  const [decisionTarget, setDecisionTarget] = useState<{ id: ManagerDecisionId } | null>(null)
  const decisionLocated = useCallback(() => setDecisionTarget(null), [])
  const [itemTarget, setItemTarget] = useState<{ id: ManagerItemId } | null>(null)
  const itemLocated = useCallback(() => setItemTarget(null), [])
  const [requestTarget, setRequestTarget] = useState<{ id: ManagerRequestId } | null>(null)
  const requestLocated = useCallback(() => setRequestTarget(null), [])
  const openReference = (id: BoardReference) => {
    if (boardBody.current) boardBody.current.scrollTop = 0
    setBoardLayout({ open: true })
    if (id.startsWith('P-') || id.startsWith('S-')) {
      onLocation({
        ...location,
        tab: id.startsWith('P-') ? 'reports' : 'suggestions',
        narrow: 'board',
      })
      setTimeout(() => {
        const card = page.current?.querySelector<HTMLElement>(
          id.startsWith('P-') ? `[data-report="${id}"]` : `[data-proposal="${id.slice(2)}"]`,
        )
        const group = card?.closest('details')
        if (group) group.open = true
        card?.scrollIntoView({ block: 'center' })
        card?.focus()
      }, 0)
      return
    }
    if (id.startsWith('R-')) {
      onLocation({ ...location, tab: 'requests', narrow: 'board' })
      setRequestTarget({ id: id as ManagerRequestId })
      return
    }
    const item = id.startsWith('I-')
    onLocation({ ...location, tab: item ? 'items' : 'decisions', narrow: 'board' })
    setItemTarget(item ? { id: id as ManagerItemId } : null)
    setDecisionTarget(item ? null : { id: id as ManagerDecisionId })
  }
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ managerId: string; id: BoardReference }>).detail
      if (detail.managerId === manager.id) openReference(detail.id)
    }
    window.addEventListener('litch-manager-issue', listener)
    return () => window.removeEventListener('litch-manager-issue', listener)
  })
  const [inboxTab, setInboxTab] = useState<'decisions' | 'suggestions' | 'requests' | 'reports'>(
    'decisions',
  )
  const activeTab = tab === 'inbox' ? inboxTab : tab
  const [responding, setResponding] = useState(false)
  const [ending, setEnding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const board = view?.board
  const attention =
    manager.pendingDecisions +
    (manager.pendingRequests ?? 0) +
    (manager.pendingReports ?? 0) +
    (manager.pendingSuggestions ?? 0)
  const attentionTitle = t('manager.pendingDetail', {
    decisions: manager.pendingDecisions,
    requests: manager.pendingRequests ?? 0,
    reports: manager.pendingReports ?? 0,
    suggestions: manager.pendingSuggestions ?? 0,
  })
  const counts = {
    overview: 0,
    inbox:
      manager.pendingDecisions +
      (manager.pendingRequests ?? 0) +
      (manager.pendingReports ?? 0) +
      (manager.pendingSuggestions ?? 0),
    reports: manager.pendingReports ?? 0,
    requests: manager.pendingRequests ?? 0,
    decisions: manager.pendingDecisions,
    items: (pages?.overview.stats.totalItems ?? 0) - (pages?.overview.stats.doneItems ?? 0),
    lines: manager.runningLines,
    suggestions: suggestionCount(suggestions),
  }
  const readOnly = manager.status !== 'active'
  const readOnlyText = t(manager.status === 'ending' ? 'manager.endingNote' : 'manager.readOnly')
  const disabled = readOnly || device?.connection !== 'online'
  const end = async () => {
    setBusy(true)
    try {
      await channel.command('managers.end', { deviceId: manager.deviceId, managerId: manager.id })
      setEnding(false)
    } catch (cause) {
      setFailure(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  if (settings && !readOnly) {
    return (
      <section className="arch-page" data-manager="settings">
        <header className="arch-head">
          <h1>{t('manager.settings')}</h1>
          <button type="button" className="btn ghost" onClick={() => setSettings(false)}>
            {t('manager.back')}
          </button>
        </header>
        <div className="arch-body">
          <ManagerForm
            key={`${manager.deviceId}:${manager.id}`}
            devices={device ? [device] : []}
            initial={{ view: 'new', deviceId: manager.deviceId }}
            manager={manager}
            disabled={disabled}
            onCancel={() => setSettings(false)}
            onCreated={() => setSettings(false)}
          />
        </div>
      </section>
    )
  }
  return (
    <section
      className="mg-page"
      data-manager="session"
      data-manager-id={manager.id}
      data-manager-status={manager.status}
      data-narrow={narrow}
      data-board-open={layout.open}
      ref={page}
      style={
        {
          '--mg-board-width': `${layout.width}px`,
          '--mg-chat-min': `${CHAT_MIN}px`,
          '--mg-grip-width': `${BOARD_GRIP}px`,
        } as CSSProperties
      }
    >
      <header className="mg-title">
        <span className="pill mute">{t('manager.manager')}</span>
        <b className="ell grow">{manager.name}</b>
        <button
          type="button"
          className="btn ghost mg-board-toggle"
          data-act="manager-board-toggle"
          title={!layout.open && attention > 0 ? attentionTitle : undefined}
          aria-expanded={layout.open}
          aria-controls={`manager-board-${manager.id}`}
          onClick={() => setBoardLayout({ open: !layout.open })}
        >
          {t(layout.open ? 'manager.hideBoard' : 'manager.showBoard')}
          {!layout.open && attention ? (
            <span className="pill wait" title={attentionTitle}>
              {t('manager.pending', { n: attention })}
            </span>
          ) : null}
        </button>
        {manager.status === 'active' ? (
          <>
            <button
              type="button"
              className="btn ghost"
              data-act="manager-settings"
              disabled={disabled}
              title={disabled ? t('manager.offline') : undefined}
              onClick={() => setSettings(true)}
            >
              {t('manager.settings')}
            </button>
            <button
              type="button"
              className="btn ghost"
              data-act="manager-end"
              disabled={disabled}
              title={disabled ? t('manager.offline') : undefined}
              onClick={() => setEnding(true)}
            >
              {t('manager.end')}
            </button>
          </>
        ) : (
          <span className="dim">{t(`manager.${manager.status}`)}</span>
        )}
      </header>
      {ending && !readOnly ? (
        <div className="mg-end" role="alert">
          <span className="grow">{t('manager.endNote')}</span>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => setEnding(false)}
          >
            {t('manager.cancel')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void end()}>
            {t('manager.end')}
          </button>
          {failure ? <p className="err">{failure}</p> : null}
        </div>
      ) : null}
      <div className="mg-narrow seg">
        {(['chat', 'board'] as const).map((key) => (
          <button
            type="button"
            key={key}
            title={key === 'board' ? attentionTitle : undefined}
            aria-pressed={narrow === key}
            onClick={() => setNarrow(key)}
          >
            {t(`manager.${key}`)}
            {key === 'board' && attention ? ` · ${t('manager.pending', { n: attention })}` : ''}
          </button>
        ))}
      </div>
      <div className="mg-chat">
        <Transcript
          deviceId={manager.deviceId}
          sessionId={manager.threadId}
          onOpen={onOpen}
          footer={readOnly ? <p className="mg-readonly">{readOnlyText}</p> : undefined}
        />
      </div>
      <BoardGrip page={page} />
      <section
        id={`manager-board-${manager.id}`}
        className="mg-board"
        aria-label={t('manager.board')}
      >
        {manager.rules ? (
          <div className="mg-scope">
            <span className="dim">{t('manager.prompt')}</span>
            <span className="ell" title={manager.rules}>
              {manager.rules}
            </span>
          </div>
        ) : null}
        <div className="side-tabs">
          <div className="side-tablist" role="tablist">
            {(['overview', 'items', 'inbox'] as const).map((key) => (
              <button
                type="button"
                role="tab"
                className="side-tab"
                key={key}
                data-board-tab={key}
                aria-selected={
                  key === tab ||
                  (key === 'inbox' &&
                    ['decisions', 'requests', 'suggestions', 'reports'].includes(tab))
                }
                onClick={() => setTab(key)}
              >
                {t(`manager.${key}`)}
                {counts[key] ? (
                  <span className={key === 'inbox' ? 'pill wait' : 'pill mute'}>{counts[key]}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        {['inbox', 'decisions', 'requests', 'suggestions', 'reports'].includes(tab) ? (
          <div className="mg-inbox-tabs seg">
            {(['decisions', 'suggestions', 'requests', 'reports'] as const).map((kind) => (
              <button
                type="button"
                data-inbox-tab={kind}
                data-board-tab={kind}
                key={kind}
                aria-pressed={activeTab === kind}
                onClick={() => {
                  setInboxTab(kind)
                  setTab(kind)
                }}
              >
                {t(`manager.${kind}`)}
                {counts[kind] ? <span className="pill wait">{counts[kind]}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {disabled ? (
          <p className="mg-readonly">{readOnly ? readOnlyText : t('manager.offline')}</p>
        ) : null}
        <div className="mg-body" ref={boardBody}>
          {error ? (
            <p className="err" role="alert">
              {reasonOf(error, t)}
            </p>
          ) : view?.available === false ? (
            <p>{t('manager.unavailable')}</p>
          ) : !board || !pages ? (
            <p>{t('manager.loading')}</p>
          ) : (
            <RelationsContext.Provider value={{ board, manager }}>
              <BoardReferencesContext.Provider
                value={{
                  ids: new Set<BoardReference>([
                    ...(board.posts ?? []).map((post) => post.id),
                    ...(board.requests ?? []).map((request) => request.id),
                    ...board.items.map((item) => item.id),
                    ...board.decisions.map((decision) => decision.id),
                  ]),
                  titles: new Map([
                    ...board.items.map(
                      (i) => [i.id, `${i.title} · ${t(`manager.status.${i.status}`)}`] as const,
                    ),
                    ...board.decisions.map(
                      (d) =>
                        [
                          d.id,
                          `${d.title} · ${t(d.status === 'open' ? 'manager.open' : d.status === 'answered' ? 'manager.answered' : 'manager.closed')}`,
                        ] as const,
                    ),
                    ...(board.requests ?? []).map(
                      (r) => [r.id, `${r.title} · ${t(`manager.request.${r.status}`)}`] as const,
                    ),
                    ...(board.posts ?? [])
                      .filter((p) => p.kind === 'report' || p.kind === 'suggestion')
                      .map(
                        (p) =>
                          [
                            p.id,
                            `${p.title}${p.kind === 'report' ? ` · ${t(p.unread ? 'manager.reportUnread' : 'manager.reportRead')}` : ''}`,
                          ] as const,
                      ),
                  ]),
                  open: openReference,
                }}
              >
                {/* 答复区保持挂载，切页签不丢提交状态；本地草稿独立持久化。 */}
                {activeTab === 'suggestions' ? (
                  <ManagerSuggestions
                    posts={board.posts ?? []}
                    manager={manager}
                    onOpen={onSuggestionSource}
                  />
                ) : null}
                {activeTab === 'requests' ? (
                  <Requests
                    posts={board.posts ?? []}
                    manager={manager}
                    requests={board.requests ?? []}
                    disabled={disabled || responding}
                    target={requestTarget}
                    onLocated={requestLocated}
                  />
                ) : null}
                {tab === 'overview' || tab === 'items' || tab === 'lines' ? (
                  <BoardPanels
                    pages={pages}
                    deviceId={manager.deviceId}
                    tab={tab}
                    onTab={setTab}
                    target={itemTarget}
                    onLocated={itemLocated}
                  />
                ) : null}
                {activeTab === 'reports' ? (
                  <Reports
                    manager={manager}
                    posts={(board.posts ?? []).filter((p) => p.kind === 'report')}
                    disabled={disabled}
                  />
                ) : null}
                <Decisions
                  posts={board.posts ?? []}
                  manager={manager}
                  onBusy={setResponding}
                  decisions={board.decisions}
                  requests={board.requests ?? []}
                  groups={pages.decisions}
                  disabled={disabled}
                  visible={activeTab === 'decisions'}
                  target={decisionTarget}
                  onLocated={decisionLocated}
                />
              </BoardReferencesContext.Provider>
            </RelationsContext.Provider>
          )}
        </div>
      </section>
    </section>
  )
}

export function ManagerOrigin({
  manager,
  threadId,
  onOpen,
}: {
  manager: ManagerView
  threadId: string
  onOpen(selection: Selection): void
}) {
  const t = useT()
  const { view } = useManagerBoard(manager)
  const related = (view?.board?.relations ?? []).flatMap((edge) =>
    edge.from.kind === 'thread' && edge.from.target === threadId && edge.to.kind === 'issue'
      ? [edge.to]
      : edge.to.kind === 'thread' && edge.to.target === threadId && edge.from.kind === 'issue'
        ? [edge.from]
        : [],
  )
  return (
    <div className="mg-origin">
      <span className="grow">
        {t('manager.from')} · {manager.name}
        {related.length ? (
          <span>
            {' '}
            · {t('manager.relatedIssues')}{' '}
            {related.map((target) => (
              <button
                type="button"
                className="btn ghost"
                key={target.target}
                onClick={() => {
                  onOpen({ deviceId: manager.deviceId, sessionId: manager.threadId })
                  window.setTimeout(
                    () =>
                      window.dispatchEvent(
                        new CustomEvent('litch-manager-issue', {
                          detail: { managerId: manager.id, id: target.target },
                        }),
                      ),
                    0,
                  )
                }}
              >
                {target.target}
              </button>
            ))}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className="btn ghost"
        onClick={() => onOpen({ deviceId: manager.deviceId, sessionId: manager.threadId })}
      >
        {t('manager.back')}
      </button>
    </div>
  )
}
