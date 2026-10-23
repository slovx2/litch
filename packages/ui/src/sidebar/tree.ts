// 会话树在列表里怎么排：哪些子会话挂到父会话下面去画、收起了的父会话下面还露出哪些、最多套几层。
// 只管算，不碰页面，桌面侧栏（Sidebar.tsx）和手机的会话列表（apps/mobile 的 sessions/list.ts）共用。
// 谁是谁的子会话、兄弟之间的先后由核心算好（keys.children），这里不再排。
import type { SessionChildren } from '@litch/core'

/** 子会话最多套几层：父子关系由设备进程保证不成环；万一对面给错了，也不至于一直套下去 */
export const MAX_DEPTH = 8

/**
 * 挂到父会话下面去画的子会话：父会话这时也画在列表里（没被筛掉、没藏起来）的那些。
 * listed 是各组里要画的会话（还没去掉子会话）；父会话被筛掉了的，子会话照常排在自己那一组里
 */
export function nestedUnder(listed: Iterable<string>, children: SessionChildren): Set<string> {
  const shown = new Set(listed)
  return new Set(
    Object.entries(children).flatMap(([parent, ids]) => (shown.has(parent) ? ids : [])),
  )
}

/** 父会话下面现在露出来的子会话：收起了只露出非露出来不可的（正选中的、停下来等人的） */
export const kidsShown = (
  kids: readonly string[],
  folded: boolean,
  always: (sessionId: string) => boolean,
): readonly string[] => (folded ? kids.filter(always) : kids)
