// 从别的浏览器导入在界面和主进程之间用的消息名（和 ../browser/ipc.mts 并列，单独放，免得几条线同时改一个文件）。
// 只有界面自己的主框架发来的才认（install.mts 里查）。

/** 界面 → 主进程，等应答：本机能导入的来源和资料 */
export const IMPORT_SOURCES = 'litch:browser:import:sources'
/** 界面 → 主进程，等应答：开始导入（ImportRequest），回 ImportOutcome（只有条数和状态） */
export const IMPORT_START = 'litch:browser:import:start'
/** 界面 → 主进程，等应答：取消正在进行的导入 */
export const IMPORT_CANCEL = 'litch:browser:import:cancel'
/** 主进程 → 界面：导入进度（ImportProgress） */
export const IMPORT_PROGRESS = 'litch:browser:import:progress'
/** 界面 → 主进程，等应答：导过没有、横幅关没关（ImportState） */
export const IMPORT_STATE = 'litch:browser:import:state'
/** 界面 → 主进程，等应答：关掉新用户横幅 */
export const IMPORT_DISMISS_BANNER = 'litch:browser:import:dismiss-banner'
