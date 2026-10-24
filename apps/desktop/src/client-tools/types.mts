// 客户端工具在桌面端这一侧的约定：核心（工具进程）收到 `item/tool/call` 之后经主进程的消息交给这里登记的
// 执行器；执行器要用户点头时经核心在对话里出一张卡片。
//
// 这是“主进程不在数据路径上”的一处例外：浏览器视图和 Computer Use 助手都只能由主进程管。
// 传的只有这一次调用的参数和结果，不传会话内容。

import type { ConfigMainRequest, ConfigMainResult } from '@litch/core'
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
  /**
   * 这一回合是哪个定时任务跑的（核心按 deviceTasks 的运行记录对 threadId、turnId）；不是是 null，
   * 老的核心不给。内置浏览器的登录卡片按它出“以后直接用这个账号”的勾选、设过期
   */
  task?: { id: string; name: string } | null
}

/** 登录卡片上的一个账号（和 browser/passwords/signin.mts 的 SignInAccount 同形） */
export interface ClientToolSignInAccount {
  /** 这张卡片里随机的不透明编号，答复按它指 */
  ref: string
  /** 完整用户名：桌面端显示；给手机的那份核心只给 masked */
  username: string
  masked: string
  /** 毫秒，没填过是 null */
  lastUsed: number | null
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
  | {
      /**
       * 内置浏览器请人登录（request_sign_in）：对话里和浏览器面板上同一张卡片（字段同 SignInRequest）。
       * 只在等人选的时候挂着；答复经浏览器桥 signIn.answer(id, …) 交给主进程（面板那张同一条路），
       * 主进程的 SignIns 是准，任何一处答了两处一起收。核心那条答复路回来的 decline 当拒绝
       */
      kind: 'signIn'
      /** 登录卡片的编号（SignInRequest.id） */
      id: string
      /** 主进程取到的真实来源 */
      origin: string
      /** 代理说的站名、原因，只作附注 */
      site: string
      reason: string
      accounts: ClientToolSignInAccount[]
      /** 预检不过的原因（SignInBlock），null 是能代填 */
      fillBlocked: string | null
      /** 定时任务的回合才有 */
      taskId: string | null
      /** 定时任务的回合：任务的号和名字（卡片上显示“定时任务 X 要登录”） */
      task?: { id: string; name: string } | null
      /** 毫秒，只有定时任务的回合有 */
      expiresAt: number | null
      /** 桌面端出的随机数：转给手机，手机的答复要签上它 */
      nonce: string
      /** 这台桌面端的号：有它核心才把卡片经会话所在设备转给手机；没有（验签没装好）不转 */
      desktopId?: string | null
    }

/** 卡片的答复。session：本会话都允许；always：一直允许（记下来）；decline：拒绝；null：没答就被取消了 */
export type ClientToolAnswer = 'once' | 'session' | 'always' | 'decline'

/** 执行器能用的东西 */
export interface ClientToolContext {
  /** 回合被打断、连接断了、超时时会被中止 */
  signal: AbortSignal
  /** 在这个会话的对话里出一张卡片等用户答复；被取消时回 null */
  ask(ask: ClientToolAsk): Promise<ClientToolAnswer | null>
  /**
   * 在别处等人（不出对话里的卡片，比如内置浏览器把标签交给人登录）：核心停表，等人的这段不算超时。
   * 回“不等了”的函数，表从头算；调用结束时自动不等
   */
  hold?(): () => void
  /**
   * 在对话里挂一张卡片但不等它（答复走别的路，比如登录卡片经浏览器桥）。回“撤掉”的函数；
   * 核心那条路回来的答复交给 onAnswer。调用结束时自动撤掉
   */
  show?(ask: ClientToolAsk, onAnswer?: (answer: ClientToolAnswer | null) => void): () => void
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
  /** 核心转来的一条手机答复（clientApprovals 的 litch/approval/answered，原样），由执行器自己验 */
  phoneAnswer?(answer: unknown): void
}

/**
 * litch_machine 的调用找不到会话、卡片进了全局待处理时，核心请主进程发的系统通知。
 * 核心只给结构，文字由这边按界面的语言拼（client-tools/notice.mts）
 */
export interface MachineNotice {
  pendingId: string
  /** 调用来自哪台设备 */
  deviceName: string
  host: string
  action: 'exec' | 'write' | 'read' | 'list' | 'copy' | 'process'
  /** 命令，或者路径，或者“从哪到哪” */
  summary: string
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
  | { type: typeof CLIENT_TOOL; op: 'notify'; notice: MachineNotice }
  /** 手机经会话所在设备答了一张审批卡（litch/approval/answered 的内容原样），主进程验过签名才认 */
  | { type: typeof CLIENT_TOOL; op: 'phoneAnswer'; answer: unknown }
  /** litch config 里属于主进程的一项（内置浏览器的网站、Computer Use），做完回 configResult（config-main.mts） */
  | { type: typeof CLIENT_TOOL; op: 'config'; id: string; request: ConfigMainRequest }

/** 主进程 → 核心 */
export type ClientToolToCore =
  | { type: typeof CLIENT_TOOL; op: 'result'; id: string; response: ClientToolCallResponse }
  | { type: typeof CLIENT_TOOL; op: 'ask'; id: string; askId: string; ask: ClientToolAsk }
  | { type: typeof CLIENT_TOOL; op: 'askDone'; askId: string }
  /** 执行器在别处等人：held 为真时核心停表，为假时表从头算（ClientToolContext.hold） */
  | { type: typeof CLIENT_TOOL; op: 'hold'; id: string; held: boolean }
  /** 主进程启动时告诉核心：这台桌面能执行哪些命名空间（握手时照这个声明） */
  | { type: typeof CLIENT_TOOL; op: 'namespaces'; namespaces: string[] }
  | { type: typeof CLIENT_TOOL; op: 'configResult'; id: string; result: ConfigMainResult }
