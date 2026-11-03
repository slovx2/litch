// 题目引用只跳到已知的原卡；不按题面猜另一道相似的问题。
import { askReplySource, type ItemView, keys, type Replica, type TurnView } from '@litch/core'
import { setToggle } from './state.ts'

export function replySource(
  store: Replica['store'],
  deviceId: string,
  sessionId: string,
  id: string,
) {
  return askReplySource(
    id,
    (store.get<string[]>(keys.turnIds(deviceId, sessionId)) ?? []).flatMap((id) => {
      const turn = store.get<TurnView>(keys.turn(deviceId, sessionId, id))
      return turn ? [turn] : []
    }),
    (id) => store.get<ItemView>(keys.item(deviceId, sessionId, id)),
  )
}

export async function revealReplySource(
  store: Replica['store'],
  deviceId: string,
  sessionId: string,
  id: string,
): Promise<boolean> {
  const source = replySource(store, deviceId, sessionId, id)
  if (!source) return false
  const scope = `${deviceId}:${sessionId}`
  for (const prefix of ['ask', 'wrap']) setToggle(scope, `${prefix}:${source.itemId}`, true)
  // 卡片可能正等 React 提交；收尾卡的标记在外层，不能跳到过程中的工具摘要。
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const selector = `[data-search-item="${CSS.escape(source.itemId)}"]`
    const root =
      document.querySelector(`.main .tr .turn-tail ${selector}`) ??
      document.querySelector(`.main .tr .ask${selector}`)
    if (!root) continue
    root.scrollIntoView({ block: 'center', behavior: 'auto' })
    root.setAttribute('data-flash', '')
    window.setTimeout(() => root.removeAttribute('data-flash'), 1600)
    return true
  }
  return false
}
