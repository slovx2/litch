import {
  type DeviceView,
  keys,
  liveManagerDrafts,
  managerAttentionCount,
  pagedDraftBoard,
  type SessionChildren,
  type SessionSummary,
} from '@litch/core'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type {
  ManagerBoardTopicView,
  ManagerObjectId,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import type { Selection } from '../app/App.tsx'
import { requestManagerDrafts, requestManagers } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf, wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { Caret, Forward } from '../app/icons.tsx'
import { markReadScope, unreadInScope } from '../app/read.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { RowMenu, type RowMenuHandle } from '../sidebar/RowMenu.tsx'
import { containsSession, revealRow } from '../sidebar/reveal.ts'
import { useSidebarReveal } from '../sidebar/reveal-context.ts'
import { managerPendingTitle, managerStateText, sessionMark } from '../sidebar/session-mark.ts'
import { toggleSidebarFold, useSidebarFolds } from '../sidebar/state.ts'
import { useAnswerDrafts } from './drafts.ts'
import { usePostDrafts } from './post-drafts.ts'
import { useRequestDrafts } from './request-drafts.ts'

function ManagerRow({
  manager,
  device,
  selection,
  onSelect,
  children,
  reveal,
}: {
  manager: ManagerView
  device: DeviceView | undefined
  selection: Selection | null
  onSelect(selection: Selection): void
  children: ReactNode
  reveal: Selection | null
}) {
  const t = useT()
  const { replica, channel } = useServices()
  const kids = useKey<SessionChildren>(keys.children(manager.deviceId))
  const unread = useKey<string[]>(keys.catalogUnread(manager.deviceId)) ?? []
  const readMenu = useRef<RowMenuHandle>(null)
  const hasUnread = unreadInScope(unread, kids ?? {}, manager.threadId).length > 0
  const lines = kids?.[manager.threadId]?.length ?? 0
  // 和普通对话的父子树一样默认收起，下面一行“› N 个子会话”。展开了哪些照“最近 / 未读”的投影记在侧栏状态里
  // （folded 里的是展开的），切栏、重开都不丢；选中的是它的工作线时先展开，免得选中行藏着
  const scope = `:manager:${manager.deviceId}`
  const open = useSidebarFolds(scope).folded.includes(manager.threadId)
  // 只在选中工作线、定位到这里的那一刻展开；之后用户自己收起不再被撑开（展开与否从 ref 读最新的）
  const opened = useRef(open)
  opened.current = open
  const unfold = useCallback(() => {
    if (!opened.current) toggleSidebarFold(scope, 'folded', manager.threadId)
  }, [scope, manager.threadId])
  const holdsSelection =
    selection?.deviceId === manager.deviceId &&
    selection.sessionId !== manager.threadId &&
    containsSession(kids ?? {}, manager.threadId, selection.sessionId)
  useEffect(() => {
    if (holdsSelection) unfold()
  }, [holdsSelection, unfold])
  const row = useRef<HTMLDivElement>(null)
  const { fromTree, selected } = useSidebarReveal()
  useEffect(() => {
    if (!reveal) return
    unfold()
    if (reveal.sessionId !== manager.threadId) return
    const scroll = row.current?.closest<HTMLElement>('.sb-scroll')
    if (row.current && scroll) revealRow(row.current, scroll)
  }, [reveal, manager.threadId, unfold])
  const { drafts } = useAnswerDrafts(manager.deviceId, manager.id)
  const { drafts: requests } = useRequestDrafts(manager.deviceId, manager.id)
  const { drafts: posts } = usePostDrafts(manager.deviceId, manager.id)
  const local = {
    decisions: Object.values(drafts),
    requests: Object.values(requests),
    posts: Object.values(posts),
  }
  // 键订阅只读副本缓存，不会打开看板。即使从没进入经理页，也要为草稿持有实时看板订阅。
  const hasDrafts = liveManagerDrafts(null, local).count > 0
  useEffect(() => {
    if (hasDrafts) return replica.openManagerBoard(manager.deviceId, manager.id)
  }, [hasDrafts, replica, manager.deviceId, manager.id])
  const [view] = useKeys<ManagerBoardTopicView>(
    hasDrafts ? [keys.managerBoard(manager.deviceId, manager.id)] : [],
  )
  const draftBoard = view?.board
    ? view.paging
      ? pagedDraftBoard(
          view.board,
          Object.values(view.paging.pages).flatMap((page) => page.entries),
        )
      : view.board
    : null
  // 页外草稿按对象补读；未知时不计数，但绝不删除本地内容。已读详情由核心随看板通知对账。
  const fetched = useRef(new Set<string>())
  useEffect(() => {
    if (!view?.paging || !draftBoard || device?.connection !== 'online') return
    const known = new Set(
      [...draftBoard.decisions, ...(draftBoard.requests ?? []), ...(draftBoard.posts ?? [])].map(
        (one) => one.id,
      ),
    )
    for (const id of [...Object.keys(drafts), ...Object.keys(requests), ...Object.keys(posts)]) {
      if (known.has(id) || fetched.current.has(id)) continue
      fetched.current.add(id)
      void channel
        .command('managers.board.detail', {
          deviceId: manager.deviceId,
          managerId: manager.id,
          id: id as ManagerObjectId,
        })
        .catch(() => {})
    }
  }, [
    view?.paging,
    draftBoard,
    device?.connection,
    drafts,
    requests,
    posts,
    channel,
    manager.deviceId,
    manager.id,
  ])
  const count = draftBoard ? liveManagerDrafts(draftBoard, local).count : 0
  const attention = managerAttentionCount(manager)
  // 记号只说经理会话自己（回合、后台任务），和普通会话行同一套；工作线在跑另用文字写明，
  // 不借用经理自己的“运行中”（工作线各自的记号在下面的子行上）。
  const summary = useKey<SessionSummary>(keys.summary(manager.deviceId, manager.threadId))
  const mark = sessionMark(summary)
  const background = summary?.background?.running ?? 0
  const { key: stateKey, ...stateArgs } = managerStateText(summary, manager.runningLines)
  const state = t(stateKey, stateArgs)
  const picked =
    selected?.source === 'tree' &&
    selected.deviceId === selection?.deviceId &&
    selected.sessionId === selection?.sessionId &&
    selection?.deviceId === manager.deviceId &&
    selection.sessionId === manager.threadId
  const fold = () => toggleSidebarFold(scope, 'folded', manager.threadId)
  // 行的结构、类名和普通会话行（Sidebar.tsx 的 SessionRow 与 tree）一致：记号、标题、harness 标签、行尾一栏，
  // 行首左边距里的小箭头，收起时下面一行“› N 个子会话”。经理行尾那栏放待处理、状态与草稿数，占普通行时间的位置
  return (
    <div
      className="mg-sidebar-manager"
      style={wireStyle(device?.wire)}
      data-manager-id={manager.id}
    >
      <div className="tree-node" data-depth={0}>
        <div ref={row} className="row-line" data-session={manager.threadId}>
          <button
            type="button"
            className={picked ? 'ss-row mg-pick sel' : 'ss-row mg-pick'}
            aria-current={picked ? 'page' : undefined}
            onContextMenu={(event) => {
              if (!hasUnread) return
              event.preventDefault()
              readMenu.current?.openAt(event.clientX, event.clientY)
            }}
            onClick={() => {
              const next = { deviceId: manager.deviceId, sessionId: manager.threadId }
              fromTree(next, 'tree')
              onSelect(next)
            }}
          >
            <i
              className={device?.connection === 'online' ? 'dev-tick' : 'dev-tick off'}
              aria-hidden="true"
            />
            <i
              className={mark && mark !== 'unread' ? `st mgr ${mark}` : 'st mgr'}
              {...(mark === 'bg'
                ? {
                    title: t('background.sidebar', { count: background }),
                    'data-background': background,
                  }
                : {})}
            />
            <span className="title ell grow">{manager.name || t('manager.manager')}</span>
            {/* 在哪台设备看行首色块的颜色，名字在标签的提示里：行尾留给待处理与状态 */}
            <span
              className="chip"
              title={[
                nameOf(device, manager.harness, t),
                device ? t.text(device.name) : manager.deviceId,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {badgeOf(device, manager.harness)}
            </span>
            <small className="mg-sidebar-counts">
              {manager.status === 'ending' ? (
                <span className="dim">{t('manager.ending')}</span>
              ) : null}
              {attention || count ? (
                <span
                  className={attention ? 'mg-attention' : 'dim'}
                  title={managerPendingTitle(
                    t('manager.pending', { n: attention }),
                    state,
                    t('manager.pendingDetail', {
                      decisions: manager.pendingDecisions,
                      requests: manager.pendingRequests ?? 0,
                      suggestions: manager.pendingSuggestions ?? 0,
                    }),
                  )}
                >
                  {t('manager.pending', { n: attention })}
                </span>
              ) : manager.status !== 'ending' ? (
                <span className="dim ell" data-manager-state>
                  {state}
                </span>
              ) : null}
            </small>
          </button>
          {hasUnread ? (
            <RowMenu
              handle={readMenu}
              label={t('session.menu')}
              actions={[{ id: 'markRead', title: t('session.markRead') }]}
              onAction={() => {
                void markReadScope(
                  channel,
                  replica.store,
                  manager.deviceId,
                  manager.threadId,
                ).catch((error) =>
                  showToast({
                    id: 'mark-read',
                    lifeMs: 6000,
                    tone: 'err',
                    text: () => reasonOf(error, t),
                  }),
                )
              }}
            />
          ) : null}
          {count ? (
            <button
              type="button"
              className="mg-sidebar-drafts mg-attention"
              data-manager-draft-count
              title={t('manager.locateDraft')}
              onClick={() =>
                requestManagerDrafts({
                  deviceId: manager.deviceId,
                  sessionId: manager.threadId,
                  managerId: manager.id,
                })
              }
            >
              {t('manager.draftCount', { n: count })}
            </button>
          ) : null}
          {lines > 0 ? (
            <button
              type="button"
              className="tree-fold"
              aria-expanded={open}
              title={open ? t('tree.fold') : t('tree.unfold', { n: lines })}
              aria-label={open ? t('tree.fold') : t('tree.unfold', { n: lines })}
              onClick={fold}
            >
              <Caret />
            </button>
          ) : null}
        </div>
        {lines > 0 ? (
          <div className="tree-kids">
            {open ? (
              children
            ) : (
              <button
                type="button"
                className="tree-sum"
                aria-expanded="false"
                title={t('tree.unfold', { n: lines })}
                onClick={fold}
              >
                <Caret />
                <span className="ell">{t('tree.tucked', { n: lines })}</span>
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ManagerSidebar({
  managers,
  devices,
  selection,
  onSelect,
  tree,
}: {
  managers: ManagerView[]
  devices: DeviceView[]
  selection: Selection | null
  onSelect(selection: Selection): void
  tree(manager: ManagerView): ReactNode
}) {
  const t = useT()
  // 两组都能收起，和对话一侧的“未读 / 最近”同一种组标题；已结束默认收起
  const [open, setOpen] = useState({ active: true, ended: false })
  const { request } = useSidebarReveal()
  const children = useKey<SessionChildren>(keys.children(request?.deviceId ?? ''))
  const target = request
    ? managers.find(
        (manager) =>
          manager.deviceId === request.deviceId &&
          containsSession(children ?? {}, manager.threadId, request.sessionId),
      )
    : undefined
  const targetEnded = target?.status === 'ended'
  const found = Boolean(target)
  // 定位到某位经理（或它的工作线）时，展开它所在的那一组
  useEffect(() => {
    if (request && found)
      setOpen((now) =>
        now[targetEnded ? 'ended' : 'active']
          ? now
          : { ...now, [targetEnded ? 'ended' : 'active']: true },
      )
  }, [request, found, targetEnded])
  return (
    <>
      {(['active', 'ended'] as const).map((status) => (
        <section key={status} className="mg-sidebar-group">
          <header className="row-line projection-head">
            <button
              type="button"
              className="dev-row head-toggle"
              aria-expanded={open[status]}
              onClick={() => setOpen((now) => ({ ...now, [status]: !now[status] }))}
            >
              <span className={open[status] ? 'arr wire-sq' : 'arr wire-sq shut'}>
                <Caret />
              </span>
              <span className="name ell">{t(`manager.${status}`)}</span>
            </button>
            <button
              type="button"
              className="ibtn"
              aria-label={t('manager.all')}
              title={t('manager.all')}
              onClick={() => requestManagers({ view: 'list' })}
            >
              <Forward />
            </button>
          </header>
          {open[status]
            ? managers
                .filter((manager) =>
                  status === 'active' ? manager.status !== 'ended' : manager.status === 'ended',
                )
                .map((manager) => (
                  <ManagerRow
                    key={`${manager.deviceId}:${manager.id}`}
                    manager={manager}
                    device={devices.find((device) => device.id === manager.deviceId)}
                    selection={selection}
                    onSelect={onSelect}
                    reveal={manager === target ? request : null}
                  >
                    {tree(manager)}
                  </ManagerRow>
                ))
            : null}
        </section>
      ))}
      {!managers.length ? <p className="mg-empty">{t('manager.empty')}</p> : null}
    </>
  )
}
