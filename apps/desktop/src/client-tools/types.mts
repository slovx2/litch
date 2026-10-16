// 客户端工具在桌面端这一侧的约定：核心（工具进程）收到 `item/tool/call` 之后经主进程的消息交给这里登记的
// 执行器；执行器要用户点头时经核心在对话里出一张卡片。设计见 design/harness-client/05-browser-and-computer-use.md。
//
// 这是“主进程不在数据路径上”的一处例外：浏览器视图和 Computer Use 助手都只能由主进程管。
// 传的只有这一次调用的参数和结果，不传会话内容。

import type {
  ClientToolCallParams,
  ClientToolCallResponse,
} from '../../../../packages/protocol/src/client-tools.mjs'

/** 核心 ↔ 主进程的消息名（和 ipc.mts 里的并列） */
export const CLIENT_TOOL = 'clientTool'

/** 调用来自哪台设备 */
export interface ClientToolDevice {
  /** 桌面端给设备的标识（本机是 local） */
  id: string
  /** 给人看的名字 */
  name: string
  /** 本机还是经 ssh 连的远程设备 */
  kind: 'local' | 'ssh'
  /** 远程设备的 ssh 目标（别名或 user@host），本机是 null。远端 localhost 转发要用 */
  target: string | null
}

/** 交给执行器的一次调用：协议原有的参数，加上桌面端知道的上下文 */
export interface ClientToolInvocation extends ClientToolCallParams {
  /** 核心给的标识，取消、答复都按它对 */
  id: string
  device: ClientToolDevice
  /** 会话属于哪个 harness（claude-code、pi、codex……），只用来显示 */
  harness: string | null
  /** 会话的工作目录（设备上的路径），没有是 null */
  cwd: string | null
}

/** 执行器请用户点头时出的卡片。文字由界面按语言拼，这里只给结构 */
export type ClientToolAsk =
  | {
      kind: 'site'
      /** 要访问的网站来源，比如 https://example.com */
      origin: string
      url: string
    }
  | {
      kind: 'app'
      app: { name: string; bundleId: string }
      /** elevated：浏览器、终端这类高风险应用，卡片上标出来 */
      risk: 'normal' | 'elevated'
      /** 能不能选“始终允许”（远程设备的会话不能） */
      allowAlways: boolean
    }

/** 卡片的答复。session：本会话都允许；always：一直允许（记下来）；decline：拒绝；null：没答就被取消了 */
export type ClientToolAnswer = 'once' | 'session' | 'always' | 'decline'

/** 执行器能用的东西 */
export interface ClientToolContext {
  /** 回合被打断、连接断了、超时时会被中止 */
  signal: AbortSignal
  /** 在这个会话的对话里出一张卡片等用户答复；被取消时回 null */
  ask(ask: ClientToolAsk): Promise<ClientToolAnswer | null>
}

/** 一个命名空间的执行器，由主进程登记 */
export interface ClientToolExecutor {
  /** 命名空间，比如 litch_browser */
  namespace: string
  /** 执行一次调用。不许抛错：出错也要回一个 success:false 的答复，说明写给模型看 */
  call(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
  ): Promise<ClientToolCallResponse>
  /** 回合结束（完成、打断、出错都算）时调用：收拾这个回合留下的临时东西 */
  turnEnded?(turn: { deviceId: string; threadId: string; turnId: string }): void
}

/** 核心 → 主进程 */
export type ClientToolToMain =
  | { type: typeof CLIENT_TOOL; op: 'call'; invocation: ClientToolInvocation }
  | { type: typeof CLIENT_TOOL; op: 'cancel'; id: string }
  | { type: typeof CLIENT_TOOL; op: 'answer'; askId: string; answer: ClientToolAnswer | null }
  | {
      type: typeof CLIENT_TOOL
      op: 'turnEnded'
      deviceId: string
      threadId: string
      turnId: string
    }

/** 主进程 → 核心 */
export type ClientToolToCore =
  | { type: typeof CLIENT_TOOL; op: 'result'; id: string; response: ClientToolCallResponse }
  | { type: typeof CLIENT_TOOL; op: 'ask'; id: string; askId: string; ask: ClientToolAsk }
  | { type: typeof CLIENT_TOOL; op: 'askDone'; askId: string }
  /** 主进程启动时告诉核心：这台桌面能执行哪些命名空间（握手时照这个声明） */
  | { type: typeof CLIENT_TOOL; op: 'namespaces'; namespaces: string[] }
