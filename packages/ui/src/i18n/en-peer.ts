// 别的会话发来的消息的英文文案。键必须和 zh-CN-peer.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhPeer } from './zh-CN-peer.ts'

const plural = (n: string | number | undefined, one: string, many: string) =>
  `${n} ${Number(n) === 1 ? one : many}`

export const enPeer: Record<keyof typeof zhPeer, Entry> = {
  'peer.from': 'Message from {name}',
  'peer.fromUnnamed': 'Message from another session',
  'peer.bypass': 'Sender skips approvals',
  'peer.bypassHint':
    "The sending session runs tools without asking. Its request runs here with this session's own permissions.",
  'peer.open': 'Open in Claude',
  'peer.openHint': 'Open the Claude desktop session that sent this message',
  'activity.message': ({ n }) => `sent ${plural(n, 'message', 'messages')}`,
  'activity.now.message': 'Messaging',
  'tool.message.verb': 'Message',
}
