// 回合进行中，对话末尾那一行“xxx 正在工作”出不出。纯函数，桌面端和手机端共用一套规矩。
// 回合在跑时它一直在，只在两种时候让开：正文正在出字（末尾的光标就是“正在工作”），有待答的审批或提问（等的是人）。
// 命令、工具、思考这些步骤来来去去不影响它：它们常常一百毫秒上下就完，跟着隐去显出就是在闪。

import type { ItemView } from '../model.mjs'

/**
 * 回合在跑时末尾的状态行该不该显示。items 是这个回合的条目（按先后，取不到的给 undefined），
 * pending 是会话里待答的请求（审批、提问、表单）个数。
 * - 回合不在跑：不显示（换成回合结束那一行）。
 * - 有待答的请求：不显示，输入区上方的卡片已经说了。
 * - 有正在写、已经有字的助手消息（说明或最终回答）：不显示。还没出字的不算，那还是在等。
 * - 别的都显示，包括命令、改文件、工具调用、思考正在跑的时候。
 * 出字停下多久才显示是界面的事（两段正文挨着时不闪），这里只给此刻的结论
 */
export function workingShown(
  running: boolean,
  items: readonly (ItemView | undefined)[],
  pending: number,
): boolean {
  if (!running || pending > 0) return false
  return !items.some(
    (item) => item?.kind === 'agentMessage' && item.status === 'inProgress' && item.text !== '',
  )
}
