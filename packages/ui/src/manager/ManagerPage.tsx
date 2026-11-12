import {
  type DeviceView,
  filterSuggestions,
  keys,
  managerAttentionCount,
  type SuggestionView,
  suggestionCount,
} from '@litch/core'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { boardPageMemory, managerBoardMemory } from '../../../core/src/manager-board-memory.mts'
import type {
  ManagerDecisionId,
  ManagerItemId,
  ManagerRequestId,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import { MANAGER_ISSUE_SUMMARY_FILTERS } from '../../../core/src/projection/manager-issue-list.mts'
import type { ManagerIssueKind } from '../../../protocol/src/manager-issues.mts'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { SessionTodo } from '../rail/InfoRail.tsx'
import { onFindPreparing } from '../search/actions.ts'
import { Transcript } from '../transcript/Transcript.tsx'
import { ManagerSuggestions } from '../tree/SuggestionsPage.tsx'
import { BoardGrip } from './BoardGrip.tsx'
import { BoardPanels } from './BoardPanels.tsx'
import { BoardReferencesContext } from './BoardReferences.tsx'
import { BOARD_GRIP, CHAT_MIN, setBoardLayout, useBoardLayout } from './board-layout.ts'
import { useBoardScroll } from './board-memory.ts'
import { Decisions } from './Decisions.tsx'
import { DiscussionPane } from './DiscussionPane.tsx'
import { ManagerFeaturesContext, useManagerBoard } from './data.ts'
import { DiscussionPaneContext } from './discussion-pane.ts'
import { IssueOrderSelect } from './issue-order.tsx'
import { useIssueCounts, useManagerIssues } from './issues/data.ts'
import { IssueConsole, type IssuePreset } from './issues/IssueConsole.tsx'
import { ManagerForm } from './ManagerForm.tsx'
import { ManagerRules } from './ManagerRules.tsx'
import {
  Overview,
  type OverviewCategory,
  type OverviewCounts,
  type OverviewIssueKey,
  type OverviewIssues,
} from './Overview.tsx'
import { PagedBoard } from './PagedBoard.tsx'
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
  draftFocus?: number
}
const defaultLocation: ManagerPageLocation = { tab: 'inbox', narrow: 'board', settings: false }

