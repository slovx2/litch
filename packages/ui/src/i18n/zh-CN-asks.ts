// 模型边干活边问的题（codex 的 request_user_input_async）的中文文案：对话里的问题卡片、答复的那条消息；
// 问用户的工具（AskUserQuestion 等）答完以后的问答卡片也用这些。
// 桌面端和手机端共用。并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-asks.ts。
import type { Entry } from './types.ts'

export const zhAsks = {
  'ask.children': '子会话待处理',
  'ask.childUnavailable': '正在读取请求；若无法在此处理，请打开子会话。',
  'ask.delegatedHistory': '代答记录 · {count} 条',
  'ask.approvalRecorded': '已记录审批决定',
  'ask.delegatedParent': '由主会话代答 · {name}',
  'ask.delegatedSession': '由会话代答 · {name}',
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
  'ask.answeredCount': '已答 {count} 题',
  'ask.answer': '回答',
  'ask.options': '查看其他选项',
  'ask.optionsAll': '查看选项',
  'ask.picked': '已选',
} satisfies Record<string, Entry>
