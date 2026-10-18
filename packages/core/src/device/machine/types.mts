// litch_machine 在核心里分两层：
// - 执行器（这个目录）：拿到一次调用和“能操作的机器”，真去起进程、读写文件、搬文件，管进程表、截断输出、
//   按访问范围挡禁止位置。它不知道设置存在哪、卡片怎么出，要用户点头时调 context.approve。
// - 接线（machine-wiring.mts，加上 tool-calls.mts、device.mts、core.mts 一带）：认调用（item/tool/call、litch/clientTool/call），
//   查开关，按审批方式决定 approve 弹不弹卡片、卡片放哪，把“能操作的机器”交给执行器，管设置、记录、主题 machine。
// 两边只经这里的接口说话，改这里要两边一起看。
import type { ClientToolCallResponse } from '../../../../protocol/src/client-tools.mjs'
import type { ClientRequestMethod, ClientRequests } from '../../../../protocol/src/index.mjs'
import type { AbortSignalLike } from '../../channel/protocol.mjs'
import type { RpcRequestOptions } from '../../connection/rpc.mjs'
import type { MachineAccessMode, MachineAskView } from '../../model-machine.mjs'

/** 一台能操作的机器的基本情况（machines 工具回的、说明里写的） */
export interface MachineFacts {
  /** 给人看的名字 */
  name: string
  hostname: string
  /** 比如 macOS 26.5 arm64、Linux x86_64 */
  system: string
  user: string
  home: string
  /** 登录 shell 的路径 */
  shell: string
}

/** 一台能操作的机器：背后是核心到那台设备的一条连接（第一期只有桌面端这台，背后是本机设备的连接） */
export interface MachineTarget {
  /** desktop，或者设备的标识（第二期） */
  id: string
  role: 'session' | 'desktop' | 'other'
  /** 现查（会缓存一会儿）。连接不在时抛错 */
  facts(): Promise<MachineFacts>
  /** 在这台机器的连接上发一个请求（process/*、fs/*） */
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /**
   * 收这条连接上的 process/outputDelta、process/exited。handler 认得（是执行器起的进程）就返回 true。
   * 返回退订
   */
  onProcessNotification(handler: (method: string, params: unknown) => boolean): () => void
}

/** 访问范围，接线那边从设置算好交过来 */
export interface MachinePolicy {
  mode: MachineAccessMode
  /** 生效的禁止位置：sensitive 是内置名单，custom 是用户的，open 是空的。可能以 ~ 开头，执行器自己展开 */
  denied: readonly string[]
}

/**
 * 要用户点头的一件事。class 决定按哪一类记“本会话都允许”：
 * mutate 是执行命令、写文件、复制到桌面端；read 是读文件、列目录、复制出桌面端
 */
export interface MachineApprovalRequest {
  class: 'mutate' | 'read'
  ask: MachineAskView
}

export type MachineApprovalResult =
  | { kind: 'allowed' }
  /** 用户拒绝了，note 是用户附的一句话 */
  | { kind: 'declined'; note: string | null }
  /** 10 分钟没人答 */
  | { kind: 'expired' }
  /** 调用被取消了（回合打断、连接断开、开关关掉） */
  | { kind: 'cancelled' }

/** 谁发起的：进程归它，会话所在设备断开、开关关掉时按它收拾 */
export interface MachineOwner {
  /** 会话所在的设备（核心里的设备标识） */
  deviceId: string
  /** 会话，不知道是 null */
  threadId: string | null
  harness: string | null
}

/** 执行器记一条操作记录要的（接线那边补上时间、存起来） */
export interface MachineLogNote {
  tool: string
  summary: string
  result: 'ok' | 'failed' | 'declined' | 'blocked' | 'expired'
  flagged: boolean
}

/** 一次调用给执行器的东西 */
export interface MachineCallContext {
  owner: MachineOwner
  /** 按标识找机器：desktop、session，或者第二期的设备标识。找不到（不认识、不在线）是 null */
  target(id: string): MachineTarget | null
  /** 这次调用能列出来的机器（machines 工具用） */
  targets(): MachineTarget[]
  /** 桌面端这台的访问范围。只管文件类工具；exec 里提到禁止位置的由执行器标进 ask.flagged */
  policy: MachinePolicy
  /** 审批方式和访问范围的名字，machines 工具里写给模型看 */
  settings: { approval: 'session' | 'each' | 'never'; access: MachineAccessMode }
  /** 要用户点头。按审批方式可能不弹卡片直接回 allowed；ask.flagged 非空时（命令里提到了禁止位置）除了“不确认”那档都会弹 */
  approve(request: MachineApprovalRequest): Promise<MachineApprovalResult>
  log(note: MachineLogNote): void
  /** 回合被打断、连接断开、超时时被中止 */
  signal: AbortSignalLike
}

/** 执行器记着的一个进程（接线那边拼成 MachineProcessView 给界面） */
export interface MachineProcessRecord {
  id: string
  owner: MachineOwner
  /** 在哪台机器上跑 */
  targetId: string
  command: string
  cwd: string
  startedAt: number
}

export interface MachineExecutor {
  /** 执行一次调用。不许抛错：出错也要回 success:false 的答复，第一行带 [litch:<kind>]，说明写给模型 */
  call(tool: string, args: unknown, context: MachineCallContext): Promise<ClientToolCallResponse>
  /** 还在跑的进程 */
  processes(): MachineProcessRecord[]
  /** 进程表变了（起了、结束了） */
  onProcessesChanged(listener: () => void): () => void
  /** 结束一个进程。不认识就返回 false */
  kill(processId: string): boolean
  /** 结束这台设备发起的全部进程（开关关掉、全部停）；不给就是全部 */
  stopAll(deviceId?: string): void
  /** 会话所在的设备断开了：10 分钟后还没回来就结束它发起的进程；online 为真表示回来了，取消计时 */
  ownerPresence(deviceId: string, online: boolean): void
  dispose(): void
}
