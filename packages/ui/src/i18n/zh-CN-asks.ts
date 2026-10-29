// 模型边干活边问的题（codex 的 request_user_input_async）的中文文案：对话里的问题卡片、答复的那条消息；
// 问用户的工具（AskUserQuestion 等）答完以后的问答卡片也用这些。
// 桌面端和手机端共用。并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-asks.ts。
import type { Entry } from './types.ts'

export const zhAsks = {
  'ask.title': '问题',
  'ask.pending': '待答问题',
  'ask.pendingCount': '{count} 个问题待回答',
  'ask.state.open': '待回答',
  'ask.state.answered': '已答',
  'ask.state.closed': '未回答',
  'ask.other': '或自行填写',
  'ask.reply': '填写回答',
  'ask.send': '发送',
  'ask.note': '模型不会暂停等待，回答将插入当前回合',
  'ask.queued': '当前回合无法插入消息，回答已排队，将在回合结束后发送',
  'ask.skipped': '已跳过',
  'ask.replied': '已回答问题',
  'ask.picked': '已选',
} satisfies Record<string, Entry>
