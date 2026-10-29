// 只正规化待答派生需要的历史字段，设备不用加载客户端投影或保存第二份问题集合。
import { projectQuestions } from './async-asks.mjs'
import { SESSION_TOOL_LIMITS } from './client-tools-sessions.mjs'
import {
  type PendingItem,
  type PendingTurn,
  questionSource,
  questionsOfView,
} from './pending-asks.mjs'
import { parseSessionEvent } from './session-tree.mjs'
import { parseSessionMessage, parseSystemMessage } from './system-messages.mjs'

const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const word = (value: unknown): string => (typeof value === 'string' ? value : '')
const millis = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null

/** 历史与实时投影共用；失败的工具不能撤回旧题。 */
export function wrapQuestionFields(
  args: unknown,
  failed: boolean,
): NonNullable<PendingItem['wrapUp']> {
  const given = object(args)
  const ask = word(given.ask).trim()
  const actions = list(given.actions)
    .flatMap((entry) => {
      const raw = object(entry)
      const label = word(raw.label).trim()
      const message = word(raw.message).trim()
      return label ? [message ? { label, message } : { label }] : []
    })
    .slice(0, SESSION_TOOL_LIMITS.wrapUpActions)
  return {
    ...(!failed && Array.isArray(given.withdraw_questions)
      ? {
          withdrawQuestions: given.withdraw_questions
            .filter((v: unknown): v is string => typeof v === 'string')
            .map((v: string) => v.trim()),
        }
      : {}),
    ...(ask ? { ask } : {}),
    ...(ask && actions.length ? { actions } : {}),
  }
}

export function pendingHistory(thread: unknown) {
  const turns: PendingTurn[] = []
  const items: Record<string, PendingItem> = {}
  for (const raw of list(object(thread).turns)) {
    const turn = object(raw)
    const id = word(turn.id)
    const origin = ['backgroundTask', 'schedule', 'goal', 'queue', 'peer'].includes(
      turn.litchOrigin,
    )
      ? turn.litchOrigin
      : undefined
    const itemIds: string[] = []
    for (const [index, value] of list(turn.items).entries()) {
      const item = object(value)
      if (origin === 'goal' && item.type === 'userMessage') continue
      const rawId = word(item.id) || `#${index}`
      const key = `${id}:${rawId}`
      const view: PendingItem = {
        id: key,
        kind: 'other',
        questionSource: questionSource(id, rawId),
      }
      if (item.type === 'userMessage') {
        const content = list(item.content)
        const text = content
          .filter((p) => p.type === 'text')
          .map((p) => word(p.text))
          .join('\n')
        view.kind = 'userMessage'
        view.attachments = content.filter((p) =>
          ['image', 'localImage', 'audio', 'localAudio', 'skill', 'mention'].includes(p.type),
        )
        if (item.litchPeer) {
          view.text = text
          view.peer = item.litchPeer
        } else {
          const { event, rest } = parseSessionEvent(text)
          const said = event ? rest : text
          view.text = said
          if (event) view.event = event
          const system = parseSystemMessage(said)
          const peer = parseSessionMessage(said)
          if (system) view.system = system
          else if (peer) {
            view.peer = peer
            view.text = peer.message
          }
        }
      } else if (item.type === 'agentMessage') {
        view.kind = 'agentMessage'
        const questions = projectQuestions(word(item.id), item.questions)
        if (questions) view.questions = questions
      } else if (
        item.type === 'dynamicToolCall' &&
        item.namespace === 'litch_sessions' &&
        item.tool === 'wrap_up'
      ) {
        view.kind = 'toolCall'
        view.status =
          item.status === 'inProgress'
            ? 'inProgress'
            : item.status === 'failed'
              ? 'failed'
              : 'completed'
        view.wrapUp = wrapQuestionFields(item.arguments, item.success === false)
      }
      items[key] = view
      itemIds.push(key)
    }
    turns.push({
      id,
      itemIds,
      origin,
      status: turn.status === 'inProgress' ? 'running' : turn.status,
      startedAt: millis(turn.startedAt),
    })
  }
  return { turns, items, queued: [] as { text: string }[] }
}

export function questionsOfHistory(
  thread: unknown,
  ignoredQuestions: string[] = [],
  queued: { text: string }[] = [],
) {
  return questionsOfView({ ...pendingHistory(thread), ignoredQuestions, queued })
}
