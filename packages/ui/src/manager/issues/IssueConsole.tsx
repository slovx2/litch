// 控制台按分类标签列 issue，默认决策；普通 issue 另有新建、创建者、未读和跟进过滤。
// 特殊 issue 展开后先是原来的快速处理区；决策草稿的提交条只有一份，固定在列表底部。
import { managerBoardPages } from '@litch/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ManagerBoardTopicView, ManagerView } from '../../../../core/src/model-manager.mts'
import { pagedDraftBoard } from '../../../../core/src/projection/manager-drafts.mts'
import {
  MANAGER_ISSUE_KINDS,
  MANAGER_ISSUE_LIST_ORDERS,
  type ManagerIssueFilter,
  managerIssueFilterKey,
  managerIssueHead,
  managerIssueKindFilter,
  managerIssueLinkFilter,
  managerIssuePageKey,
  managerIssueStatusFilters,
  supportedManagerIssueFilter,
  withManagerIssueKinds,
} from '../../../../core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssueAuthorKind,
  ManagerIssueId,
  ManagerIssueKind,
  ManagerIssueStatus,
} from '../../../../protocol/src/manager-issues.mts'
import type { Selection } from '../../app/App.tsx'
import { useT } from '../../app/appearance.ts'
import { reasonOf } from '../../app/errors.ts'
import { Icon } from '../../app/icons.tsx'
import { Decisions } from '../Decisions.tsx'
import { useDiscussionPane } from '../discussion-pane.ts'
import { useBoardFormKeys } from '../form-submit-keys.ts'
import { type IssueCommands, type ManagerIssuesState, useIssueCommands } from './data.ts'
import { IssueCard } from './IssueCard.tsx'
import { IssueQuick } from './IssueQuick.tsx'
import { IssueThread } from './IssueThread.tsx'

/** 底部抽屉用 issue: 前缀的编号，免得旧帖子讨论（同样的 D-n）也往抽屉里放内容 */
export const ISSUE_PANE_PREFIX = 'issue:'

export const issueKindFilter = managerIssueKindFilter

/** 每个经理记住每一类的过滤条件与展开的那条，离开控制台再回来还在 */
const memory = new Map<
  string,
  {
    filters: Partial<Record<ManagerIssueKind, ManagerIssueFilter>>
    open: ManagerIssueId | null
    full: ManagerIssueId | null
    /** 已经套用过的概览预设版本 */
    preset: number
  }
>()
const remembered = (deviceId: string, managerId: string) => {
  const key = JSON.stringify([deviceId, managerId])
  let value = memory.get(key)
  if (!value) {
    value = { filters: {}, open: null, full: null, preset: 0 }
    memory.set(key, value)
  }
  return value
}

/** 概览摘要点进来时带的普通 issue 过滤条件；version 变了才套用一次 */
export interface IssuePreset {
  patch: Partial<ManagerIssueFilter>
  version: number
}

