// 回退、分叉切在回合中间：插进回合的那条用户消息之前。
//
// 插话在 Claude Code 的原生记录里不是一行普通的用户消息，而是一行 queued_command 附件，
// 附件的 source_uuid 是交给 CLI 时那条消息的标识（入口用条目自己的标识当它，见 server.mts 的 turnSteer）。
// 从这一行顺着 parentUuid 往回，第一条主线上的用户或助手消息就是切口：原生会话复制到它为止，
// 插话和它之后的都不要。CLI 自己的回退、Claude 桌面端的回退都是这样从插话那一行往前找。
// 读不到记录、找不到这一行的返回 null，调用的地方报错，不去猜位置。

import { readFileSync } from 'node:fs'
import { claudeConfigDir } from './claude-native-files.mjs'
import { findNativeRecords } from './native-lineage.mjs'

interface Entry {
  type?: unknown
  uuid?: unknown
  parentUuid?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  attachment?: { type?: unknown; source_uuid?: unknown }
}

/** 记录内容里，插话 messageId 之前那条主线消息的标识 */
export function cutBeforeSteer(content: string, messageId: string): string | null {
  const byId = new Map<string, Entry>()
  let target: Entry | null = null
  for (const line of content.split('\n')) {
    // 先按字面筛：大多数行用不着解析
    if (!line.includes('"uuid"')) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (typeof entry.uuid !== 'string' || entry.isSidechain === true) continue
    byId.set(entry.uuid, entry)
    const steered =
      entry.type === 'attachment' &&
      entry.attachment?.type === 'queued_command' &&
      entry.attachment.source_uuid === messageId
    // 回合刚好在收尾、CLI 把它当成下一句普通的话收下时，它是一行用户消息，标识就是它
    if (steered || (entry.type === 'user' && entry.uuid === messageId)) target ??= entry
  }
  if (!target) return null
  const seen = new Set<string>()
  let at = typeof target.parentUuid === 'string' ? byId.get(target.parentUuid) : undefined
  while (at && typeof at.uuid === 'string' && !seen.has(at.uuid)) {
    seen.add(at.uuid)
    if ((at.type === 'user' || at.type === 'assistant') && at.isMeta !== true) return at.uuid
    at = typeof at.parentUuid === 'string' ? byId.get(at.parentUuid) : undefined
  }
  return null
}

/** 到原生会话 sessionId 的记录里找切口 */
export function readCutBeforeSteer(sessionId: string, messageId: string): string | null {
  const path = findNativeRecords(claudeConfigDir(), [sessionId]).get(sessionId)
  if (!path) return null
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  return cutBeforeSteer(content, messageId)
}
