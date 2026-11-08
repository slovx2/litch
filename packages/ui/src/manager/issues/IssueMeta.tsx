// issue 卡头下面的一行小字：（类型记号）· 状态 · 创建者 · 跟进（只在暂停时写） · 更新时间 · 评论数。状态不另占一行。
// 列表按类型分页签，卡上不再写类型；抽屉和完整讨论页离开了页签，带上类型记号。
import type { ManagerIssueHead } from '../../../../protocol/src/manager-issues.mts'
import { useT } from '../../app/appearance.ts'
import { Icon } from '../../app/icons.tsx'
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
      <Stamp at={head.updatedAt} />
      {comments ? <span>{t('issue.commentCount', { n: comments })}</span> : null}
    </p>
  )
}
