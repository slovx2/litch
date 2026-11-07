import {
  type DeviceView,
  filterSuggestions,
  groupSuggestions,
  keys,
  reviewedSuggestion,
  type SessionSummary,
  type SuggestionEntry,
  type SuggestionView,
  sortManagerIssues,
  suggestionCount,
  type WorkspaceView,
} from '@litch/core'
import { type ReactNode, useRef } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { ManagerPost } from '../../../protocol/src/manager-posts.mjs'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { ago } from '../app/format.ts'
import { Close, Forward, Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { BoardMarkdown } from '../manager/BoardMarkdown.tsx'
import { useCardMotion } from '../manager/card-motion.ts'
import { useIssueOrder } from '../manager/issue-order.tsx'
import { PostCard } from '../manager/PostCard.tsx'
import { PostDiscussion, PostHistory } from '../manager/PostDiscussion.tsx'
import { Relations } from '../manager/Relations.tsx'
import { FileLinksProvider, useSessionFileLinks } from '../transcript/FileLinks.tsx'
import { Brief, ProposalActs } from './ProposalCard.tsx'
import { proposalSummary } from './proposal-brief.ts'
import { SANDBOX_LEVEL } from './sandbox.ts'

const NONE: readonly SuggestionView[] = []

function SuggestionRow({
  row,
  manager,
  post,
  onOpen,
}: {
  row: SuggestionView
  manager?: ManagerView
  post?: ManagerPost | undefined
  onOpen(selection: Selection, archived: boolean): void
}) {
  const t = useT()
  const now = useNow()
  const { deviceId, proposal, source } = row
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  const workspace = source.project ?? workspaces.find((entry) => entry.roots.includes(source.cwd))
  const online = device?.connection === 'online'
  // 简报里的文件链接按来源会话的路径认，同对话里
  const fileLinks = useSessionFileLinks(
    deviceId,
    useKey<SessionSummary>(keys.summary(deviceId, source.threadId)),
  )
  const heading = (
    <>
      <b className="prop-title grow">{proposal.title}</b>
      {!reviewedSuggestion(row) ? (
        <span className="pill mute suggestion-review-label">{t('suggestions.unreviewed')}</span>
      ) : null}
    </>
  )
  const body = (
    <>
      <div className="prop-meta">
        <button
          type="button"
          className="btn ghost suggestion-source"
          data-act="open-source"
          disabled={!online}
          title={!online ? t('suggestions.offline') : t('suggestions.openSource')}
          onClick={() => onOpen({ deviceId, sessionId: source.threadId }, source.archived)}
        >
          <span className="ell">{source.title}</span>
          <Forward />
        </button>
        {source.archived ? <span className="pill mute">{t('suggestions.archived')}</span> : null}
        <span>{device ? t.text(device.name) : deviceId}</span>
        <span className="mono ell" title={source.cwd}>
          {workspace?.name ?? source.cwd}
        </span>
        <time
          dateTime={new Date(proposal.createdAt).toISOString()}
          title={new Date(proposal.createdAt).toLocaleString()}
        >
          {ago(proposal.createdAt, now, t)}
        </time>
      </div>
      {manager ? <Relations id={`S-${proposal.id}`} /> : null}
      {manager ? (
        <Brief
          prompt={proposal.prompt}
          background={proposal.background}
          renderText={BoardMarkdown}
        />
      ) : (
        <FileLinksProvider value={fileLinks}>
          <Brief prompt={proposal.prompt} background={proposal.background} />
        </FileLinksProvider>
      )}
      <PostHistory post={post} />
      {proposal.widerSandbox ? (
        <p className="prop-wider">
          {t('proposal.wider', { level: t(SANDBOX_LEVEL[proposal.widerSandbox]) })}
        </p>
      ) : null}
      {!online ? <p className="dim">{t('suggestions.offline')}</p> : null}
      {source.archived ? <p className="dim">{t('suggestions.restore')}</p> : null}
      <ProposalActs
        deviceId={deviceId}
        sessionId={source.threadId}
        proposal={proposal}
        inbox
        sourceParent={{
          id: source.threadId,
          harness: source.harness,
          title: source.title,
          cwd: source.cwd,
          workspaceId: workspace?.id ?? null,
        }}
      />
    </>
  )
  return manager ? (
    <li className="suggestion-row" data-motion-key={proposal.id}>
      <PostCard
        manager={manager}
        id={`S-${proposal.id}`}
        text={proposalSummary(proposal.background, proposal.prompt)}
        className="tree-card prop-card"
        data-state={proposal.status}
        data-proposal={proposal.id}
        tabIndex={-1}
        heading={heading}
        discussion={(collapsed) => (
          <PostDiscussion compact={collapsed} manager={manager} post={post} disabled={!online} />
        )}
      >
        <div className="prop-body">{body}</div>
      </PostCard>
    </li>
  ) : (
    <li
      className="tree-card prop-card suggestion-row"
      data-state={proposal.status}
      data-proposal={proposal.id}
      tabIndex={-1}
    >
      <div className="prop-body">
        {heading}
        {body}
      </div>
    </li>
  )
}

/** 看板里的建议列表：开始、忽略后离开的卡收拢，下方的卡补位 */
function SuggestionList({
  entries,
  scope,
  children,
}: {
  entries: readonly SuggestionView[]
  scope: string
  children: ReactNode
}) {
  const root = useRef<HTMLUListElement>(null)
  useCardMotion(root, scope, entries.map((row) => row.proposal.id).join('|'))
  return (
    <ul className="suggestions-list mg-suggestions-list" ref={root}>
      {children}
    </ul>
  )
}

export function ManagerSuggestions({
  manager,
  posts,
  onOpen,
  onlyId,
}: {
  manager: ManagerView
  posts: ManagerPost[]
  onOpen(selection: Selection, archived: boolean): void
  onlyId?: string
}) {
  const all = useKey<readonly SuggestionView[]>(keys.suggestions) ?? NONE
  const order = useIssueOrder()
  // 已审核与未审核各成一组，组内都待开始；排序只决定组内先后。
  const rows = sortManagerIssues(
    filterSuggestions(all, { deviceId: manager.deviceId, managerId: manager.id }).filter(
      (row) => onlyId === undefined || `S-${row.proposal.id}` === onlyId,
    ),
    order,
    (row) => ({ at: row.proposal.createdAt, pending: true }),
  )
  const t = useT()
  const reviewed = rows.filter(reviewedSuggestion)
  const pending = rows.filter((row) => !reviewedSuggestion(row))
  const history = sortManagerIssues(
    posts.filter(
      (post) =>
        post.kind === 'suggestion' && !rows.some((row) => row.proposal.id === post.proposalId),
    ),
    order,
    (post) => ({ at: post.createdAt }),
  )
  const cards = (entries: readonly SuggestionView[]) => (
    <SuggestionList entries={entries} scope={order}>
      {entries.map((row) => (
        <SuggestionRow
          key={row.proposal.id}
          row={row}
          manager={manager}
          post={posts.find((p) => p.proposalId === row.proposal.id)}
          onOpen={onOpen}
        />
      ))}
    </SuggestionList>
  )
  return (
    <div className="mg-stack">
      {reviewed.length ? (
        cards(reviewed)
      ) : onlyId === undefined ? (
        <p className="mg-empty">{t('suggestions.noReviewed')}</p>
      ) : null}
      {pending.length ? (
        <details
          className="mg-suggestion-review"
          data-suggestions-unreviewed
          open={onlyId !== undefined}
        >
          <summary>
            {t('suggestions.unreviewed')} {pending.length}
          </summary>
          {cards(pending)}
        </details>
      ) : null}
      {history.length ? (
        <details className="mg-suggestion-history" open={onlyId !== undefined}>
          <summary>
            {t('manager.suggestionHistory')} · {history.length}
          </summary>
          {history.map((post) => (
            <PostCard
              manager={manager}
              id={post.id}
              text={post.body}
              closed
              className="mg-card"
              key={post.id}
              data-proposal={post.proposalId}
              tabIndex={-1}
              heading={<h3 className="grow">{post.title}</h3>}
              discussion={(collapsed) => (
                <PostDiscussion compact={collapsed} manager={manager} post={post} />
              )}
            >
              <Relations id={post.id} />
              <Brief prompt={post.body} renderText={BoardMarkdown} />
              <PostHistory post={post} />
            </PostCard>
          ))}
        </details>
      ) : null}
    </div>
  )
}

function ManagerSuggestionCard({
  entry,
  onOpen,
}: {
  entry: Extract<SuggestionEntry, { kind: 'manager' }>
  onOpen(manager: ManagerView): void
}) {
  const manager = useKey<ManagerView>(keys.manager(entry.deviceId, entry.managerId))
  const device = useKey<DeviceView>(keys.device(entry.deviceId))
  const reviewed = entry.rows.filter(reviewedSuggestion)
  const pending = entry.rows.length - reviewed.length
  const latest = reviewed[0]
  const now = useNow()
  const t = useT()
  return (
    <li
      className="suggestion-manager"
      data-suggestion-manager={entry.managerId}
      data-device={entry.deviceId}
    >
      <article className="tree-card prop-card" data-state="pending">
        <div className="prop-body">
          <header>
            <span className="pill mute">{t('manager.manager')}</span>
            <b>{manager?.name || t('suggestions.managerLoading')}</b>
            <span className="pill mute">{t('suggestions.count', { n: reviewed.length })}</span>
            {pending ? (
              <span className="pill mute">
                {t('suggestions.unreviewed')} {pending}
              </span>
            ) : null}
          </header>
          <div className="prop-meta">
            <span>{device ? t.text(device.name) : entry.deviceId}</span>
            {latest ? (
              <time title={new Date(latest.proposal.createdAt).toLocaleString()}>
                {ago(latest.proposal.createdAt, now, t)}
              </time>
            ) : null}
          </div>
          {latest ? (
            <>
              <strong>{latest.proposal.title}</strong>
              <Brief prompt={latest.proposal.prompt} background={latest.proposal.background} />
            </>
          ) : null}
          <button
            type="button"
            className="btn ghost suggestion-manager-open"
            disabled={!manager}
            onClick={() => manager && onOpen(manager)}
            title={!manager ? t('suggestions.managerLoading') : t('suggestions.openManager')}
            aria-label={
              manager
                ? t('suggestions.openManagerNamed', { name: manager.name, n: reviewed.length })
                : t('suggestions.managerLoading')
            }
          >
            {t('suggestions.openManager')}
            <Forward />
          </button>
        </div>
      </article>
    </li>
  )
}

export function SuggestionsPage({
  onManager,
  onOpen,
  onClose,
}: {
  onManager(manager: ManagerView): void
  onOpen(selection: Selection, archived: boolean): void
  onClose(): void
}) {
  const t = useT()
  const all = useKey<readonly SuggestionView[]>(keys.suggestions) ?? NONE
  const entries = groupSuggestions(all)
  return (
    <section className="arch-page" data-page="suggestions">
      <header className="arch-head">
        <h1>
          {t('suggestions.title')} {/* 没有时不写 0：空状态那句话已经说了 */}
          {suggestionCount(all) > 0 ? (
            <span className="pill mute">{suggestionCount(all)}</span>
          ) : null}
        </h1>
        <button
          type="button"
          className="ibtn"
          aria-label={t('suggestions.close')}
          onClick={onClose}
        >
          <Close />
        </button>
      </header>
      <div className="arch-body">
        {entries.length ? (
          <ul className="suggestions-list">
            {entries.map((entry) =>
              entry.kind === 'manager' ? (
                <ManagerSuggestionCard
                  key={`manager:${entry.deviceId}:${entry.managerId}`}
                  entry={entry}
                  onOpen={onManager}
                />
              ) : (
                <SuggestionRow
                  key={`${entry.row.deviceId}:${entry.row.proposal.id}`}
                  row={entry.row}
                  onOpen={onOpen}
                />
              ),
            )}
          </ul>
        ) : (
          <div className="page-empty" data-empty="suggestions">
            <Icon name="suggest" />
            <p>{t('suggestions.empty')}</p>
          </div>
        )}
      </div>
    </section>
  )
}
