// 模型边干活边问的题（codex 的 request_user_input_async）的中文文案：对话里的问题卡片、答复的那条消息。
// 桌面端和手机端共用。并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-asks.ts。
import type { Entry } from './types.ts'

export const zhAsks = {
  'ask.title': '问题',
  'ask.state.open': '等你回答',
  'ask.state.answered': '已答',
  'ask.state.closed': '没有回答',
  'ask.other': '或者自己写',
  'ask.reply': '写下回答',
  'ask.send': '发送',
  'ask.note': '模型没有停下来等，答了会插进正在进行的回合',
  'ask.queued': '这个回合插不进话，答复排在队列里，回合结束后发出',
  'ask.skipped': '跳过了',
  'ask.replied': '回答了问题',
} satisfies Record<string, Entry>
