// 侧面板“建议任务”标签上的角标：眼前这个会话有几张等着开始的提案，没有不画。
// 跟着标签栏一直在、在启动那一包里，所以单独一个小文件，不把整个标签拉进来。
import { proposalStatus } from '@litch/core'
import { useT } from '../app/appearance.ts'
import type { SidePlace } from '../side/tabs.ts'
import { useProposalClock, useProposalList } from './proposals.ts'

export function ProposalsBadge({ place }: { place: SidePlace }) {
  const t = useT()
  const list = useProposalList(place.deviceId, place.sessionId ?? '')
  const now = useProposalClock(list)
  const count = (list ?? []).filter((entry) => proposalStatus(entry, now) === 'pending').length
  if (!place.sessionId || count === 0) return null
  return (
    <span className="side-badge" title={t('proposal.badge', { n: count })}>
      {count}
    </span>
  )
}
