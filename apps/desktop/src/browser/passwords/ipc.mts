// 密码库用的消息名。两种发消息的：
// - 设置页（界面自己的主框架，经 window.litchBrowser.passwords）：列、删一条、全删，主进程改了推“变了”。
//   列表只有站点、用户名、来源、时间，从不带密码。
// - 标签里的自动填充预加载（preload.mts，用户的、代理的标签都有）：问候选、请主进程给候选（只有人手里的标签
//   弹原生菜单）、报一次登录提交；主进程在点选后把这一条送进那个框架。交还代理之前主进程请它清空密码框。
//   这几条只认登记过的标签发来的（autofill.mts、handover.mts 里查）。
// - 保存提示：主进程推给界面，界面答。提示里没有密码，只给界面，不给代理。
// - 交给人登录（request_sign_in）：主进程推给界面“代理请你登录”的卡片，界面答交还或取消。

/** 界面 → 主进程，等应答：已保存的密码列表（SavedPassword[]，没有密码） */
export const PASSWORDS_LIST = 'litch:browser:passwords:list'
/** 界面 → 主进程，等应答：删一条（给编号），回删没删到 */
export const PASSWORDS_REMOVE = 'litch:browser:passwords:remove'
/** 界面 → 主进程，等应答：全删，回删了几条 */
export const PASSWORDS_REMOVE_ALL = 'litch:browser:passwords:remove-all'
/** 主进程 → 界面：密码库变了（导入了、删了），界面再取一次列表 */
export const PASSWORDS_CHANGED = 'litch:browser:passwords:changed'

/** 界面 → 主进程，等应答：“这个网站永不保存”的名单（NeverSite[]） */
export const PASSWORDS_NEVER = 'litch:browser:passwords:never'
/** 界面 → 主进程，等应答：从“永不保存”的名单里去掉一个网站，回去没去掉 */
export const PASSWORDS_ALLOW_SITE = 'litch:browser:passwords:allow-site'
/** 界面 → 主进程，等应答：现在挂着的保存提示（SavePrompt[]，没有密码） */
export const PASSWORDS_PROMPTS = 'litch:browser:passwords:prompts'
/** 界面 → 主进程，等应答：答一条保存提示（{ id, answer: save | dismiss | never }） */
export const PASSWORDS_ANSWER = 'litch:browser:passwords:answer'
/** 主进程 → 界面：保存提示变了，带着现在所有的 */
export const PASSWORDS_PROMPTS_CHANGED = 'litch:browser:passwords:prompts-changed'

/** 预加载 → 主进程，等应答：这个框架有没有候选，回 { usernames }（只有用户名） */
export const AUTOFILL_QUERY = 'litch:autofill:query'
/** 预加载 → 主进程，等应答：有人点了（或按了 ↓）登录框（{ rect }，框在这个框架里的位置）。人手里的标签弹原生菜单；回 null */
export const AUTOFILL_OFFER = 'litch:autofill:offer'
/** 主进程 → 发起的那个框架：点选了这一条（{ username, password }） */
export const AUTOFILL_FILL = 'litch:autofill:fill'
/** 预加载 → 主进程：登录表单提交了（{ username, password }），主进程据此出保存提示 */
export const AUTOFILL_CAPTURE = 'litch:autofill:capture'
/** 主进程 → 标签的每个框架：交还代理之前清空密码框（{ token }） */
export const AUTOFILL_CLEAR = 'litch:autofill:clear'
/** 预加载 → 主进程：清完了（{ token }） */
export const AUTOFILL_CLEARED = 'litch:autofill:cleared'

/** 界面 → 主进程，等应答：现在挂着的“代理请你登录”（SignInRequest[]） */
export const SIGNIN_LIST = 'litch:browser:signin:list'
/** 界面 → 主进程，等应答：答一条（{ id, answer: done | cancel }），回答没答到 */
export const SIGNIN_ANSWER = 'litch:browser:signin:answer'
/** 主进程 → 界面：“代理请你登录”变了，带着现在所有的 */
export const SIGNIN_CHANGED = 'litch:browser:signin:changed'
