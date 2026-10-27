// 对话区一次画多少个回合。整份历史一次画完，历史长的会话（远程会话离开一阵、攒了很多回合）点开那一下界面要卡住
// 一两秒以上（2026-10-27 复现：模拟核心 300 个回合，切过去一次长任务 1 秒）。所以先画最后几个回合，
// 之后每次让出主线程、再往前补一批，直到画全；补的是视口上面看不见的部分，滚动容器底部对齐，正在看的地方不动。
// 离开时停在上面的某一处，回来要能找到那一行：先画的这一截至少要包住它所在的回合。

/**
 * 先画最后这么多个回合：这一次是同步渲染，要短（一屏一般就是几个回合）。之后的补画走 transition，
 * React 会切成小片、中间让出主线程，一批多一点也不会卡（同一个会话实测：先画 20 个时头一次长任务 195 毫秒，
 * 先画 1 个时 55、69 毫秒，补画那几批都没有长任务；开发构建）
 */
export const FIRST_TURNS = 8
/** 之后每次往前补这么多个 */
export const MORE_TURNS = 40

/** 先画几个：savedTurns 是上次离开时停的那一行所在的回合数到最后一共几个（贴底离开、没记过是 null） */
export function firstWindow(savedTurns: number | null): number {
  return Math.max(FIRST_TURNS, (savedTurns ?? 0) + 1)
}

/** 补一批之后画几个；已经全画了就不变 */
export function growWindow(shown: number, total: number): number {
  return shown >= total ? shown : Math.min(total, shown + MORE_TURNS)
}
