// 内置浏览器在界面和主进程之间用的消息名（和 ../ipc.mts 并列，单独放，免得几条线同时改一个文件）。
// 只有界面自己的主框架发来的才认（install.mts 里查）；浏览器视图没有预加载脚本，发不出这些消息。

/** 界面 → 主进程：这个窗口里、这块矩形上显示哪个标签（{ tabId, rect }，都可以是 null） */
export const BROWSER_PLACE = 'litch:browser:place'
/** 界面 → 主进程，等应答：用户开一个新标签（{ owner, url }），回标签的样子 */
export const BROWSER_OPEN = 'litch:browser:open'
/** 界面 → 主进程：地址栏里打的字，或者 back、forward、reload、stop（{ tabId, to }） */
export const BROWSER_NAVIGATE = 'litch:browser:navigate'
/** 界面 → 主进程：关掉一个标签 */
export const BROWSER_CLOSE = 'litch:browser:close'
/** 界面 → 主进程：用系统的浏览器打开这个标签现在的地址 */
export const BROWSER_EXTERNAL = 'litch:browser:external'
/** 界面 → 主进程，等应答：现在所有标签的样子 */
export const BROWSER_TABS = 'litch:browser:tabs'
/** 主进程 → 界面：标签变了，带着所有标签的样子 */
export const BROWSER_STATE = 'litch:browser:state'
/** 主进程 → 界面：代理要给用户看一个标签（show 工具），带着那个标签的样子 */
export const BROWSER_SHOW = 'litch:browser:show'
/** 界面 → 主进程，等应答：“一直允许”的网站（设置页用） */
export const BROWSER_SITES = 'litch:browser:sites'
/** 界面 → 主进程，等应答：删掉一条“一直允许”（给 null 全删），回删了几条 */
export const BROWSER_FORGET_SITE = 'litch:browser:forget-site'
/** 界面 → 主进程，等应答：清除浏览数据（cookie、站点存储、缓存） */
export const BROWSER_CLEAR_DATA = 'litch:browser:clear-data'
