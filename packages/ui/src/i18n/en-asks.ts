// 问题卡片的英文文案。键必须和 zh-CN-asks.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhAsks } from './zh-CN-asks.ts'

export const enAsks: Record<keyof typeof zhAsks, Entry> = {
  'ask.title': 'Question',
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
  'ask.picked': 'Selected',
}
