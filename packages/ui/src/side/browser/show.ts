// 代理调 show 工具时外壳发来的通知：记下要看哪个标签，打开侧面板并换到浏览器标签。
// 这个文件在启动时就装上（tabs.ts 引它），浏览器标签的组件本身要到第一次打开才装载。
import { showSideTab } from '../side.ts'
import { browserBridge } from './bridge.ts'
import { BROWSER_TAB, wantBrowserTab } from './store.ts'

browserBridge()?.onShow((tab) => {
  wantBrowserTab(tab)
  showSideTab(BROWSER_TAB)
})
