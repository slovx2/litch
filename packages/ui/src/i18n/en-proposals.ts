// 建议任务的英文文案。键必须和 zh-CN-proposals.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhProposals } from './zh-CN-proposals.ts'

export const enProposals: Record<keyof typeof zhProposals, Entry> = {
  'proposal.kind': 'Suggested task',
  'proposal.start': 'Start',
  'proposal.edit': 'Edit and start',
  'proposal.edit.title': 'Edit and start',
  'proposal.dismiss': 'Dismiss',
  'proposal.failed': 'Did not work: {reason}',
  'proposal.fresh': 'Fresh',
  'proposal.fork': 'With context',
  'proposal.brief.more': 'Show the whole brief',
  'proposal.brief.less': 'Show less',
  'proposal.wider':
    'This harness has no sandbox this strict; the sub-session will run with "{level}"',
  'proposal.state.pending': 'Waiting for you',
  'proposal.state.started': 'Started',
  'proposal.state.dismissed': 'Dismissed',
  'proposal.state.withdrawn': 'Withdrawn',
  'proposal.state.expired': 'Expired',
  'proposal.state.unknown': 'Proposal closed',
  'proposal.refused': 'Not taken: {reason}',
  'proposal.refusedBare': 'Not taken',
  'proposal.actual': 'Started: shows the sub-session that was actually started',
  'proposal.reveal': 'Find this card in the conversation',
  'proposal.none': 'No suggested tasks in this conversation yet',
  'proposal.nonePending': 'No suggested tasks waiting to start',
  'proposal.pending': 'Suggested tasks waiting to start',
  'proposal.settled': 'Settled ({n})',
  'proposal.settledList': 'Settled suggested tasks',
  'proposal.badge': ({ n }) =>
    Number(n) === 1 ? '1 suggested task waiting' : `${n} suggested tasks waiting`,
  'side.tab.proposals': 'Suggested',
}
