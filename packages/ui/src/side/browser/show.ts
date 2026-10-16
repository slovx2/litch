// 代理调 show 工具时外壳发来的通知：用户眼前就是那个会话时打开侧面板并换到浏览器标签；
// 不是的话记在那个会话名下，等用户切过去再打开（规矩在 store.ts 的 routeShow、setViewing）。
// 这个文件在启动时就装上（tabs.ts 引它），浏览器标签的组件本身要到第一次打开才装载。
import { showSideTab } from '../side.ts'
import { browserBridge } from './bridge.ts'
import { BROWSER_TAB, routeShow } from './store.ts'

browserBridge()?.onShow((tab) => {
  if (routeShow(tab)) showSideTab(BROWSER_TAB)
})
