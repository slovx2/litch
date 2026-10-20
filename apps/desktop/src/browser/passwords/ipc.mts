// 密码库用的消息名。两种发消息的：
// - 设置页（界面自己的主框架，经 window.litchBrowser.passwords）：列、删一条、全删，主进程改了推“变了”。
//   列表只有站点、用户名、来源、时间，从不带密码。
// - 用户标签里的自动填充预加载（preload.mts）：问候选、请主进程弹候选菜单；主进程在用户点选后把这一条送进那个框架。
//   这几条只认用户标签发来的（autofill.mts 里查），代理的标签没有这个预加载。

/** 界面 → 主进程，等应答：已保存的密码列表（SavedPassword[]，没有密码） */
export const PASSWORDS_LIST = 'litch:browser:passwords:list'
/** 界面 → 主进程，等应答：删一条（给编号），回删没删到 */
export const PASSWORDS_REMOVE = 'litch:browser:passwords:remove'
/** 界面 → 主进程，等应答：全删，回删了几条 */
export const PASSWORDS_REMOVE_ALL = 'litch:browser:passwords:remove-all'
/** 主进程 → 界面：密码库变了（导入了、删了），界面再取一次列表 */
export const PASSWORDS_CHANGED = 'litch:browser:passwords:changed'

/** 用户标签的预加载 → 主进程，等应答：这个框架有没有候选，回 { usernames }（只有用户名） */
export const AUTOFILL_QUERY = 'litch:autofill:query'
/** 用户标签的预加载 → 主进程：用户点了（或按了 ↓）登录框，弹候选菜单（{ rect }，框在这个框架里的位置） */
export const AUTOFILL_OFFER = 'litch:autofill:offer'
/** 主进程 → 用户标签里发起的那个框架：用户点选了这一条（{ username, password }） */
export const AUTOFILL_FILL = 'litch:autofill:fill'
