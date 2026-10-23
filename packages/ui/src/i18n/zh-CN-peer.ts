// 别的会话发来的消息（Claude 的本机收件箱）的中文文案：对话里那条消息上面的来源行，发送方那边“发消息给”的步骤
// （收件方认不出名字时的说法、详情里的收件方）。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-peer.ts。
import type { Entry } from './types.ts'

export const zhPeer = {
  'peer.from': '来自 {name} 的消息',
  'peer.fromUnnamed': '来自另一个会话的消息',
  'peer.bypass': '对方跳过确认',
  'peer.bypassHint': '发来消息的会话执行工具前不问用户。它的请求在这里按这个会话自己的权限执行。',
  'peer.open': '在 Claude 桌面端打开',
  'peer.openHint': '打开发来这条消息的 Claude 桌面端会话',
  'peer.openLitch': '打开会话',
  'peer.openLitchHint': '在 Litch 里打开发来这条消息的会话',
  'activity.message': '发送 {n} 条消息',
  'activity.now.message': '正在发消息给',
  'tool.message.verb': '发消息给',
  'tool.message.peer': '另一个 Claude 会话',
  'tool.message.peerPid': '另一个 Claude 会话（进程 {pid}）',
  'tool.message.to': '收件方',
  'tool.message.openLitchHint': '在 Litch 里打开收到这条消息的会话',
  'tool.message.openHint': '打开收到这条消息的 Claude 桌面端会话',
} satisfies Record<string, Entry>
