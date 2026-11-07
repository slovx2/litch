import type { BoardPageMemory } from '../../../../../packages/core/src/manager-board-memory.mts'

/** 看板被导航栈隐藏时，原生/Web 容器的归零不是用户滚动。 */
export function rememberBoardScroll(
  state: { memory: BoardPageMemory | null; pending: boolean; y: number },
  y: number,
  visible: boolean,
) {
  if (!visible || state.pending) return
  state.y = y
  if (state.memory) state.memory.y = y
}
