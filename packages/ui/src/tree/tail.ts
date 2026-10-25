// 回合最下方收尾区里的那个问题（litch_sessions.wrap_up 的 ask 和回复按钮）：取哪一个、还能不能答、用户回的是哪个。
// 只有纯函数，组件在 TurnTail.tsx；手机端也引这一份。单测在 test/tail.test.mjs。
import type { ItemView } from '@litch/core'

export interface TailAsk {
  /** 带问题的那次收尾调用 */
  itemId: string
  ask: string
  actions: { label: string; message?: string }[]
}

/** 收尾区里的问题：回合里最后一个带问题的收尾。没有是 null */
export function tailAsk(items: readonly (ItemView | undefined)[]): TailAsk | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.kind !== 'toolCall' || !item.wrapUp?.ask) continue
    return { itemId: item.id, ask: item.wrapUp.ask, actions: item.wrapUp.actions ?? [] }
  }
  return null
}

/** 点了按钮发出去的话：有 message 发它，没有发按钮上的字 */
export const actionText = (action: { label: string; message?: string }): string =>
  action.message?.trim() || action.label

/**
 * 问题还能不能答：它所在的回合是会话的最后一个回合，回合里它后面没有用户的话（插话），
 * 也就是下一条用户消息还没来。来了之后按钮失效、问题折成一行
 */
export function askOpen(
  turnItemIds: readonly string[],
  askItemId: string,
  isLastTurn: boolean,
  kindOf: (itemId: string) => string | undefined,
): boolean {
  if (!isLastTurn) return false
  const at = turnItemIds.indexOf(askItemId)
  if (at < 0) return false
  return !turnItemIds.slice(at + 1).some((id) => kindOf(id) === 'userMessage')
}

/**
 * 过去了的问题还画不画：认得出用户回的是哪个按钮（replied 不空）才留一行“已回复”。
 * 别的都不画：用户插了话、回合接着跑完的，用户另写了别的话的，问题已经过期，留着只是一行没头没尾的字
 */
export const pastAskShown = (replied: string | null): boolean => replied !== null

/** 用户回的是哪个按钮：下一条用户消息的字和哪个按钮发的话一样，就是它（按钮上的字）。都不是是 null */
export function askReplied(
  actions: readonly { label: string; message?: string }[],
  text: string | null | undefined,
): string | null {
  const said = text?.trim()
  if (!said) return null
  return actions.find((action) => actionText(action) === said)?.label ?? null
}
