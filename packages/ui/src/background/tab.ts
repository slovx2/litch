// 侧面板“后台任务”页的标识和开合。这个文件不碰界面的服务（侧面板的标签登记表也要引它）
import { setSideOpen, showSideTab, sideNow } from '../side/side.ts'

export const BACKGROUND_TAB = 'background'

/** 输入框上方那一行点了：右侧“后台任务”页开着就收起，没开就打开 */
export function toggleBackgroundTab(): void {
  const side = sideNow()
  if (side.open && side.tab === BACKGROUND_TAB) setSideOpen(false)
  else showSideTab(BACKGROUND_TAB)
}
