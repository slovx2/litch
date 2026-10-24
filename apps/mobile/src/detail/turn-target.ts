// 回合菜单（turn-menu.tsx）里复制、分叉、回退对的是哪条用户消息，照桌面端的 TurnActions。
// 从回合进行中插进来的话上打开的，对这条话：回退切在它之前、文字放回输入框，分叉带到下一条自己插的话之前，
// 没有就是整个回合；要 harness 会切在回合中间（can.cutInTurn）才出，别的会话发来的、对面还没收下的话上不出。
// 不会切的不出这两项，免得退掉、带走整个回合。别处（回合开头那条、回答、状态行的“⋯”）打开的对整个回合。
import type { SessionMeta, UserMessageItem } from '@litch/core'
import type { SessionStore } from '../core/session-store'

export interface TurnTarget {
  /** 复制、菜单标题、回退后放回输入框的那条。回合里没有用户消息是 null */
  user: UserMessageItem | null
  /** 分叉。不出是 null；带 itemId 的只带到它之前 */
  fork: { itemId?: string } | null
  /** 回退。不出是 null；带 itemId 的切在它之前，这一回合前面的留着 */
  rollback: { itemId?: string } | null
}

export function turnTarget(
  store: Pick<SessionStore, 'userMessage' | 'steeredMessage' | 'nextSteer'>,
  can: SessionMeta['can'] | undefined,
  turnId: string,
  pressed: string | null,
): TurnTarget {
  const steer = pressed ? store.steeredMessage(turnId, pressed) : null
  if (!steer || !pressed) {
    // 声明了不会的不出；没声明的留着，对面说不认识了点了说为什么
    const declared = can?.declared === true
    return {
      user: store.userMessage(turnId),
      fork: declared && can?.fork === false ? null : {},
      rollback: declared && can?.rollback === false ? null : {},
    }
  }
  // 对面还没收下的插话没有对面的标识，切不到它
  const cut = can?.cutInTurn === true && !steer.peer && !steer.unconfirmed
  const next = store.nextSteer(turnId, pressed)
  return {
    user: steer,
    fork: cut && can?.fork === true ? (next ? { itemId: next } : {}) : null,
    rollback: cut && can?.rollback === true ? { itemId: pressed } : null,
  }
}
