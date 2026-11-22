// issue 卡头下面的一行小字：（类型记号）· 状态 · 创建者 · 跟进（只在暂停时写） · 更新时间 · 评论数。状态不另占一行。
// 列表按类型分页签，卡上不再写类型；抽屉和完整讨论页离开了页签，带上类型记号。
// 受阻的等待原因不挤进这一行，由 IssueWaitReason 单独一行画在下面。
import type { ManagerIssueHead } from '../../../../protocol/src/manager-issues.mts'
import { useT } from '../../app/appearance.ts'
import { Icon } from '../../app/icons.tsx'
import { MissingResultReply } from '../../external/MissingResultReply.tsx'
import { plainText } from '../../notify/session-notice.ts'
import { Stamp } from '../../transcript/Stamp.tsx'

export function IssueKind({ kind }: { kind: ManagerIssueHead['kind'] }) {
  const t = useT()
  return (
    <span className="mg-issue-kind" data-issue-kind={kind}>
      {t(`issue.kind.${kind}`)}
    </span>
  )
}

export function IssueMeta({
  head,
  comments,
  withKind = false,
}: {
  head: ManagerIssueHead
  comments?: number | undefined
  withKind?: boolean
}) {
  const t = useT()
  return (
    <p className="mg-issue-meta" data-issue-meta>
      {withKind ? <IssueKind kind={head.kind} /> : null}
      <span data-issue-status={head.status}>
        <span className="mg-issue-state" data-state={head.status} aria-hidden="true" />
        {t(`issue.status.${head.status}` as Parameters<typeof t>[0])}
      </span>
      <span>{t(head.author === 'manager' ? 'issue.author.manager' : 'issue.author.user')}</span>
      {head.kind === 'ordinary' && head.followUp === 'off' ? (
        <span data-follow="off">
          <Icon name="pause" small /> {t('issue.follow.off')}
        </span>
      ) : null}
      {head.missingResultReply ? <MissingResultReply reply={head.missingResultReply} /> : null}
      <Stamp at={head.updatedAt} />
      {comments ? <span>{t('issue.commentCount', { n: comments })}</span> : null}
    </p>
  )
}

/** 受阻普通 issue 的等待原因：去掉 Markdown 记号的纯文字；列表里最多两行，展开和完整页看全文。 */
export function IssueWaitReason({
  head,
  full = false,
}: {
  head: Pick<ManagerIssueHead, 'id' | 'kind' | 'status' | 'blockedReason'>
  full?: boolean
}) {
  const t = useT()
  if (head.kind !== 'ordinary' || head.status !== 'blocked') return null
  const reason = head.blockedReason ? plainText(head.blockedReason) : ''
  return (
    <p
      className="mg-issue-wait"
      data-issue-wait-reason={head.id}
      data-full={full || undefined}
      data-empty={!reason || undefined}
    >
      <span className="mg-issue-wait-label">{t('issue.waiting')}</span>
      <span className="mg-issue-wait-text" title={!full && reason ? reason : undefined}>
        {reason || t('issue.waiting.noReason')}
      </span>
    </p>
  )
}
