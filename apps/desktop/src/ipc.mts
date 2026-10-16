// 主进程、预加载脚本、工具进程之间用到的消息名。只有这几条，不传业务数据。
// 例外是客户端工具（client-tools/types.mts 的 CLIENT_TOOL）：主进程 ↔ 工具进程之间传模型的一次工具调用的参数和结果，
// 消息的形状在那个文件里（设计文档 05 第九节）。

/** 界面 → 主进程：请给我一个连着核心的消息端口 */
export const REQUEST_CORE_PORT = 'litch:request-core-port'
/** 主进程 → 界面：端口来了（端口随消息一起转移） */
export const CORE_PORT = 'litch:core-port'
/** 主进程 → 工具进程：这是一个新窗口的端口，请在上面提供服务 */
export const ATTACH = 'attach'
/** 界面 → 主进程：请用系统的浏览器打开这个网址 */
export const OPEN_EXTERNAL = 'litch:open-external'
/** 界面 → 主进程：界面现在用的是这种语言（应用菜单跟着换） */
export const SET_LANGUAGE = 'litch:set-language'
/** 主进程 → 工具进程：界面现在用的是这种语言（核心让本机的适配器也用它说话） */
export const LANGUAGE = 'language'
/** 主进程 → 界面：应用菜单里点了要界面来办的一项，带着是哪一项（比如 terminal.toggle） */
export const MENU = 'litch:menu'
/**
 * 主进程 ↔ 工具进程：退出应用之前问一声还有多少终端活着（op 是 count），或者让核心把它们都结束（op 是 end）。
 * 一问一答，用 id 对上；不传终端里的任何内容
 */
export const TERMINALS = 'terminals'
/** 界面 → 主进程：现在的皮肤、明暗、缩放（缩放由主进程做，三样它都记着，下次冷启动用） */
export const SET_LOOK = 'litch:set-look'
/** 界面 → 主进程，等应答：应用的名字、版本，和应用里带着哪些许可文本 */
export const ABOUT = 'litch:about'
/** 界面 → 主进程，等应答：一份许可文本的全文，按 ABOUT 给的标识取 */
export const LICENSE_TEXT = 'litch:license-text'
/** 界面 → 主进程，等应答：弹系统的选文件夹对话框，回选中的那个目录（没选是 null）。只给本机的设备用 */
export const PICK_FOLDER = 'litch:pick-folder'
