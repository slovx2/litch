// 控制台：统一的 issue 列表（60 号设计 5.6、6.1）。默认只看普通 issue；顶上一行是“新建 issue”和类型、状态、创建者、跟进、排序过滤。
// 特殊 issue 展开后先是原来的快速处理区；决策草稿的提交条只有一份，固定在列表底部。
import { managerBoardPages } from '@litch/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ManagerBoardTopicView, ManagerView } from '../../../../core/src/model-manager.mts'
import { pagedDraftBoard } from '../../../../core/src/projection/manager-drafts.mts'
import {
  DEFAULT_MANAGER_ISSUE_FILTER,
  MANAGER_ISSUE_KINDS,
  MANAGER_ISSUE_LIST_ORDERS,
  type ManagerIssueFilter,
  managerIssueFilterKey,
  managerIssueHead,
  managerIssuePageKey,
  managerIssueStatusOptions,
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
import { type IssueCommands, type ManagerIssuesState, useIssueCommands } from './data.ts'
import { IssueCard } from './IssueCard.tsx'
import { IssueQuick } from './IssueQuick.tsx'
import { IssueThread } from './IssueThread.tsx'

/** 底部抽屉用 issue: 前缀的编号，免得旧帖子讨论（同样的 D-n）也往抽屉里放内容 */
export const ISSUE_PANE_PREFIX = 'issue:'

/** 每个经理记住自己的过滤条件与展开的那条，离开控制台再回来还在 */
const memory = new Map<
  string,
  {
    filter: ManagerIssueFilter
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
    value = { filter: DEFAULT_MANAGER_ISSUE_FILTER, open: null, full: null, preset: 0 }
    memory.set(key, value)
  }
  return value
}

/** 概览摘要点进来时带的过滤条件；version 变了才套用一次 */
export interface IssuePreset {
  patch: Partial<ManagerIssueFilter>
  version: number
}

