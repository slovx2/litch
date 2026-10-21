// 侧面板“目标”页的标识和开合。这个文件不碰界面的服务（侧面板的标签登记表也要引它）
import { setSideOpen, showSideTab, sideNow } from '../side/side.ts'

export const GOAL_TAB = 'goal'

/** 输入框上方那一行点了：右侧“目标”页开着就收起，没开就打开 */
export function toggleGoalTab(): void {
  const side = sideNow()
  if (side.open && side.tab === GOAL_TAB) setSideOpen(false)
  else showSideTab(GOAL_TAB)
}
