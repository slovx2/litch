// 一条 issue 的讨论界面，三处共用同一套：卡片里展开（inline）、看板底部抽屉（pane）、完整讨论页（page）。
// 抽屉只显示讨论；标题行可定位上方原帖，不在列表时才临时展开原帖。完整页保留原帖与操作。
import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ManagerChangeView, ManagerView } from '../../../../core/src/model-manager.mts'
import {
  MANAGER_ISSUE_STATUSES,
  managerIssueHead,
} from '../../../../core/src/projection/manager-issue-list.mts'
import type {
  ManagerIssue,
  ManagerOrdinaryStatus,
} from '../../../../protocol/src/manager-issues.mts'
import type { ManagerPostId } from '../../../../protocol/src/manager-posts.mts'
import { useT } from '../../app/appearance.ts'
import { reasonOf } from '../../app/errors.ts'
import { Icon } from '../../app/icons.tsx'
import { useServices } from '../../app/services.tsx'
import { BoardMarkdown } from '../BoardMarkdown.tsx'
import { useDiscussionPane } from '../discussion-pane.ts'
import { RelationLink } from '../RelationLink.tsx'
import type { IssueCommands } from './data.ts'
import { IssueDiscussion } from './IssueDiscussion.tsx'
import { IssueMeta } from './IssueMeta.tsx'

export interface IssueThreadProps {
  manager: ManagerView
  issue: ManagerIssue
  changes?: readonly ManagerChangeView[]
  /** 返回是否能在上方列表定位并展开；不能时由抽屉临时显示正文。 */
  onShowBody?: (() => boolean) | undefined
  /** 列表恢复显示该议题后，收起抽屉中的临时正文。 */
  bodyInList?: boolean | undefined
  disabled: boolean
  reason: string
  commands: IssueCommands
  onOpenItem(id: string): void
  /** 抽屉里和卡片里有；完整讨论页没有 */
  onFull?: (() => void) | undefined
  /** 完整讨论页的返回 */
  onBack?: (() => void) | undefined
  /** 特殊 issue 的正文和主操作：完整页显示，抽屉仅在无法定位原帖时按需显示。 */
  quick?: ReactNode
  /** 特殊 issue 的“问经理”：帖子版本用于追问，回答进入时间线。 */
  postRevision?: number | undefined
}

