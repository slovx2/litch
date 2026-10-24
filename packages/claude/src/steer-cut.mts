// 回退、分叉切在回合中间：插进回合的那条用户消息之前。
//
// 插话在 Claude Code 的原生记录里不是一行普通的用户消息，而是一行 queued_command 附件，
// 附件的 source_uuid 是交给 CLI 时那条消息的标识（入口用条目自己的标识当它，见 server.mts 的 turnSteer）。
// 从这一行顺着 parentUuid 往回，第一条主线上的用户或助手消息就是切口：原生会话复制到它为止，
// 插话和它之后的都不要。CLI 自己的回退、Claude 桌面端的回退都是这样从插话那一行往前找。
// 原生会话复制过（分叉、回退都会复制）的，每一行的 uuid 都重新生成了，附件里的 source_uuid 不在记录里时照旧，
// 被当成普通用户消息收下的那行就认不出来了；复制出来的行带 forkedFrom（来源会话、那一行在来源里的标识），
// 到来源会话里找到它，再按 forkedFrom 对回来，复制过几次就往上找几层。
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
  forkedFrom?: { sessionId?: unknown; messageUuid?: unknown }
}

/** 按会话标识读它的原生记录，读不到是 null */
export type LoadRecords = (sessionId: string) => string | null

/** 往上找来源会话最多几层：防着记录里来源绕成圈 */
const MAX_FORK_DEPTH = 32

/** 主线上带标识的行，按标识 */
function parseRecords(content: string): Map<string, Entry> {
  const byId = new Map<string, Entry>()
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
  }
  return byId
}

/** 插话 messageId 在这份记录里的那一行；这份是复制来的就到来源里找了再对回来 */
function steerLine(
  byId: Map<string, Entry>,
  messageId: string,
  load: LoadRecords | undefined,
  depth: number,
): Entry | null {
  for (const entry of byId.values()) {
    const steered =
      entry.type === 'attachment' &&
      entry.attachment?.type === 'queued_command' &&
      entry.attachment.source_uuid === messageId
    // 回合刚好在收尾、CLI 把它当成下一句普通的话收下时，它是一行用户消息，标识就是它
    if (steered || (entry.type === 'user' && entry.uuid === messageId)) return entry
  }
  if (!load || depth >= MAX_FORK_DEPTH) return null
  const sources = new Set<string>()
  for (const entry of byId.values()) {
    const from = entry.forkedFrom?.sessionId
    if (typeof from === 'string') sources.add(from)
  }
  for (const source of sources) {
    const content = load(source)
    if (content === null) continue
    const upstream = steerLine(parseRecords(content), messageId, load, depth + 1)
    if (!upstream) continue
    for (const entry of byId.values()) {
      if (entry.forkedFrom?.sessionId === source && entry.forkedFrom.messageUuid === upstream.uuid)
        return entry
    }
  }
  return null
}

/** 记录内容里，插话 messageId 之前那条主线消息的标识。给了 load 的，复制过的记录也找得到 */
export function cutBeforeSteer(
  content: string,
  messageId: string,
  load?: LoadRecords,
): string | null {
  const byId = parseRecords(content)
  const target = steerLine(byId, messageId, load, 0)
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

/** 原生会话 sessionId 的记录内容，读不到是 null */
function readRecords(sessionId: string): string | null {
  const path = findNativeRecords(claudeConfigDir(), [sessionId]).get(sessionId)
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 到原生会话 sessionId 的记录里找切口 */
export function readCutBeforeSteer(sessionId: string, messageId: string): string | null {
  const content = readRecords(sessionId)
  return content === null ? null : cutBeforeSteer(content, messageId, readRecords)
}
