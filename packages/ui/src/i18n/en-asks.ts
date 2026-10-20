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
  'ask.note': 'The model keeps working; your answer goes into the running turn',
  'ask.queued': 'This turn cannot take input now; your answer is queued and goes out when it ends',
  'ask.skipped': 'Skipped',
  'ask.replied': 'Answered a question',
}
