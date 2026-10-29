// 问题卡片的英文文案。键必须和 zh-CN-asks.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhAsks } from './zh-CN-asks.ts'

export const enAsks: Record<keyof typeof zhAsks, Entry> = {
  'ask.age': 'Asked {count} min ago',
  'ask.ageUnknown': 'Time unavailable',
  'ask.reportsAfter': '{count} updates since',
  'ask.ignore': 'Ignore',
  'ask.children': 'Sub-session requests',
  'ask.childrenCount': ({ count }) =>
    Number(count) === 1 ? '1 sub-session is waiting' : `${count} sub-sessions are waiting`,
  'ask.requestFallback': 'Pending request',
  'ask.childUnavailable': 'Loading the request. Open the sub-session if it cannot be handled here.',
  'ask.delegatedHistory': 'Delegated responses · {count}',
  'ask.approvalRecorded': 'Approval decision recorded',
  'ask.delegatedParent': 'Answered by parent · {name}',
  'ask.delegatedSession': 'Answered by session · {name}',
  'ask.title': 'Question',
  'ask.pending': 'Pending questions',
  'ask.pendingCount': '{count} questions awaiting answers',
  'ask.state.open': 'Waiting for you',
  'ask.state.answered': 'Answered',
  'ask.state.closed': 'Not answered',
  'ask.other': 'Or write your own',
  'ask.reply': 'Write an answer',
  'ask.send': 'Send',
  'ask.note': 'The model keeps working. Your answer is added to the current turn.',
  'ask.queued':
    'This turn can’t take input now. Your answer is queued and sent when the turn ends.',
  'ask.skipped': 'Skipped',
  'ask.replied': 'Answered a question',
  'ask.answeredCount': '{count} answered',
  'ask.answer': 'Answer',
  'ask.options': 'View other options',
  'ask.optionsAll': 'View options',
  'ask.picked': 'Selected',
}
