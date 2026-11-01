import type { ItemView, TurnView } from '../model.mjs'
import { parseComments } from './comments.mjs'

/** 输入框只回忆用户亲自发的话；回报注入已由投影拆出，保留其后的用户正文。 */
export function inputHistory(
  turns: readonly TurnView[],
  itemOf: (id: string) => ItemView | undefined,
): string[] {
  const sent: string[] = []
  for (const turn of turns) {
    for (const id of turn.itemIds) {
      const item = itemOf(id)
      if (item?.kind !== 'userMessage' || item.peer || item.system) continue
      // 不按回合来源整轮排除：自动回合也可能收到用户插话，队列同样来自用户。
      // goal 的代发输入、原生后台通知由投影或入口隐藏；重启/恢复指令带 system。
      const words = parseComments(item.text)?.rest ?? item.text
      if (words.trim() && sent.at(-1) !== words) sent.push(words)
    }
  }
  return sent
}
