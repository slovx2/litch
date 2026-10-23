// 发出去之前给提到的会话补上写进那一段的东西（projection/outgoing.mts 的 bodyOf 照着写）：
// harness、目录、状态、最近更新；当前会话里的模型读不到别的会话时（没带 litch_sessions），再替它读一次，附上最近一个回合的摘录。
// 提到的会话都在同一台设备上（输入框的单子只列这台设备的），所以读得到与否只看当前会话。
import { CLIENT_TOOL_NAMESPACE } from '../../../protocol/src/client-tools.mjs'
import type { Thread } from '../../../protocol/src/index.mjs'
import {
  excerptOfTurns,
  type SessionMentionExcerpt,
  type SessionMentionRef,
} from '../../../protocol/src/session-mentions.mjs'
import type { SessionTreeThreadFields } from '../../../protocol/src/session-tree.mjs'
import type { MessageExtra, OutgoingMessage, SessionSummary } from '../model.mjs'

/** 替模型读一个会话最多等多久（毫秒）：读不到就只给引用，不让发送卡住 */
export const MENTION_READ_MS = 2000

export interface MentionHost {
  /** 侧栏里这台设备上的一个会话；不认识是 undefined */
  summary(threadId: string): SessionSummary | undefined
  /** 读一个会话，带回合；最多等 MENTION_READ_MS */
  read(threadId: string): Promise<Thread>
  log(line: string): void
}

/** 这个会话里的模型能不能用 litch_sessions 读别的会话：看设备进程报的 litchToolNamespaces，没报的当不能 */
export const readsSessions = (thread: Thread | undefined): boolean =>
  (thread as (Thread & SessionTreeThreadFields) | undefined)?.litchToolNamespaces?.includes(
    CLIENT_TOOL_NAMESPACE.sessions,
  ) === true

/** 消息里提到了会话 */
export const mentionsSessions = (message: OutgoingMessage): boolean =>
  message.extras.some((extra) => extra.kind === 'session')

/**
 * 消息里提到的会话补上 ref。readable：当前会话（或者马上要建的会话）里的模型能用 litch_sessions 读别的会话。
 * 没提到会话的原样返回
 */
export async function withMentionRefs(
  message: OutgoingMessage,
  readable: boolean,
  host: MentionHost,
): Promise<OutgoingMessage> {
  if (!mentionsSessions(message)) return message
  const extras = await Promise.all(
    message.extras.map(async (extra): Promise<MessageExtra> => {
      if (extra.kind !== 'session') return extra
      const known = host.summary(extra.threadId)
      const ref: SessionMentionRef = {
        threadId: extra.threadId,
        title: extra.title,
        harness: known?.harness ?? null,
        cwd: known?.cwd || null,
        status: known?.status ?? null,
        updatedAt: known?.updatedAt || null,
      }
      if (!readable) ref.excerpt = await excerpt(extra.threadId, host)
      return { ...extra, ref }
    }),
  )
  return { ...message, extras }
}

async function excerpt(threadId: string, host: MentionHost): Promise<SessionMentionExcerpt | null> {
  try {
    const thread = await host.read(threadId)
    return excerptOfTurns(thread.turns)
  } catch (error) {
    host.log(`读提到的会话 ${threadId} 失败：${String(error)}`)
    return null
  }
}
