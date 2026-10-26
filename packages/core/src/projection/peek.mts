// 会话眼下的情况（session.peek），系统通知的正文用。打开着的会话从核心自己的视图里取（有等人答复的请求），
// 没打开的从对面要来最近一个回合再投影（projectTurn），没有请求可看，停下来等人时只能从还在进行的条目里猜是什么事。
import type { ItemView, RequestView, SessionPeek, SessionPeekPending, TurnView } from '../model.mjs'

export function peekOf(
  turn: TurnView | undefined,
  itemOf: (id: string) => ItemView | undefined,
  requests: readonly RequestView[],
): SessionPeek {
  const items = (turn?.itemIds ?? []).flatMap((id) => {
    const item = itemOf(id)
    return item ? [item] : []
  })
  const answer = items.findLast(
    (item): item is Extract<ItemView, { kind: 'agentMessage' }> =>
      item.kind === 'agentMessage' && item.text.trim() !== '',
  )
  const request = requests[0]
  return {
    answer: answer ? answer.text.trim() : null,
    error: turn?.error?.trim() || null,
    pending: request ? pendingOfRequest(request, itemOf) : pendingOfItems(items),
  }
}

const joined = (paths: readonly string[]): string => paths.join(', ')

function pendingOfRequest(
  request: RequestView,
  itemOf: (id: string) => ItemView | undefined,
): SessionPeekPending {
  switch (request.kind) {
    case 'question':
      return {
        kind: 'question',
        text: request.questions.map((entry) => entry.question || entry.header).join('\n'),
      }
    case 'form':
      return { kind: 'form', text: request.message }
    case 'clientAsk':
      return {
        kind: 'other',
        text: request.ask.kind === 'site' ? request.ask.origin : request.tool.name,
      }
    case 'approval':
      switch (request.subject) {
        case 'command':
          return { kind: 'command', text: request.command ?? request.reason ?? '' }
        case 'fileChange': {
          const item = request.itemId ? itemOf(request.itemId) : undefined
          const paths = item?.kind === 'fileChange' ? item.changes.map((entry) => entry.path) : []
          return {
            kind: 'fileChange',
            text: paths.length > 0 ? joined(paths) : (request.reason ?? ''),
          }
        }
        case 'permissions': {
          const wanted = request.permissions
          return {
            kind: 'permissions',
            text: wanted ? joined([...wanted.write, ...wanted.read]) : (request.reason ?? ''),
          }
        }
        case 'tool':
          return { kind: 'tool', text: request.tool?.title ?? request.tool?.server ?? '' }
      }
  }
}

/** 没有请求可看（会话没打开）：最后一个还在进行的命令、改动、工具调用多半就是在等批准的那一个 */
function pendingOfItems(items: readonly ItemView[]): SessionPeekPending | null {
  const item = items.findLast(
    (entry) =>
      (entry.kind === 'command' || entry.kind === 'fileChange' || entry.kind === 'toolCall') &&
      entry.status === 'inProgress',
  )
  if (item?.kind === 'command') return { kind: 'command', text: item.command }
  if (item?.kind === 'fileChange')
    return { kind: 'fileChange', text: joined(item.changes.map((entry) => entry.path)) }
  if (item?.kind === 'toolCall') return { kind: 'tool', text: item.tool }
  return null
}