export function IssueConsole({
  manager,
  view,
  issues,
  disabled,
  reason,
  target,
  preset,
  onLocated,
  onOpenItem,
  onSuggestionSource,
}: {
  manager: ManagerView
  view: ManagerBoardTopicView & { board: NonNullable<ManagerBoardTopicView['board']> }
  issues: ManagerIssuesState
  disabled: boolean
  reason: string
  /** 编号跳转来的 issue（#n 或旧别名） */
  target: string | null
  preset: IssuePreset | null
  onLocated(): void
  onOpenItem(id: string): void
  onSuggestionSource(selection: Selection, archived: boolean): void
}) {
  const t = useT()
  const commands = useIssueCommands(manager)
  const board = view.board
  const saved = remembered(manager.deviceId, manager.id)
  const [filter, setFilterState] = useState(saved.filter)
  const [open, setOpenState] = useState<ManagerIssueId | null>(saved.open)
  const [linked, setLinked] = useState<ManagerIssueId | null>(null)
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
  const setFilter = useCallback(
    (next: ManagerIssueFilter) => {
      saved.filter = next
      setFilterState(next)
      setLinked(null)
    },
    [saved],
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
    setFilter({ ...DEFAULT_MANAGER_ISSUE_FILTER, ...preset.patch })
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
        invoke(commands.read(id))
      } else onLocated()
      return
    }
    reading.current = null
    onLocated()
    saved.full = null
    setFullState(null)
    if (filter.kinds.length && !filter.kinds.includes(issue.kind))
      setFilter(withManagerIssueKinds(filter, [issue.kind]))
    setLinked(issue.id)
    setOpen(issue.id)
  }, [target, issues, filter, onLocated, invoke, commands, setFilter, setOpen, saved])
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
  const linkedHead =
    linked && !entries.some((head) => head.id === linked) && issues.details[linked]
      ? managerIssueHead(issues.details[linked])
      : null
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
          setLinked(null)
          if (expanded) setOpen(null)
          else {
            setOpen(head.id)
            invoke(commands.read(head.id))
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
        mode={mode}
        manager={manager}
        issue={issue}
        disabled={disabled}
        reason={reason}
        commands={commands}
        onOpenItem={onOpenItem}
        postRevision={postRevision(id)}
        quick={
          mode === 'page' && issue.kind !== 'ordinary' ? (
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
  const filtered =
    managerIssueFilterKey(filter) !== managerIssueFilterKey(DEFAULT_MANAGER_ISSUE_FILTER)
  return (
    <div ref={root} className="mg-stack" data-issue-console>
      <div className="mg-issue-bar">
        <button
          type="button"
          className="btn mg-issue-new"
          data-act="issue-new"
          aria-expanded={creating}
          aria-label={t('issue.new')}
          disabled={disabled}
          title={disabled ? reason : t('issue.new')}
          onClick={() => setCreating(!creating)}
        >
          <Icon name="plus" small />
        </button>
        <IssueFilters filter={filter} onChange={setFilter} />
        <span
          className="mg-issue-total"
          data-issue-total
          title={page ? t('issue.loaded', { n: entries.length, total: page.total }) : undefined}
        >
          {page ? `${entries.length}/${page.total}` : ''}
        </span>
      </div>
      {filter.unread || filtered ? (
        <div className="mg-issue-chips">
          {filter.unread ? (
            <button
              type="button"
              className="mg-issue-chip"
              data-act="issue-unread-clear"
              onClick={() => setFilter({ ...filter, unread: false })}
            >
              {t('issue.filter.unread')} <span aria-hidden="true">×</span>
            </button>
          ) : null}
          {filtered ? (
            <button
              type="button"
              className="mg-issue-chip"
              data-act="issue-filter-reset"
              onClick={() => setFilter(DEFAULT_MANAGER_ISSUE_FILTER)}
            >
              {t('issue.filter.reset')}
            </button>
          ) : null}
        </div>
      ) : null}
      {creating ? (
        <IssueNew
          commands={commands}
          onDone={(id) => {
            setCreating(false)
            if (!id) return
            if (filter.kinds.length && !filter.kinds.includes('ordinary'))
              setFilter(withManagerIssueKinds(filter, ['ordinary']))
            setLinked(id as ManagerIssueId)
            setOpen(id as ManagerIssueId)
          }}
        />
      ) : null}
      {error || issues.error ? (
        <p role="alert" className="err">
          {error || issues.error}{' '}
          <button type="button" className="btn ghost" onClick={() => invoke(commands.list(filter))}>
            {t('manager.paging.retry')}
          </button>
        </p>
      ) : null}
      {linkedHead ? card(linkedHead) : null}
      {!page ? (
        error || issues.error ? null : (
          <p className="dim">{t('manager.loading')}</p>
        )
      ) : entries.length ? (
        <>
          {entries.map(card)}
          {page.nextCursor ? (
            <button
              type="button"
              className="btn ghost"
              data-issue-more
              onClick={() => invoke(commands.list(filter, { cursor: page.nextCursor ?? '' }))}
            >
              {t('issue.loadMore')}
            </button>
          ) : null}
        </>
      ) : (
        <p className="mg-issue-empty" data-issue-empty>
          {t(filtered ? 'issue.empty' : 'issue.emptyAll')}
        </p>
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

/** 一行原生下拉：窄了自动折行；状态选项随类型变 */
function IssueFilters({
  filter,
  onChange,
}: {
  filter: ManagerIssueFilter
  onChange(filter: ManagerIssueFilter): void
}) {
  const t = useT()
  const kind =
    filter.kinds.length === 1 ? (filter.kinds[0] ?? 'all') : filter.kinds.length ? 'mixed' : 'all'
  const statuses = managerIssueStatusOptions(filter.kinds)
  const select = (
    name: string,
    label: string,
    value: string,
    options: { value: string; label: string }[],
    change: (value: string) => void,
  ) => (
    <label className="mg-issue-filter" data-issue-filter={name} title={label}>
      <select value={value} aria-label={label} onChange={(event) => change(event.target.value)}>
        {options.map((one) => (
          <option key={one.value} value={one.value}>
            {one.label}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <fieldset className="mg-issue-filters" aria-label={t('issue.filter.title')}>
      {select(
        'kind',
        t('issue.filter.kind'),
        kind,
        [
          ...MANAGER_ISSUE_KINDS.map((one) => ({ value: one, label: t(`issue.kind.${one}`) })),
          { value: 'all', label: t('issue.kind.all') },
          ...(kind === 'mixed' ? [{ value: 'mixed', label: '…' }] : []),
        ],
        (value) =>
          onChange(
            withManagerIssueKinds(filter, value === 'all' ? [] : [value as ManagerIssueKind]),
          ),
      )}
      {select(
        'status',
        t('issue.filter.status'),
        filter.statuses.length === 1 ? (filter.statuses[0] ?? 'all') : 'all',
        [
          { value: 'all', label: t('issue.filter.allStatus') },
          ...statuses.map((one) => ({
            value: one,
            label: t(`issue.status.${one}` as Parameters<typeof t>[0]),
          })),
        ],
        (value) =>
          onChange({ ...filter, statuses: value === 'all' ? [] : [value as ManagerIssueStatus] }),
      )}
      {select(
        'author',
        t('issue.filter.author'),
        filter.authors.length === 1 ? (filter.authors[0] ?? 'all') : 'all',
        [
          { value: 'all', label: t('issue.filter.allAuthor') },
          { value: 'user', label: t('issue.filter.byUser') },
          { value: 'manager', label: t('issue.filter.byManager') },
        ],
        (value) =>
          onChange({
            ...filter,
            authors: value === 'all' ? [] : [value as ManagerIssueAuthorKind],
          }),
      )}
      {select(
        'follow',
        t('issue.filter.follow'),
        filter.followUp,
        [
          { value: 'all', label: t('issue.filter.allFollow') },
          { value: 'on', label: t('issue.follow.on') },
          { value: 'off', label: t('issue.follow.off') },
        ],
        (value) => onChange({ ...filter, followUp: value as ManagerIssueFilter['followUp'] }),
      )}
      {select(
        'order',
        t('issue.filter.order'),
        filter.order,
        MANAGER_ISSUE_LIST_ORDERS.map((one) => ({ value: one, label: t(`issue.order.${one}`) })),
        (value) => onChange({ ...filter, order: value as ManagerIssueFilter['order'] }),
      )}
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
  return (
    <form
      className="mg-card mg-issue-form"
      data-issue-form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <input
        ref={titleRef}
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
