// 客户端工具在核心这一侧和外壳之间的约定（设计文档 05 第九节）。
// 核心收到 `item/tool/call` 之后经外壳交给主进程里登记的执行器去做，执行器要用户点头时经核心在对话里出一张卡片。
// 核心不认识 Electron：这里的形状和桌面外壳的 apps/desktop/src/client-tools/types.mts 是同一份，
// 由外壳（core-host.mts）把两边接起来，类型在那里对一遍。
import type {
  ClientToolCallParams,
  ClientToolCallResponse,
} from '../../protocol/src/client-tools.mjs'
import type { ClientAskView } from './model.mjs'
import type { MachineAction } from './model-machine.mjs'

/** 核心 ↔ 主进程的消息名 */
export const CLIENT_TOOL = 'clientTool'

/** 交给执行器的一次调用：协议原有的参数，加上桌面端知道的上下文 */
export interface ToolInvocation extends ClientToolCallParams {
  /** 核心给的标识，取消、答复都按它对 */
  id: string
  device: {
    id: string
    /** 给人看的名字 */
    name: string
    kind: 'local' | 'ssh'
    /** 远程设备的 ssh 目标：别名，或者 user@host（带端口时写成 ssh://user@host:端口）。本机是 null */
    target: string | null
  }
  /** 会话属于哪个 harness，只用来显示。不知道是 null */
  harness: string | null
  /** 会话的工作目录（设备上的路径），没有是 null */
  cwd: string | null
}

/** 卡片的答复。null：没答就被取消了 */
export type ToolAnswer = 'once' | 'session' | 'always' | 'decline'

/**
 * litch_machine 的调用找不到会话、卡片进了全局待处理时，请主进程发的系统通知（08 号设计 4.2）。
 * 核心不认识语言，只给结构，文字由主进程按界面的语言拼
 */
export interface MachineNotice {
  /** 全局待处理里那张卡片的标识 */
  pendingId: string
  /** 调用来自哪台设备：给人看的名字和主机 */
  deviceName: string
  host: string
  action: MachineAction
  /** 命令，或者路径，或者“从哪到哪”。主进程只拿来显示，会截短 */
  summary: string
}

/** 核心 → 主进程 */
export type ToolToMain =
  | { type: typeof CLIENT_TOOL; op: 'call'; invocation: ToolInvocation }
  | { type: typeof CLIENT_TOOL; op: 'cancel'; id: string }
  | { type: typeof CLIENT_TOOL; op: 'answer'; askId: string; answer: ToolAnswer | null }
  | {
      type: typeof CLIENT_TOOL
      op: 'turnEnded'
      deviceId: string
      threadId: string
      turnId: string
    }
  | { type: typeof CLIENT_TOOL; op: 'notify'; notice: MachineNotice }

/** 主进程 → 核心 */
export type ToolToCore =
  | { type: typeof CLIENT_TOOL; op: 'result'; id: string; response: ClientToolCallResponse }
  | { type: typeof CLIENT_TOOL; op: 'ask'; id: string; askId: string; ask: ClientAskView }
  | { type: typeof CLIENT_TOOL; op: 'askDone'; askId: string }
  | { type: typeof CLIENT_TOOL; op: 'namespaces'; namespaces: string[] }

/**
 * 外壳交给核心的那一头。核心只经它和主进程说话，不知道背后是工具进程的 parentPort 还是测试里的一个函数
 */
export interface ClientToolPort {
  /** 主进程报来的、这台桌面能执行的命名空间。还没报是空的：握手时就不声明 */
  namespaces(): readonly string[]
  post(message: ToolToMain): void
  /** 收主进程发来的。只调一次 */
  listen(handler: (message: ToolToCore) => void): void
}
