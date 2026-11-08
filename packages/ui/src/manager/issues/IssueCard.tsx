// 控制台里的一条 issue：收起和展开是同一张卡。卡头一行是编号加标题，下面一行小字是类型、状态、创建者、跟进、更新时间。
// 展开后普通 issue 直接是讨论界面（IssueThread）；特殊 issue 先是原来的快速处理区，下面一个醒目的“讨论”按钮打开底部抽屉，
// 只展开讨论，不改类型（60 号设计 5.3）。两种都能进完整讨论页。
import { type ReactNode, useEffect } from 'react'
import type { ManagerView } from '../../../../core/src/model-manager.mts'
import type { ManagerIssue, ManagerIssueHead } from '../../../../protocol/src/manager-issues.mts'
import { useT } from '../../app/appearance.ts'
import { Icon } from '../../app/icons.tsx'
import type { IssueCommands } from './data.ts'
import { IssueMeta } from './IssueMeta.tsx'
import { FullDiscussionButton, IssueThread } from './IssueThread.tsx'

export function IssueCard({
  manager,
  head,
  issue,
  open,
  linked,
  talking,
  disabled,
  reason,
  commands,
  quick,
  postRevision,
  onToggle,
  onTalk,
  onFull,
  onOpenItem,
}: {
  manager: ManagerView
  head: ManagerIssueHead
  issue: ManagerIssue | undefined
  open: boolean
  linked: boolean
  /** 这条的讨论正开在底部抽屉里 */
  talking: boolean
  disabled: boolean
  reason: string
  commands: IssueCommands
  /** 特殊 issue 的快速处理区 */
  quick: ReactNode
  postRevision: number | undefined
  onToggle(): void
  onTalk(): void
  onFull(): void
  onOpenItem(id: string): void
}) {
  const t = useT()
  const special = head.kind !== 'ordinary'
  // 展开即读：有新回复的标已读（报告的未读由“已阅”管，不在这里清）
  useEffect(() => {
    if (!open || !issue?.unread || issue.kind === 'report' || disabled) return
    void commands.seen({ id: issue.id, revision: issue.revision }).catch(() => {})
  }, [open, issue, commands, disabled])
  const comments = issue?.discussion.comments.length ?? 0
  return (
    <article
      className="mg-card mg-issue"
      data-issue={head.id}
      data-issue-type={head.kind}
      data-unread={head.unread || undefined}
      data-linked={linked || undefined}
      data-talking={talking || undefined}
      data-motion-key={head.id}
      tabIndex={-1}
    >
      <button
        className="mg-paging-head"
        type="button"
        aria-expanded={open}
        data-act="issue-toggle"
        onClick={onToggle}
      >
        <span className="mg-paging-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="mg-paging-title">
          <b className="mono mg-issue-id">{head.id}</b> {head.title}
        </span>
        {head.unread ? (
          <span
            className="mg-issue-dot"
            role="img"
            aria-label={t(head.kind === 'report' ? 'issue.status.unread' : 'issue.unread')}
            title={t(head.kind === 'report' ? 'issue.status.unread' : 'issue.unread')}
          />
        ) : null}
      </button>
      <IssueMeta head={head} comments={comments} />
      {!open ? (
        head.preview ? (
          <p className="mg-paging-preview">{head.preview}</p>
        ) : null
      ) : !issue ? (
        <p className="dim">{t('manager.loading')}</p>
      ) : special ? (
        <div className="mg-issue-detail" data-issue-detail={head.id}>
          {quick}
          <div className="mg-issue-acts">
            {/* 转讨论的入口：强调色描边按钮，醒目但不压过快速处理的实心主按钮 */}
            <button
              type="button"
              className="btn mg-issue-discuss"
              data-act="issue-discuss"
              aria-pressed={talking}
              onClick={onTalk}
            >
              <Icon name="note" small /> {t('issue.discuss.open')}
              {comments ? <span className="mg-issue-count">{comments}</span> : null}
            </button>
            <FullDiscussionButton onClick={onFull} />
          </div>
        </div>
      ) : (
        <div className="mg-issue-detail" data-issue-detail={head.id}>
          <IssueThread
            mode="inline"
            manager={manager}
            issue={issue}
            disabled={disabled}
            reason={reason}
            commands={commands}
            onOpenItem={onOpenItem}
            onFull={onFull}
            postRevision={postRevision}
          />
        </div>
      )}
    </article>
  )
}
