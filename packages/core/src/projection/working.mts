// 回合进行中，对话末尾那一行“xxx 正在工作”出不出。纯函数，桌面端和手机端共用一套规矩。
// 它只填空档：等第一个字、思考没画出来、两段输出之间、两个工具之间的停顿。
// 别处已经在表示“正在做”时不出：正文末尾有光标、步骤组的汇总行写着“正在运行 X”、有待答的审批或提问。

import type { ItemView } from '../model.mjs'
import { quietOf } from './blocks.mjs'

/**
 * 回合在跑时末尾的状态行该不该显示。items 是这个回合的条目（按先后，取不到的给 undefined），
 * pending 是会话里待答的请求（审批、提问、表单）个数。
 * - 回合不在跑：不显示（换成回合结束那一行）。
 * - 有待答的请求：不显示，等的是人，输入区上方的卡片已经说了。
 * - 有正在写、已经有字的助手消息：不显示，正文末尾的光标就是“正在工作”。还没出字的不算，那还是在等。
 * - 有别的条目正在跑（命令、改文件、工具调用、思考……）：不显示，它所在的那一行带着运行记号。
 *   不画的条目（空的收尾调用，quietOf）不算。
 * 出字停下多久才显示是界面的事（防一卡一卡地闪），这里只给此刻的结论
 */
export function workingShown(
  running: boolean,
  items: readonly (ItemView | undefined)[],
  pending: number,
): boolean {
  if (!running || pending > 0) return false
  for (const item of items) {
    if (!item || !('status' in item) || item.status !== 'inProgress') continue
    if (item.kind === 'agentMessage') {
      if (item.text !== '') return false
      continue
    }
    if (!quietOf(item)) return false
  }
  return true
}
