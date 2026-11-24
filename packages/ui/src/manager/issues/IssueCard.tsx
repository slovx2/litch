// 控制台里的一条 issue：卡头一行是编号加标题，下面一行小字是类型、状态、创建者、跟进、更新时间。
// 普通 issue 正文长、带评论，点卡头进全屏阅读页（IssueConsole 的 page），不在列表里展开；
// 特殊 issue 原地展开快速处理区，下面一个醒目的“讨论”按钮打开底部抽屉，只展开讨论，不改类型（60 号设计 5.3）。
import type { ReactNode } from 'react'
import type { ManagerView } from '../../../../core/src/model-manager.mts'
import type { ManagerIssue, ManagerIssueHead } from '../../../../protocol/src/manager-issues.mts'
import { useT } from '../../app/appearance.ts'
import { Icon } from '../../app/icons.tsx'
import { CardActionScope, CardActions } from '../CardActions.tsx'
import type { IssueCommands } from './data.ts'
import { IssueMeta, IssueNext, IssueWaitReason } from './IssueMeta.tsx'
import { useIssueSeen } from './issue-seen.ts'

export function IssueCard({
  manager,
  head,
  issue,
  open,
  linked,
  talking,
  disabled,
  commands,
  quick,
  onToggle,
  onTalk,
}: {
  manager: ManagerView
  head: ManagerIssueHead
  issue: ManagerIssue | undefined
  open: boolean
  linked: boolean
  /** 这条的讨论正开在底部抽屉里 */
  talking: boolean
  disabled: boolean
  commands: IssueCommands
  /** 特殊 issue 的快速处理区 */
  quick: ReactNode
  /** 特殊 issue 展开或收起；普通 issue 打开全屏阅读页 */
  onToggle(): void
  onTalk(): void
}) {
  const t = useT()
  const special = head.kind !== 'ordinary'
  // 普通 issue 在全屏页里标已读
  useIssueSeen({ manager, issue, open: open && special, disabled, commands })
  const comments = issue?.discussion.comments.length ?? 0
  return (
    <CardActionScope>
      {(footer) => (
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
            aria-expanded={special ? open : undefined}
            data-act="issue-toggle"
            onClick={onToggle}
          >
            <span className="mg-paging-caret" aria-hidden="true">
              {special ? (open ? '▾' : '▸') : '›'}
            </span>
            <span className="mg-paging-title">
              <b className="mono mg-issue-id">{head.id}</b> {head.title}
            </span>
            {/* 卡头右端的标记区：下一步在谁、未读点 */}
            <span className="mg-issue-marks">
              <IssueNext waiting={head.waiting} />
              {head.unread ? (
                <span
                  className="mg-issue-dot"
                  role="img"
                  aria-label={t(head.kind === 'report' ? 'issue.status.unread' : 'issue.unread')}
                  title={t(head.kind === 'report' ? 'issue.status.unread' : 'issue.unread')}
                />
              ) : null}
            </span>
          </button>
          <IssueMeta head={head} comments={comments} />
          <IssueWaitReason head={head} full={open && special} />
          {!open || !special ? (
            head.preview ? (
              <p className="mg-paging-preview">{head.preview}</p>
            ) : null
          ) : !issue ? (
            <p className="dim">{t('manager.loading')}</p>
          ) : (
            <div className="mg-issue-detail" data-issue-detail={head.id}>
              {quick}
              <CardActions>
                {/* 唯一的讨论入口：图标加条数，排在操作栏末端；完整讨论从抽屉标题行进入 */}
                <button
                  type="button"
                  className="mg-talk-entry mg-issue-discuss"
                  data-act="issue-discuss"
                  aria-pressed={talking}
                  aria-label={[
                    t('issue.discuss.open'),
                    comments ? t('manager.discussionCount', { n: comments }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  title={t('issue.discuss.open')}
                  onClick={onTalk}
                >
                  <Icon name="note" small />
                  {comments ? <span className="mg-talk-count">{comments}</span> : null}
                </button>
              </CardActions>
            </div>
          )}
          {footer}
        </article>
      )}
    </CardActionScope>
  )
}