export function IssueConsole({
  manager,
  kind,
  view,
  issues,
  disabled,
  reason,
  target,
  preset,
  onLocated,
  onKind,
  onOpenItem,
  onSuggestionSource,
}: {
  manager: ManagerView
  /** 当前页签的类型（类别分段在看板上） */
  kind: ManagerIssueKind
  view: ManagerBoardTopicView & { board: NonNullable<ManagerBoardTopicView['board']> }
  issues: ManagerIssuesState
  disabled: boolean
  reason: string
  /** 编号跳转来的 issue（#n 或旧别名） */
  target: string | null
  preset: IssuePreset | null
  onLocated(): void
  /** 跳到别的类型（编号跳转、新建后） */
  onKind(kind: ManagerIssueKind): void
  onOpenItem(id: string): void
  onSuggestionSource(selection: Selection, archived: boolean): void
}) {
  const t = useT()
  const commands = useIssueCommands(manager, issues.discussions === true)
  const board = view.board
  const saved = remembered(manager.deviceId, manager.id)
  const [filters, setFiltersState] = useState(saved.filters)
  // 初次打开分类也保持条件引用，避免分页回包重渲染后重发首屏查询、覆盖已追加的页。
  const filter = useMemo(
    () =>
      supportedManagerIssueFilter(
        filters[kind] ?? issueKindFilter(kind),
        issues.discussions === true,
      ),
    [filters, kind, issues.discussions],
  )
  const [open, setOpenState] = useState<ManagerIssueId | null>(saved.open)
  const [linked, setLinked] = useState<ManagerIssueId | null>(null)
  const [following, setFollowing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [full, setFullState] = useState<ManagerIssueId | null>(saved.full)
  const pane = useDiscussionPane()
  const talkId = pane?.openId?.startsWith(ISSUE_PANE_PREFIX)
    ? (pane.openId.slice(ISSUE_PANE_PREFIX.length) as ManagerIssueId)
    : null
  const setFull = (id: ManagerIssueId | null) => {
    saved.full = id
    setFullState(id)
    if (id) pane?.close()
  }
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  // 换页签：底部抽屉里别的类型的讨论、完整讨论页一起收起
  const shownKind = useRef(kind)
  useEffect(() => {
    if (shownKind.current === kind) return
    shownKind.current = kind
    saved.full = null
    setFullState(null)
    pane?.close()
  }, [kind, pane, saved])
  const setFilter = useCallback(
    (next: ManagerIssueFilter, one = kind) => {
      saved.filters = { ...saved.filters, [one]: next }
      setFiltersState(saved.filters)
      setLinked(null)
    },
    [saved, kind],
  )
  const setOpen = useCallback(
    (id: ManagerIssueId | null) => {
      saved.open = id
      setOpenState(id)
    },
    [saved],
  )
  const page = issues.pages[managerIssuePageKey(manager.id, filter)]
  const invoke = useCallback(
    (request: Promise<unknown>) => {
      void request.then(
        () => setError(''),
        (cause) => setError(reasonOf(cause, t)),
      )
    },
    [t],
  )
  useEffect(() => invoke(commands.list(filter)), [invoke, commands, filter])
  // 概览摘要带来的条件：在默认条件上套用，免得叠上之前选的
  // 控制台切走时不挂载：记在经理的记忆里，回来时只套用还没套用过的那次
  useEffect(() => {
    if (!preset || preset.version === saved.preset) return
    saved.preset = preset.version
    saved.full = null
    setFullState(null)
    setFilter(
      { ...issueKindFilter('ordinary'), statuses: [], ...preset.patch, kinds: ['ordinary'] },
      'ordinary',
    )
  }, [preset, saved, setFilter])
  const reading = useRef<string | null>(null)
  // 编号跳转：类型不在当前过滤里就切到那一类，展开并滚到它
  useEffect(() => {
    if (!target) return
    const id = target as ManagerIssueId
    const issue = issues.details[id]
    if (!issue) {
      // 还没读到：读一次详情，到了再定位；解析不了的编号直接放掉
      if (id && reading.current !== id) {
        reading.current = id
        invoke(
          commands.read(id).catch((error) => {
            if (reading.current === id) {
              reading.current = null
              onLocated()
            }
            throw error
          }),
        )
      }
      return
    }
    reading.current = null
    onLocated()
    saved.full = null
    setFullState(null)
    setFilter(managerIssueLinkFilter(issue, saved.filters[issue.kind]), issue.kind)
    if (issue.kind !== kind) onKind(issue.kind)
    setLinked(issue.id)
    setFollowing(true)
    setOpen(issue.id)
  }, [target, issues, kind, onKind, onLocated, invoke, commands, setOpen, setFilter, saved])
  const linkedIssue = linked ? issues.details[linked] : undefined
  // 定位之后状态还可能改变（例如报告标为已阅）；继续按真实状态显示，直到用户主动改过滤。
  useEffect(() => {
    if (!following || !linkedIssue || linkedIssue.kind !== kind) return
    const next = managerIssueLinkFilter(linkedIssue, filter)
    if (managerIssueFilterKey(next) === managerIssueFilterKey(filter)) return
    saved.filters = { ...saved.filters, [kind]: next }
    setFiltersState(saved.filters)
  }, [following, linkedIssue, kind, filter, saved])
  useLayoutEffect(() => {
    if (!linked) return
    const card = root.current?.querySelector<HTMLElement>(`[data-issue="${CSS.escape(linked)}"]`)
    card?.scrollIntoView({ block: 'nearest' })
    card?.focus({ preventScroll: true })
  }, [linked])
  const draftBoard = useMemo(
    () =>
      view.paging
        ? pagedDraftBoard(
            board,
            Object.values(view.paging.pages).flatMap((one) => one.entries),
          )
        : board,
    [board, view.paging],
  )
  // 特殊 issue 的旧对象操作（问经理）用对象自己的版本，不是 issue 的公共版本
  const postRevision = (id: ManagerIssueId) => issues.details[id]?.quick.revision
  const entries = page?.entries ?? []
  const linkedHead = linkedIssue && linkedIssue.kind === kind ? managerIssueHead(linkedIssue) : null
  const visible = linkedHead
    ? [linkedHead, ...entries.filter((head) => head.id !== linked)]
    : entries
  const card = (head: (typeof entries)[number]) => {
    const issue = issues.details[head.id]
    const expanded = open === head.id
    return (
      <IssueCard
        key={head.id}
        manager={manager}
        head={head}
        issue={issue}
        open={expanded}
        linked={linked === head.id}
        disabled={disabled}
        reason={reason}
        commands={commands}
        talking={talkId === head.id}
        postRevision={postRevision(head.id)}
        onTalk={() =>
          talkId === head.id ? pane?.close() : pane?.open(`${ISSUE_PANE_PREFIX}${head.id}`)
        }
        onFull={() => setFull(head.id)}
        onOpenItem={onOpenItem}
        onToggle={() => {
          if (head.id !== linked) setLinked(null)
          if (expanded) setOpen(null)
          else {
            setOpen(head.id)
            invoke(commands.read(head.id, { manual: true }))
          }
        }}
        quick={
          expanded && head.kind !== 'ordinary' && issue ? (
            <IssueQuick
              manager={manager}
              board={board}
              legacyId={issue.id}
              paged={Boolean(view.paging)}
              disabled={disabled}
              draftBoard={draftBoard}
              onSuggestionSource={onSuggestionSource}
            />
          ) : null
        }
      />
    )
  }
  const thread = (id: ManagerIssueId, mode: 'pane' | 'page') => {
    const issue = issues.details[id]
    if (!issue) return null
    return (
      <IssueThread
        key={`${id}:${mode}`}
        mode={mode}
        changes={board.changes}
        manager={manager}
        issue={issue}
        disabled={disabled}
        reason={reason}
        commands={commands}
        onOpenItem={onOpenItem}
        postRevision={postRevision(id)}
        quick={
          issue.kind !== 'ordinary' ? (
            <IssueQuick
              manager={manager}
              board={board}
              legacyId={issue.id}
              paged={Boolean(view.paging)}
              disabled={disabled}
              draftBoard={draftBoard}
              standalone
              onSuggestionSource={onSuggestionSource}
            />
          ) : null
        }
        onFull={mode === 'pane' ? () => setFull(id) : undefined}
        onBack={() => {
          setFull(null)
          setOpen(id)
          setLinked(id)
        }}
      />
    )
  }
  // 抽屉里的讨论：内容由这里用 portal 放进看板底部的分屏
  const paneContent =
    talkId && pane?.host && issues.details[talkId]
      ? createPortal(thread(talkId, 'pane'), pane.host)
      : null
  if (full && issues.details[full])
    return (
      <div ref={root} className="mg-stack" data-issue-console data-issue-full={full}>
        {thread(full, 'page')}
      </div>
    )
  const filtered = managerIssueFilterKey(filter) !== managerIssueFilterKey(issueKindFilter(kind))
  const ordinary = kind === 'ordinary'
  return (
    <div ref={root} className="mg-stack" data-issue-console data-issue-kind={kind}>
      <IssueFilters
        discussions={issues.discussions === true}
        kind={kind}
        filter={filter}
        onChange={setFilter}
      />
      {ordinary ? (
        <div className="mg-issue-subbar">
          <button
            type="button"
            className="btn mg-issue-new"
            data-act="issue-new"
            aria-expanded={creating}
            disabled={disabled}
            title={disabled ? reason : undefined}
            onClick={() => setCreating(!creating)}
          >
            <Icon name="plus" small /> {t('issue.new')}
          </button>
          <IssueToggles filter={filter} onChange={setFilter} />
        </div>
      ) : null}
      {creating && ordinary ? (
        <IssueNew
          commands={commands}
          onDone={(id) => {
            setCreating(false)
            if (!id) return
            setFollowing(false)
            setLinked(id as ManagerIssueId)
            setOpen(id as ManagerIssueId)
          }}
        />
      ) : null}
      {error || issues.error ? (
        <p role="alert" className="err">
          {error || issues.error}{' '}
          <button
            type="button"
            className="btn ghost"
            onClick={() => invoke(commands.list(filter, { manual: true }))}
          >
            {t('manager.paging.retry')}
          </button>
        </p>
      ) : null}
      {!page && !linkedHead ? (
        error || issues.error ? null : (
          <p className="dim">{t('manager.loading')}</p>
        )
      ) : visible.length ? (
        <>
          {visible.map(card)}
          <footer className="mg-issue-foot">
            <span data-issue-total>
              {t('issue.loaded', { n: visible.length, total: page?.total ?? visible.length })}
            </span>
            {page?.nextCursor ? (
              <button
                type="button"
                className="btn ghost"
                data-issue-more
                onClick={() =>
                  invoke(commands.list(filter, { cursor: page.nextCursor ?? '', manual: true }))
                }
              >
                {t('issue.loadMore')}
              </button>
            ) : null}
          </footer>
        </>
      ) : (
        <div className="mg-issue-empty" data-issue-empty>
          <p>{t(filtered ? 'issue.empty' : ordinary ? 'issue.emptyAll' : 'issue.emptyKind')}</p>
          {filtered ? (
            <button
              type="button"
              className="btn ghost"
              data-act="issue-filter-reset"
              onClick={() => setFilter(issueKindFilter(kind))}
            >
              {t('issue.filter.reset')}
            </button>
          ) : null}
        </div>
      )}
      <Decisions
        manager={manager}
        posts={board.posts ?? []}
        decisions={board.decisions}
        changes={board.changes}
        requests={board.requests ?? []}
        groups={managerBoardPages(board).decisions}
        onlyId={null}
        visible={false}
        disabled={disabled}
        target={null}
        onLocated={() => {}}
        onBusy={() => {}}
        part="send"
        draftBoard={draftBoard}
      />
      {paneContent}
    </div>
  )
}

/** 状态一行文字切换（和原来决策的状态行一样），排序在右端 */
function IssueFilters({
  discussions,
  kind,
  filter,
  onChange,
}: {
  discussions: boolean
  kind: ManagerIssueKind
  filter: ManagerIssueFilter
  onChange(filter: ManagerIssueFilter): void
}) {
  const t = useT()
  const active = (list: readonly ManagerIssueStatus[]) =>
    list.length === filter.statuses.length && list.every((one) => filter.statuses.includes(one))
  const options = managerIssueStatusFilters(kind, filter.kinds)
  return (
    <div className="mg-decision-filter mg-issue-filters" data-issue-filters>
      {kind === 'ordinary' ? (
        <fieldset className="mg-issue-statuses" aria-label={t('issue.filter.kind')}>
          <legend>{t('issue.filter.kind')}</legend>
          {discussions ? (
            <button
              type="button"
              data-issue-filter-kind="all"
              aria-pressed={
                !filter.kinds.length || filter.kinds.length === MANAGER_ISSUE_KINDS.length
              }
              onClick={() => onChange(withManagerIssueKinds(filter, []))}
            >
              {t('issue.kind.all')}
            </button>
          ) : null}
          {(discussions ? MANAGER_ISSUE_KINDS : (['ordinary'] as const)).map((one) => (
            <button
              type="button"
              key={one}
              data-issue-filter-kind={one}
              aria-pressed={!filter.kinds.length || filter.kinds.includes(one)}
              onClick={() => {
                const selected = filter.kinds.length ? filter.kinds : [...MANAGER_ISSUE_KINDS]
                const next = selected.includes(one)
                  ? selected.filter((k) => k !== one)
                  : [...selected, one]
                if (next.length) onChange(withManagerIssueKinds(filter, next))
              }}
            >
              {t(`issue.kind.${one}`)}
            </button>
          ))}
        </fieldset>
      ) : null}
      <fieldset className="mg-issue-statuses" aria-label={t('issue.filter.status')}>
        {options.map((one) => (
          <button
            type="button"
            key={one.key}
            data-issue-filter-status={one.key}
            aria-pressed={active(one.statuses)}
            onClick={() => onChange({ ...filter, statuses: one.statuses })}
          >
            {t(one.label as Parameters<typeof t>[0])}
          </button>
        ))}
      </fieldset>
      <label className="mg-issue-order">
        <span className="mg-issue-order-label">{t('manager.order')}</span>
        <select
          data-issue-filter="order"
          value={filter.order}
          onChange={(event) =>
            onChange({ ...filter, order: event.target.value as ManagerIssueFilter['order'] })
          }
        >
          {MANAGER_ISSUE_LIST_ORDERS.map((one) => (
            <option key={one} value={one}>
              {t(`issue.order.${one}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** 普通 issue 的几个开关：谁建的、只看未读、跟进已暂停；再点一次取消 */
function IssueToggles({
  filter,
  onChange,
}: {
  filter: ManagerIssueFilter
  onChange(filter: ManagerIssueFilter): void
}) {
  const t = useT()
  const author = (who: ManagerIssueAuthorKind) => ({
    pressed: filter.authors.length === 1 && filter.authors[0] === who,
    toggle: () =>
      onChange({
        ...filter,
        authors: filter.authors.length === 1 && filter.authors[0] === who ? [] : [who],
      }),
  })
  const chips: {
    key: string
    label: string
    pressed: boolean
    toggle(): void
  }[] = [
    { key: 'user', label: t('issue.filter.byUser'), ...author('user') },
    { key: 'manager', label: t('issue.filter.byManager'), ...author('manager') },
    {
      key: 'unread',
      label: t('issue.filter.unread'),
      pressed: filter.unread,
      toggle: () => onChange({ ...filter, unread: !filter.unread }),
    },
    {
      key: 'paused',
      label: t('issue.follow.off'),
      pressed: filter.followUp === 'off',
      toggle: () => onChange({ ...filter, followUp: filter.followUp === 'off' ? 'all' : 'off' }),
    },
  ]
  return (
    <fieldset className="mg-issue-chips" aria-label={t('issue.filter.title')}>
      {chips.map((chip) => (
        <button
          type="button"
          key={chip.key}
          className="mg-issue-chip"
          data-issue-chip={chip.key}
          aria-pressed={chip.pressed}
          onClick={chip.toggle}
        >
          {chip.label}
        </button>
      ))}
    </fieldset>
  )
}

/** 新建普通 issue：标题必填，正文可空。草稿在内存里，收起表单不丢。 */
const newDraft = { title: '', body: '' }
function IssueNew({
  commands,
  onDone,
}: {
  commands: IssueCommands
  onDone(id: string | null): void
}) {
  const t = useT()
  const [title, setTitle] = useState(newDraft.title)
  const [body, setBody] = useState(newDraft.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => titleRef.current?.focus(), [])
  const submit = async () => {
    if (busy) return
    if (!title.trim()) {
      setError(t('issue.new.titleRequired'))
      titleRef.current?.focus()
      return
    }
    setBusy(true)
    setError('')
    try {
      const { issue } = await commands.create({ title: title.trim(), body })
      newDraft.title = ''
      newDraft.body = ''
      onDone(issue.id)
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const formKeys = useBoardFormKeys(submit)
  return (
    <form className="mg-card mg-issue-form" data-issue-form {...formKeys}>
      <header className="mg-issue-form-head">
        <b className="mg-issue-form-title">{t('issue.new')}</b>
        <span className="dim">{t('issue.new.note')}</span>
      </header>
      <input
        ref={titleRef}
        className="req-input"
        value={title}
        maxLength={200}
        placeholder={t('issue.new.title')}
        aria-label={t('issue.new.title')}
        aria-invalid={Boolean(error && !title.trim()) || undefined}
        data-issue-title
        onChange={(event) => {
          newDraft.title = event.target.value
          setTitle(event.target.value)
        }}
      />
      <textarea
        className="req-input grow-input"
        rows={4}
        value={body}
        placeholder={t('issue.new.body')}
        aria-label={t('issue.new.body')}
        data-issue-body
        onChange={(event) => {
          newDraft.body = event.target.value
          setBody(event.target.value)
        }}
      />
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mg-issue-form-acts">
        <button type="button" className="btn ghost" onClick={() => onDone(null)}>
          {t('issue.new.cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={busy} data-act="issue-create">
          {t('issue.new.create')}
        </button>
      </div>
    </form>
  )
}
