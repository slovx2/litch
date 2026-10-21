// 收起的工作区、设备那一行上的汇总：里面有没有在等人的、在跑的、只剩后台任务在跑的、没看过的。
// 数是数据副本按组、按 harness 算好的（keys.tallies），这里只管合计和“该怎么说”。不碰页面，好单独测。
import type { GroupTallies, GroupTally } from '@litch/core'

export const NO_TALLY: GroupTally = {
  approval: 0,
  answer: 0,
  running: 0,
  unread: 0,
  background: 0,
}

/**
 * 一组的状况；group 给 null 是整台设备合起来的（设备那一行收起时用）。
 * only：侧栏正只看这几个 harness 的会话（空的是都看）。这时在跑的、未读的只算它们的（别的展开了也看不见）；
 * 等人的照样都算：停下来等人的会话不管属于谁，筛选时都留在树里
 */
export function tallyOf(
  tallies: GroupTallies | undefined,
  group: string | null,
  only: readonly string[] = [],
): GroupTally {
  if (!tallies) return NO_TALLY
  const sum = { ...NO_TALLY }
  const groups = group === null ? Object.values(tallies) : [tallies[group] ?? {}]
  for (const byHarness of groups) {
    for (const [harness, tally] of Object.entries(byHarness)) {
      sum.approval += tally.approval
      sum.answer += tally.answer
      if (only.length > 0 && !only.includes(harness)) continue
      sum.running += tally.running
      sum.unread += tally.unread
      sum.background += tally.background
    }
  }
  return sum
}

/** 里面什么事都没有：行上不出汇总 */
export const isQuiet = (tally: GroupTally): boolean =>
  tally.approval + tally.answer + tally.running + tally.unread + tally.background === 0

/**
 * 等人的那个小标写什么。只有一种就和会话行上的字一样（待审批、待回答），两种都有换一个说法；
 * 没有在等人的是 null
 */
export function waitLabel(
  tally: GroupTally,
): 'sidebar.waitApproval' | 'sidebar.waitAnswer' | 'sidebar.waitBoth' | null {
  if (tally.approval > 0 && tally.answer > 0) return 'sidebar.waitBoth'
  if (tally.approval > 0) return 'sidebar.waitApproval'
  return tally.answer > 0 ? 'sidebar.waitAnswer' : null
}

export type TallyPart = {
  key:
    | 'sidebar.tally.approval'
    | 'sidebar.tally.answer'
    | 'sidebar.tally.running'
    | 'sidebar.tally.background'
    | 'sidebar.tally.unread'
  count: number
}

/** 具体的数目，一样一句，要紧的在前。行上不写数，信息卡和读屏用这个 */
export function tallyParts(tally: GroupTally): TallyPart[] {
  const parts: TallyPart[] = [
    { key: 'sidebar.tally.approval', count: tally.approval },
    { key: 'sidebar.tally.answer', count: tally.answer },
    { key: 'sidebar.tally.running', count: tally.running },
    { key: 'sidebar.tally.background', count: tally.background },
    { key: 'sidebar.tally.unread', count: tally.unread },
  ]
  return parts.filter((part) => part.count > 0)
}