const CATEGORY_KIND = {
  decisions: 'decision',
  suggestions: 'suggestion',
  requests: 'request',
  reports: 'report',
} as const

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
  const features = view?.features ?? {
    feedback: true,
    posts: true,
    ignore: true,
    requestIgnore: true,
  }
  /** 设备服务比应用旧、没宣告的后加能力（按功能列出，写进看板顶上的说明） */
  const missing = (['feedback', 'posts', 'ignore', 'requestIgnore', 'issues'] as const).filter(
    (key) => !features[key],
  )
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
    if (boardBody.current && !view?.paging) boardBody.current.scrollTop = 0
    onLocation({ ...location, tab })
  }
  const setNarrow = (narrow: ManagerPageLocation['narrow']) => onLocation({ ...location, narrow })
  const setSettings = (settings: boolean) => onLocation({ ...location, settings })
  const [decisionTarget, setDecisionTarget] = useState<{ id: ManagerDecisionId } | null>(null)
  const decisionLocated = useCallback(() => setDecisionTarget(null), [])
  const [itemTarget, setItemTarget] = useState<{ id: ManagerItemId } | null>(null)
  const itemLocated = useCallback(() => setItemTarget(null), [])
  const [requestTarget, setRequestTarget] = useState<{ id: ManagerRequestId } | null>(null)
  const [pagingTarget, setPagingTarget] = useState<Exclude<BoardReference, `X-${number}`> | null>(
    null,
  )
  const requestLocated = useCallback(() => setRequestTarget(null), [])
  const reading = managerBoardMemory(manager.deviceId, manager.id)
  const [, renderCategory] = useState(0)
  // issue 控制台（设备支持 litchManagerIssues 时）：编号跳转与概览摘要的过滤都交给它
  const issues = useManagerIssues(view)
  const issueCounts = useIssueCounts(manager, issues, MANAGER_ISSUE_SUMMARY_FILTERS)
  const issueMode = issues.supported === true
  const [issueTarget, setIssueTarget] = useState<string | null>(null)
  const issueLocated = useCallback(() => setIssueTarget(null), [])
  const [issuePreset, setIssuePreset] = useState<IssuePreset | null>(null)
  /** 类别分段右端的位置：issue 页签的“新建 issue”放进来，和筛选分开 */
  const [issueAction, setIssueAction] = useState<HTMLDivElement | null>(null)
  const presetIssues = (patch: IssuePreset['patch']) => {
    reading.ordinary = true
    renderCategory((value) => value + 1)
    setIssuePreset((now) => ({ patch, version: (now?.version ?? 0) + 1 }))
    setBoardLayout({ open: true })
    onLocation({ ...location, tab: 'inbox', narrow: 'board' })
  }
  const openReference = (ref: BoardReference) => {
    if (issueMode && !ref.startsWith('I-')) {
      setBoardLayout({ open: true })
      setIssueTarget(ref)
      onLocation({ ...location, tab: 'inbox', narrow: 'board' })
      return
    }
    // 没有 issue 控制台的设备不会出现 X-n
    if (ref.startsWith('X-')) return
    const id = ref as Exclude<BoardReference, `X-${number}`>
    if (view?.paging) setPagingTarget(id)
    if (boardBody.current && !view?.paging) boardBody.current.scrollTop = 0
    setBoardLayout({ open: true })
    if (id.startsWith('P-') || id.startsWith('S-')) {
      onLocation({
        ...location,
        tab: id.startsWith('P-') ? 'reports' : 'suggestions',
        narrow: 'board',
      })
      if (view?.paging) return
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
  const inboxTab = (
    {
      decision: 'decisions',
      suggestion: 'suggestions',
      request: 'requests',
      report: 'reports',
    } as const
  )[reading.category]
  const setInboxTab = (tab: 'decisions' | 'suggestions' | 'requests' | 'reports') => {
    reading.ordinary = false
    reading.category = (
      {
        decisions: 'decision',
        suggestions: 'suggestion',
        requests: 'request',
        reports: 'report',
      } as const
    )[tab]
    renderCategory((value) => value + 1)
  }
  const activeTab = tab === 'inbox' ? inboxTab : tab
  // issue 控制台的页签：四类特殊 issue 在前，普通 issue 在末尾
  const issueKind: ManagerIssueKind =
    tab === 'inbox'
      ? reading.ordinary
        ? 'ordinary'
        : reading.category
      : ((
          {
            decisions: 'decision',
            suggestions: 'suggestion',
            requests: 'request',
            reports: 'report',
          } as const
        )[tab as 'decisions'] ?? reading.category)
  // 类别分段放不下时横向滚动：选中的类别滚进可见区
  const inboxTabs = useRef<HTMLDivElement>(null)
  const pickedTab = issueMode ? issueKind : activeTab
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选中项变化时重新对齐
  useEffect(() => {
    inboxTabs.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pickedTab])
  const pickIssueKind = (kind: ManagerIssueKind) => {
    reading.ordinary = kind === 'ordinary'
    if (kind !== 'ordinary') reading.category = kind
    renderCategory((value) => value + 1)
    if (tab !== 'inbox') setTab('inbox')
  }
  // 未分页看板同样在离开/返回时恢复阅读位置；分页看板继续使用自身的筛选记忆。
  useBoardScroll(
    boardBody,
    boardPageMemory(reading, `unpaged:${activeTab}`),
    !!view?.board,
    !view?.paging,
  )
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
    ;(input ?? pane?.querySelector<HTMLElement>('.mg-talk-title'))?.focus({
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
  const focusedDraft = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (!location.draftFocus || location.draftFocus === focusedDraft.current || tab !== 'decisions')
      return
    if (!layout.open) {
      setBoardLayout({ open: true })
      return
    }
    if (!view?.board) return
    const bar = page.current?.querySelector<HTMLElement>('.mg-send:not([data-sent])')
    if (!bar) return
    bar.scrollIntoView({ block: 'end' })
    bar
      .querySelector<HTMLElement>('[data-act="manager-locate-draft"]')
      ?.focus({ preventScroll: true })
    focusedDraft.current = location.draftFocus
  }, [location.draftFocus, tab, view, layout.open])

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
    items:
      view?.paging?.summary.counts.item.pending ??
      (pages?.overview.stats.totalItems ?? 0) - (pages?.overview.stats.doneItems ?? 0),
    lines: manager.runningLines,
    suggestions: suggestionCount(suggestions),
  }
  // 概览上的控制台四类：未完成数与控制台页签的计数同源，总数取分页摘要或整份看板
  const totals = view?.paging?.summary.counts
  const postsOf = (kind: 'report' | 'suggestion') =>
    (board?.posts ?? []).filter((post) => post.kind === kind).length
  const overviewCounts: OverviewCounts = {
    decisions: {
      pending: counts.decisions,
      total: totals?.decision.all ?? board?.decisions.length ?? 0,
    },
    requests: {
      pending: counts.requests,
      total: totals?.request.all ?? board?.requests?.length ?? 0,
    },
    reports: { pending: counts.reports, total: totals?.report.all ?? postsOf('report') },
    suggestions: {
      pending: counts.suggestions,
      total: totals?.suggestion.all ?? postsOf('suggestion'),
    },
  }
  /** 概览跳到控制台某一类：和点控制台里的类别按钮是同一件事 */
  const openInbox = (kind: OverviewCategory) => {
    if (issueMode) {
      pickIssueKind(
        (
          {
            decisions: 'decision',
            requests: 'request',
            reports: 'report',
            suggestions: 'suggestion',
          } as const
        )[kind],
      )
      setBoardLayout({ open: true })
      return
    }
    setInboxTab(kind)
    setTab(kind)
  }
  const overviewIssues: OverviewIssues | undefined =
    issueMode && issueCounts
      ? {
          counts: issueCounts,
          onOpen: (key: OverviewIssueKey) => presetIssues(MANAGER_ISSUE_SUMMARY_FILTERS[key]),
        }
      : undefined
  const consoleTab = ['inbox', 'decisions', 'requests', 'suggestions', 'reports'].includes(tab)
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
        <SessionTodo deviceId={manager.deviceId} sessionId={manager.threadId} />
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
        <div className="side-tabs">
          <div className="side-tablist" role="tablist">
            {(['inbox', 'overview', 'items'] as const).map((key) => (
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
        {consoleTab ? (
          <div className="mg-inbox-bar">
            <div className="mg-inbox-tabs seg" ref={inboxTabs}>
              {(['decisions', 'suggestions', 'requests', 'reports'] as const).map((kind) => (
                <button
                  type="button"
                  data-inbox-tab={kind}
                  data-board-tab={kind}
                  key={kind}
                  aria-pressed={issueMode ? issueKind === CATEGORY_KIND[kind] : activeTab === kind}
                  onClick={() => openInbox(kind)}
                >
                  {t(`manager.${kind}`)}
                  {counts[kind] ? <span className="pill wait">{counts[kind]}</span> : null}
                </button>
              ))}
              {issueMode ? (
                <button
                  type="button"
                  data-inbox-tab="issues"
                  key="issues"
                  aria-pressed={issueKind === 'ordinary'}
                  onClick={() => pickIssueKind('ordinary')}
                >
                  {t('issue.tab')}
                  {issueCounts?.unread ? (
                    <span className="pill wait">{issueCounts.unread}</span>
                  ) : null}
                </button>
              ) : null}
            </div>
            {issueMode ? (
              <div className="mg-inbox-act" ref={setIssueAction} data-inbox-action />
            ) : null}
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
          ) : view?.loadError ? (
            <p role="alert">
              {view.loadError}{' '}
              <button
                type="button"
                onClick={() => {
                  void channel
                    .command('managers.board.refresh', {
                      deviceId: manager.deviceId,
                      managerId: manager.id,
                    })
                    .catch(() => {})
                }}
              >
                {t('manager.paging.retry')}
              </button>
            </p>
          ) : !board || !pages ? (
            <p>{t('manager.loading')}</p>
          ) : (
            <DiscussionPaneContext.Provider value={talkContext}>
              <ManagerFeaturesContext.Provider value={features}>
                <RelationsContext.Provider value={{ board, manager }}>
                  <BoardReferencesContext.Provider
                    value={{
                      deferred: Boolean(view.paging),
                      ids: new Set<BoardReference>([
                        ...(board.posts ?? []).map((post) => post.id),
                        ...(board.requests ?? []).map((request) => request.id),
                        ...board.items.map((item) => item.id),
                        ...board.decisions.map((decision) => decision.id),
                        // 普通 issue（X-n）：已读到的列表行和详情
                        ...Object.values(issues.pages).flatMap((one) =>
                          one.entries.map((head) => head.id as BoardReference),
                        ),
                        ...(Object.keys(issues.details) as BoardReference[]),
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
                    {issueMode && consoleTab ? (
                      <IssueConsole
                        manager={manager}
                        kind={issueKind}
                        onKind={pickIssueKind}
                        view={{ ...view, board }}
                        issues={issues}
                        disabled={disabled}
                        reason={t(readOnly ? 'issue.readOnly' : 'issue.offline')}
                        target={issueTarget}
                        preset={issuePreset}
                        actionSlot={issueAction}
                        onLocated={issueLocated}
                        onOpenItem={openReference}
                        onSuggestionSource={onSuggestionSource}
                      />
                    ) : view.paging ? (
                      <PagedBoard
                        manager={manager}
                        view={{ ...view, board, paging: view.paging }}
                        tab={activeTab}
                        disabled={disabled}
                        target={pagingTarget}
                        onLocated={() => setPagingTarget(null)}
                        onSuggestionSource={onSuggestionSource}
                        overviewCounts={overviewCounts}
                        onInbox={openInbox}
                        overviewIssues={overviewIssues}
                      />
                    ) : (
                      <>
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
                        {tab === 'overview' ? (
                          <Overview
                            situation={pages.overview.situation}
                            counts={overviewCounts}
                            onOpen={openInbox}
                            issues={overviewIssues}
                          />
                        ) : null}
                        {tab === 'items' || tab === 'lines' ? (
                          <BoardPanels
                            pages={pages}
                            deviceId={manager.deviceId}
                            tab={tab}
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
                      </>
                    )}
                    {/* 经理设定放在概览末尾，完整显示；顶栏的“设置”和卡上的“编辑”打开同一份表单 */}
                    {tab === 'overview' ? (
                      <ManagerRules
                        manager={manager}
                        onEdit={
                          manager.status === 'active' && !disabled
                            ? () => setSettings(true)
                            : undefined
                        }
                      />
                    ) : null}
                  </BoardReferencesContext.Provider>
                </RelationsContext.Provider>
              </ManagerFeaturesContext.Provider>
            </DiscussionPaneContext.Provider>
          )}
        </div>
        {talk ? (
          <DiscussionPane
            issue={talk.startsWith('issue:')}
            id={talk.replace(/^issue:/, '')}
            title={
              issues.details[talk.replace(/^issue:/, '') as keyof typeof issues.details]?.title ??
              board?.posts?.find((post) => post.id === talk)?.title ??
              board?.decisions.find((decision) => decision.id === talk)?.title ??
              board?.requests?.find((request) => request.id === talk)?.title ??
              ''
            }
            onHost={setTalkHost}
            onBack={() => {
              const card =
                cardOf(talk) ??
                page.current?.querySelector<HTMLElement>(
                  `[data-issue="${CSS.escape(talk.replace(/^issue:/, ''))}"]`,
                )
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
