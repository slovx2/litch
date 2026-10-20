// 密码库用的消息名。两种发消息的：
// - 设置页（界面自己的主框架，经 window.litchBrowser.passwords）：列、删一条、全删，主进程改了推“变了”。
//   列表只有站点、用户名、来源、时间，从不带密码。
// - 标签里的自动填充预加载（preload.mts，用户的、代理的标签都有）：问候选、请主进程给候选（用户的标签弹原生菜单，
//   代理的标签回用户名让预加载画在网页里）、报网页里点中的那一条、报一次登录提交；主进程在点选后把这一条送进那个框架。
//   这几条只认登记过的标签发来的（autofill.mts 里查）。
// - 保存提示：主进程推给界面，界面答。提示里没有密码，只给界面，不给代理。

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
/**
 * 预加载 → 主进程，等应答：有人点了（或按了 ↓）登录框，给候选（{ rect }，框在这个框架里的位置）。
 * 用户的标签弹原生菜单、回 null；代理的标签回 { usernames } 由预加载画在网页里
 */
export const AUTOFILL_OFFER = 'litch:autofill:offer'
/** 预加载 → 主进程：网页里画的候选被点中了第几条（{ index }），只认代理标签里先前给过的那一份 */
export const AUTOFILL_PICK = 'litch:autofill:pick'
/** 主进程 → 发起的那个框架：点选了这一条（{ username, password }） */
export const AUTOFILL_FILL = 'litch:autofill:fill'
/** 预加载 → 主进程：登录表单提交了（{ username, password }），主进程据此出保存提示 */
export const AUTOFILL_CAPTURE = 'litch:autofill:capture'
