// 一条 issue 的讨论界面，三处共用同一套：卡片里展开（inline）、看板底部抽屉（pane）、完整讨论页（page）。
// 内容依次是原帖、状态与跟进、关联、评论时间线和输入框。抽屉里原帖默认收成两行，另有“打开完整讨论”。
import { type ReactNode, useEffect, useState } from 'react'
import type { ManagerView } from '../../../../core/src/model-manager.mts'
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
import { RelationLink } from '../RelationLink.tsx'
import type { IssueCommands } from './data.ts'
import { IssueDiscussion } from './IssueDiscussion.tsx'
import { IssueMeta } from './IssueMeta.tsx'

export interface IssueThreadProps {
  manager: ManagerView
  issue: ManagerIssue
  disabled: boolean
  reason: string
  commands: IssueCommands
  onOpenItem(id: string): void
  /** 抽屉里和卡片里有；完整讨论页没有 */
  onFull?: (() => void) | undefined
  /** 完整讨论页的返回 */
  onBack?: (() => void) | undefined
  /** 特殊 issue 的原帖位置：快速处理区（卡片里由卡片自己画，抽屉和完整页只放正文） */
  quick?: ReactNode
  /** 特殊 issue（报告、请你做、建议）的“问经理”：旧帖子追问，回答进时间线 */
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
    <div className="mg-issue-relations" data-issue-relations>
      <span className="dim">{t('manager.relations')}</span>
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
          <RelationLink key={`${target.kind}:${target.target}`} target={target} manager={manager} />
        ),
      )}
    </div>
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
  const [postOpen, setPostOpen] = useState(mode !== 'pane')
  // 决策的追问随答复一起交（在决策卡里）；其他特殊 issue 可以直接问经理
  const ask =
    special && issue.kind !== 'decision' && postRevision !== undefined
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
      {mode !== 'inline' ? (
        <IssueMeta
          head={managerIssueHead(issue)}
          comments={issue.discussion.comments.length}
          withKind
        />
      ) : null}
      {special && quick && mode !== 'pane' ? (
        quick
      ) : (
        <div className="mg-issue-post" data-collapsed={!postOpen || undefined}>
          {issue.body ? (
            <BoardMarkdown text={issue.body} />
          ) : (
            <p className="dim">{t('issue.noBody')}</p>
          )}
          {mode === 'pane' && issue.body ? (
            <button
              type="button"
              className="mg-issue-more"
              aria-expanded={postOpen}
              onClick={() => setPostOpen(!postOpen)}
            >
              {t(postOpen ? 'manager.postCollapse' : 'manager.postExpand')}
            </button>
          ) : null}
        </div>
      )}
      <IssueControls issue={issue} disabled={disabled} reason={reason} commands={commands} />
      <IssueRelationsRow manager={manager} issue={issue} onOpenItem={onOpenItem} />
      {onFull ? (
        <div className="mg-issue-acts">
          <FullDiscussionButton onClick={onFull} />
        </div>
      ) : null}
      <IssueDiscussion
        issue={issue}
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