export function IssueControls({
  issue,
  disabled,
  reason,
  commands,
}: Pick<IssueThreadProps, 'issue' | 'disabled' | 'reason' | 'commands'>) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (request: Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await request
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  if (issue.kind !== 'ordinary') return null
  const following = issue.followUp.state === 'on'
  return (
    <>
      <div className="mg-issue-controls">
        <fieldset
          className="seg mg-issue-status"
          aria-label={t('issue.filter.status')}
          data-issue-status-select
          disabled={disabled || busy}
          title={disabled ? reason : undefined}
        >
          {MANAGER_ISSUE_STATUSES.ordinary.map((status) => (
            <button
              type="button"
              key={status}
              aria-pressed={issue.status === status}
              data-issue-status={status}
              onClick={() => {
                if (issue.status === status) return
                void run(
                  commands.update({
                    id: issue.id,
                    revision: issue.revision,
                    patch: { status: status as ManagerOrdinaryStatus },
                    why: t('issue.why.status', {
                      status: t(`issue.status.${status}` as Parameters<typeof t>[0]),
                    }),
                  }),
                )
              }}
            >
              <span className="mg-issue-state" data-state={status} aria-hidden="true" />
              {t(`issue.status.${status}` as Parameters<typeof t>[0])}
            </button>
          ))}
        </fieldset>
        <span className="mg-issue-follow" title={disabled ? reason : t('issue.follow.hint')}>
          <span className="mg-issue-follow-label">{t('issue.follow.label')}</span>
          <button
            type="button"
            role="switch"
            className="switch"
            data-act="issue-follow"
            aria-checked={following}
            aria-label={t('issue.follow.label')}
            disabled={disabled || busy}
            onClick={() => {
              const state = following ? 'off' : 'on'
              void run(
                commands.follow({
                  id: issue.id,
                  revision: issue.revision,
                  state,
                  why: t(state === 'on' ? 'issue.why.followUp.on' : 'issue.why.followUp.off'),
                }),
              )
            }}
          >
            <i />
          </button>
        </span>
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}

export function IssueRelationsRow({
  manager,
  issue,
  onOpenItem,
}: Pick<IssueThreadProps, 'manager' | 'issue' | 'onOpenItem'>) {
  const t = useT()
  const targets = issue.relations.flatMap((edge) =>
    edge.from.kind === 'issue' && edge.from.target === issue.id
      ? [edge.to]
      : edge.to.kind === 'issue' && edge.to.target === issue.id
        ? [edge.from]
        : [],
  )
  if (!targets.length) return null
  return (
    <details className="mg-issue-relations-fold" data-issue-relations>
      <summary>
        {t('manager.relations')} {targets.length}
      </summary>
      <div className="mg-issue-relations">
        {targets.map((target) =>
          target.kind === 'item' ? (
            // 经理事项用自己的记号，和 issue 编号区分开
            <button
              type="button"
              className="mg-issue-item-link"
              key={`${target.kind}:${target.target}`}
              data-issue-item={target.target}
              onClick={() => onOpenItem(target.target)}
            >
              <span className="mono">{target.target}</span> · {t('issue.itemTag')}
              {target.label ? ` · ${target.label}` : ''}
            </button>
          ) : (
            <RelationLink
              key={`${target.kind}:${target.target}`}
              target={target}
              manager={manager}
            />
          ),
        )}
      </div>
    </details>
  )
}

/** “打开完整讨论”：小图标加文字，次要样式 */
export function FullDiscussionButton({ onClick }: { onClick(): void }) {
  const t = useT()
  return (
    <button
      type="button"
      className="btn ghost mg-issue-btn"
      data-act="issue-full"
      onClick={onClick}
    >
      <Icon name="expand" small /> {t('issue.full.open')}
    </button>
  )
}

export function IssueThread({
  mode,
  manager,
  issue,
  disabled,
  reason,
  commands,
  onOpenItem,
  onFull,
  onBack,
  quick,
  postRevision,
  changes,
  onShowBody,
  bodyInList,
}: IssueThreadProps & { mode: 'inline' | 'pane' | 'page' }) {
  const t = useT()
  const [openingError, setOpeningError] = useState('')
  const opened =
    issue.discussion.opened ||
    issue.discussion.comments.length > 0 ||
    issue.discussion.questions.length > 0
  useEffect(() => {
    if (disabled || !commands.canOpenDiscussion || issue.kind === 'ordinary' || opened) return
    void commands
      .update({
        id: issue.id,
        revision: issue.revision,
        patch: { discussionOpened: true },
        why: t('issue.discuss.open'),
      })
      .then(
        () => setOpeningError(''),
        (error) => setOpeningError(error instanceof Error ? error.message : String(error)),
      )
  }, [disabled, issue.id, issue.kind, issue.revision, opened, commands, t])

  const { channel } = useServices()
  const special = issue.kind !== 'ordinary'
  const [bodyOpen, setBodyOpen] = useState(false)
  useEffect(() => {
    if (bodyInList) setBodyOpen(false)
  }, [bodyInList])
  const pane = useDiscussionPane()
  const bodySlot =
    mode === 'pane'
      ? pane?.host?.closest('.mg-talk-pane')?.querySelector('[data-discussion-body]')
      : null
  const body =
    special && quick ? (
      quick
    ) : (
      <div className="mg-issue-post">
        {issue.body ? (
          <BoardMarkdown text={issue.body} />
        ) : (
          <p className="dim">{t('issue.noBody')}</p>
        )}
      </div>
    )
  // 抽屉直接问经理；卡片内的决策追问仍由决策卡随答复提交。
  const ask =
    special && (issue.kind !== 'decision' || mode === 'pane') && postRevision !== undefined
      ? (question: string) =>
          channel.command('managers.post.question', {
            deviceId: manager.deviceId,
            managerId: manager.id,
            id: issue.id as ManagerPostId,
            revision: postRevision,
            question,
            mode: 'manager',
          })
      : undefined
  return (
    <section
      className="mg-issue-thread"
      data-issue-thread={mode}
      data-issue={mode === 'inline' ? undefined : issue.id}
    >
      {bodySlot
        ? createPortal(
            <button
              type="button"
              className="btn ghost"
              data-act="discussion-body"
              aria-expanded={bodyOpen}
              onClick={() => {
                if (onShowBody?.()) setBodyOpen(false)
                else setBodyOpen(!bodyOpen)
              }}
            >
              {t(bodyOpen ? 'issue.body.hide' : 'issue.body.view')}
            </button>,
            bodySlot,
          )
        : null}
      {openingError ? (
        <p role="alert" className="err">
          {openingError}
        </p>
      ) : null}
      {mode === 'page' ? (
        <header className="mg-issue-page-head">
          <button
            type="button"
            className="ibtn"
            data-act="issue-back"
            title={t('manager.back')}
            aria-label={t('manager.back')}
            onClick={onBack}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <h2 className="mg-paging-title">
            <b className="mono mg-issue-id">{issue.id}</b> {issue.title}
          </h2>
        </header>
      ) : null}
      {mode === 'page' ? (
        <IssueMeta
          head={managerIssueHead(issue)}
          comments={issue.discussion.comments.length}
          withKind
        />
      ) : null}
      {mode !== 'pane' || bodyOpen ? (
        <div data-issue-original={issue.id}>
          {body}
          <IssueControls issue={issue} disabled={disabled} reason={reason} commands={commands} />
          <IssueRelationsRow manager={manager} issue={issue} onOpenItem={onOpenItem} />
        </div>
      ) : null}
      {onFull && mode !== 'pane' ? (
        <div className="mg-issue-acts">
          <FullDiscussionButton onClick={onFull} />
        </div>
      ) : null}
      <IssueDiscussion
        issue={issue}
        changes={changes}
        draftKey={JSON.stringify([manager.deviceId, manager.id, issue.id])}
        disabled={disabled}
        reason={reason}
        special={special}
        onComment={(body) => commands.comment({ id: issue.id, revision: issue.revision, body })}
        onAsk={ask}
      />
    </section>
  )
}
