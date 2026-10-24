// 一条用户消息上出不出“分叉”“回退”（TurnActions.tsx 用）。
// 回合开头那条按回合切：声明了不会的不出，没声明的留着（点了对面说不认识再说为什么）。
// 回合进行中插进来的话只切在它之前：要 harness 声明了会切在回合中间（can.cutInTurn）才出；
// 别的会话发来的、对面还没收下的（没有对面的标识）不出。插进来的话上绝不退、不带整个回合。
import type { ItemView, SessionMeta } from '@litch/core'

export interface MessageActions {
  fork: boolean
  rollback: boolean
  /** 切在回合中间：插进来的话上，或者会切的 harness 上从开头那条分叉（带到下一条插进来的话之前） */
  cut: boolean
}

export function messageActions(
  meta: SessionMeta | undefined,
  steered: boolean,
  item: ItemView | undefined,
): MessageActions {
  const user = item?.kind === 'userMessage' ? item : undefined
  const cut = meta?.can.cutInTurn === true && !(steered && (user?.peer || user?.unconfirmed))
  if (steered)
    return {
      fork: cut && meta?.can.fork === true,
      rollback: cut && meta?.can.rollback === true,
      cut,
    }
  const declared = meta?.can.declared === true
  return {
    fork: !(declared && meta?.can.fork === false),
    rollback: !(declared && meta?.can.rollback === false),
    cut,
  }
}
