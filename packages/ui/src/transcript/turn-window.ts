// 首批和补画都限制规模：React 的渲染可以打断，DOM 提交和布局不能打断。
// 恢复较早的位置也要分批补到锚点，不能按离底部的距离扩大首批。

/** 先画最后几个回合 */
export const FIRST_TURNS = 4
/** 之后每次往前补这么多个 */
export const MORE_TURNS = 8
/** 长历史才跳过屏外回合的排版，短对话保持完整排版 */
export const WINDOWED_TURNS = 40

/** 恢复位置前至少画几个；首批仍只画 FIRST_TURNS，较远的锚点要分批补齐 */
export function restoreWindow(savedTurns: number | null): number {
  return Math.max(FIRST_TURNS, (savedTurns ?? 0) + 1)
}

/** 补一批之后画几个；已经全画了就不变 */
export function growWindow(shown: number, total: number): number {
  return shown >= total ? shown : Math.min(total, shown + MORE_TURNS)
}
