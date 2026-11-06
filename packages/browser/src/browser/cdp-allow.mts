// 内置浏览器发给网页的 CDP 命令只许用这几条（官方也是白名单的做法）。执行器、自检都经同一个出口发命令
// （electron-host.mts 的 cdp），名单外的直接拒绝、不发出去。加一个工具要用新的命令时在这里登记，
// 并在 test/browser-cdp.test.mts 里补一条。
//
// 特意不放的：Target.*（开新目标、接管别的页面）、Browser.*、Network.*（读 cookie）、Storage.*、
// Fetch.*（改请求）、Emulation 里改时区地区之类的、Input 里鼠标键盘和插入文字以外的（拖拽、触摸、合成手势）。

const ALLOWED: ReadonlySet<string> = new Set([
  // 页面：截图、视口大小、对话框、框架树（快照要逐个框架取）、生命周期事件
  'Page.enable',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.handleJavaScriptDialog',
  'Page.getFrameTree',
  // 跑脚本、在元素上调函数（清空输入框、选下拉项）、释放对象
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject',
  // 元素：按快照里的编号找位置、滚到看得见、聚焦、文件上传
  'DOM.enable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getContentQuads',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.focus',
  'DOM.setFileInputFiles',
  // 可访问性树
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  // 输入：只有鼠标、键盘、插入文字
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  // 页面不在前台时也能拿到焦点（面板关着时代理照样能打字）
  'Emulation.setFocusEmulationEnabled',
  // 代理点哪里：在网页上画一个框，不改网页的内容
  'Overlay.enable',
  'Overlay.highlightRect',
  'Overlay.hideHighlight',
])

/** 这条 CDP 命令能不能发 */
export function isAllowedCdp(method: string): boolean {
  return ALLOWED.has(method)
}

/** 名单外的命令被拒时抛的错 */
export class CdpRefused extends Error {
  readonly method: string
  constructor(method: string) {
    super(`CDP method is not allowed in the Litch browser: ${method}`)
    this.name = 'CdpRefused'
    this.method = method
  }
}
