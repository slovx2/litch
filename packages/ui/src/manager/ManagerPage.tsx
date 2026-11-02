import {
  type DeviceView,
  filterSuggestions,
  keys,
  managerAttentionCount,
  type SuggestionView,
  suggestionCount,
} from '@litch/core'
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { DiscussionPane } from './DiscussionPane.tsx'
import { ManagerFeaturesContext, useManagerBoard } from './data.ts'
import { DiscussionPaneContext } from './discussion-pane.ts'
import { IssueOrderSelect } from './issue-order.tsx'
import { ManagerForm } from './ManagerForm.tsx'
import { RelationsContext } from './Relations.tsx'
import { Reports } from './Reports.tsx'
import { Requests } from './Requests.tsx'
import { ResetManager } from './ResetManager.tsx'
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
  const features = view?.features ?? { feedback: true, posts: true, ignore: true }
  /** 设备服务比应用旧、没宣告的后加能力（按功能列出，写进看板顶上的说明） */
  const missing = (['feedback', 'posts', 'ignore'] as const).filter((key) => !features[key])
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
  // 控制台帖子的讨论在看板底部分屏里看：一次只开一个，换帖子就换内容
  const [talk, setTalk] = useState<string | null>(null)
  const [talkHost, setTalkHost] = useState<HTMLElement | null>(null)
  const openTalk = useCallback((id: string) => setTalk(id), [])
  const closeTalk = useCallback(
    (id?: string) => setTalk((now) => (id === undefined || now === id ? null : now)),
    [],
  )
  const talkContext = useMemo(
    () => ({ host: talk ? talkHost : null, openId: talk, open: openTalk, close: closeTalk }),
    [talk, talkHost, openTalk, closeTalk],
  )
  // 换页签、换经理时关掉分屏
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在页签或经理变化时关
  useEffect(() => setTalk(null), [activeTab, manager.id])
  // 打开或换帖子后把焦点交给分屏里的输入框（不能输入时给标题）
  useEffect(() => {
    if (!talk || !talkHost) return
    const pane = talkHost.closest<HTMLElement>('.mg-talk-pane')
    const input = talkHost.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
    ;(input ?? pane?.querySelector<HTMLElement>('[data-act="discussion-back"]'))?.focus({
      preventScroll: true,
    })
  }, [talk, talkHost])
  const cardOf = (id: string) =>
    page.current?.querySelector<HTMLElement>(`[data-post-card="${CSS.escape(id)}"]`)
  const dismissTalk = useCallback(() => {
    const id = talk
    setTalk(null)
    if (!id) return
    // 关掉后焦点回到那张卡片的讨论入口
    requestAnimationFrame(() =>
      page.current
        ?.querySelector<HTMLElement>(
          `[data-post-card="${CSS.escape(id)}"] [data-act="post-discussion"]`,
        )
        ?.focus({ preventScroll: true }),
    )
  }, [talk])
  // Esc 关分屏：经理页内生效；有模态窗口、输入法组字时不管
  useEffect(() => {
    if (!talk) return
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      if (document.querySelector('dialog[open]')) return
      const target = event.target as Element | null
      const inPage = target?.closest('.mg-page')
      if (!inPage && target !== document.body) return
      event.preventDefault()
      dismissTalk()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [talk, dismissTalk])
  const [responding, setResponding] = useState(false)
  const [ending, setEnding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const board = view?.board
  const attention = managerAttentionCount(manager)
  const attentionTitle = t('manager.pendingDetail', {
    decisions: manager.pendingDecisions,
    requests: manager.pendingRequests ?? 0,
    suggestions: manager.pendingSuggestions ?? 0,
  })
  const counts = {
    overview: 0,
    inbox: managerAttentionCount(manager),
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
            <ResetManager manager={manager} disabled={disabled} />
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
          <div className="mg-inbox-bar">
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
          </div>
        ) : null}
        {disabled ? (
          <p className="mg-readonly">{readOnly ? readOnlyText : t('manager.offline')}</p>
        ) : missing.length ? (
          <p className="mg-readonly" data-old-device role="note">
            {t('manager.oldDevice', {
              items: missing
                .map((key) => t(`manager.feature.${key}`))
                .join(t('manager.feature.join')),
            })}
          </p>
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
            <DiscussionPaneContext.Provider value={talkContext}>
              <ManagerFeaturesContext.Provider value={features}>
                <RelationsContext.Provider value={{ board, manager }}>
                  <BoardReferencesContext.Provider
                    value={{
                      ids: new Set<BoardReference>([
                        ...(board.posts ?? []).map((post) => post.id),
                        ...(board.requests ?? []).map((request) => request.id),
                        ...board.items.map((item) => item.id),
                        ...board.decisions.map((decision) => decision.id),
                      ]),
                      previews: new Map([
                        ...board.items.map(
                          (i) =>
                            [
                              i.id,
                              { title: i.title, status: t(`manager.status.${i.status}`) },
                            ] as const,
                        ),
                        ...board.decisions.map(
                          (d) =>
                            [
                              d.id,
                              {
                                title: d.title,
                                status: t(
                                  d.status === 'open'
                                    ? 'manager.open'
                                    : d.status === 'answered'
                                      ? 'manager.answered'
                                      : 'manager.closed',
                                ),
                              },
                            ] as const,
                        ),
                        ...(board.requests ?? []).map(
                          (r) =>
                            [
                              r.id,
                              { title: r.title, status: t(`manager.request.${r.status}`) },
                            ] as const,
                        ),
                        ...(board.posts ?? [])
                          .filter((p) => p.kind === 'report' || p.kind === 'suggestion')
                          .map(
                            (p) =>
                              [
                                p.id,
                                {
                                  title: p.title,
                                  status:
                                    p.kind === 'report'
                                      ? t(p.unread ? 'manager.reportUnread' : 'manager.reportRead')
                                      : '',
                                },
                              ] as const,
                          ),
                      ]),
                      open: openReference,
                    }}
                  >
                    {/* 排序在列表头右端：决策放在状态切换那一行（Decisions），其他三类一行细的列表头 */}
                    {activeTab === 'suggestions' ||
                    activeTab === 'requests' ||
                    activeTab === 'reports' ? (
                      <div className="mg-list-head">
                        <IssueOrderSelect />
                      </div>
                    ) : null}
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
                      changes={board.changes}
                      requests={board.requests ?? []}
                      groups={pages.decisions}
                      disabled={disabled}
                      visible={activeTab === 'decisions'}
                      target={decisionTarget}
                      onLocated={decisionLocated}
                    />
                  </BoardReferencesContext.Provider>
                </RelationsContext.Provider>
              </ManagerFeaturesContext.Provider>
            </DiscussionPaneContext.Provider>
          )}
        </div>
        {talk ? (
          <DiscussionPane
            id={talk}
            title={
              board?.posts?.find((post) => post.id === talk)?.title ??
              board?.decisions.find((decision) => decision.id === talk)?.title ??
              board?.requests?.find((request) => request.id === talk)?.title ??
              ''
            }
            onHost={setTalkHost}
            onBack={() => {
              const card = cardOf(talk)
              card?.scrollIntoView({ block: 'nearest' })
              card?.focus({ preventScroll: true })
            }}
            onClose={dismissTalk}
          />
        ) : null}
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
                {/^[DIRP]-\d+$/.test(target.target) ? `#${target.target} · ` : ''}
                {view?.board?.posts?.find((post) => post.id === target.target)?.title ??
                  t('manager.issue')}
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
