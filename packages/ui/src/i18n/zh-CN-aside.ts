// 侧聊的中文文案：侧面板的“侧聊”标签、选字浮层上的按钮、关闭与新侧聊的确认。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-aside.ts。
import type { Entry } from './types.ts'

export const zhAside = {
  'side.tab.aside': '侧聊',
  'aside.intro':
    '从这个会话临时分出一段对话，带着它到目前为止的上下文。主会话照常进行，侧聊里的内容不会进入主会话；关闭后不保留。',
  'aside.start': '开始侧聊',
  'aside.forking': '正在分出侧聊…',
  'aside.failed': '未能开始侧聊：{reason}',
  'aside.retry': '重试',
  'aside.context': '带着主会话到此为止的上下文',
  'aside.empty': '在下方输入问题。主会话不受影响。',
  'aside.renew': '新侧聊',
  'aside.renew.hint': '关闭当前侧聊，从主会话最新的内容重新开始',
  'aside.renew.title': '开始新侧聊？',
  'aside.close': '关闭侧聊',
  'aside.close.title': '关闭侧聊？',
  'aside.close.note': '侧聊的内容关闭后无法找回。',
  'aside.close.yes': '关闭',
  'aside.close.no': '取消',
  'aside.gone': '这段侧聊已不存在（应用重启或设备重新连接后会这样）。',
  'aside.unsupported': '这个会话的 harness 不支持侧聊。',
  'aside.unstarted': '会话发出第一条消息后才能开始侧聊。',
  'aside.pop': '侧聊',
  'aside.pop.send': '发到侧聊',
  'aside.pop.parent': '带回主会话',
  'aside.quoted': '已放进主会话的输入框',
} satisfies Record<string, Entry>
