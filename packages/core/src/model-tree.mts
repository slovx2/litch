// 会话树在核心和界面之间的形状。两种“子”分开说：
// - Litch 子会话（设备进程的 sessionTree 扩展）：完整的顶层会话，父子关系存在设备库里，侧栏里嵌在父会话下面。
//   会话摘要上的 lineage、对话里派出它的那张卡片（ToolCallItem.spawned）、父会话上的提案、注入给父会话的回报。
// - 引擎自己的子代理线程（标准协议的 parentThreadId、canAcceptDirectInput）：不进侧栏，
//   在父会话的对话里点子代理条目（ToolCallItem.agents）在侧面板里看，父会话的信息卡里列出来（session.agents）。
// 界面不认识协议类型，只认识这里的；协议那一份在 packages/protocol/src/session-tree.mts。
import type { HarnessId, SessionStatus } from './model.mjs'

/** 子会话怎么来的：fresh 只给了简报；fork 带着父会话的全部上下文（只能同 harness） */
export type LineageKind = 'fresh' | 'fork'

/** 谁起的：model 模型直接起的；proposal 模型提的、用户点了开始；user 用户在界面上派的 */
export type LineageOrigin = 'model' | 'proposal' | 'user'

/** 一个 Litch 子会话的来历。只在有父会话的会话上有；脱离之后就没了 */
export interface SessionLineageView {
  /** 父会话（同一台设备，可以是别的 harness） */
  parentId: string
  kind: LineageKind
  origin: LineageOrigin
  /** 派的时候给的一行标题 */
  title: string
  /** 这个子会话停下之后要不要唤醒父会话 */
  wakeParent: boolean
  /** 建立父子关系的时间，毫秒 */
  createdAt: number
  /** 从哪个提案开始的（用户点了提案卡片上的“开始”）。不是从提案来的是 null */
  proposalId: string | null
}

/** 模型提的“要不要另起一个子会话”，用户点了才起。只有等着的才给界面 */
export interface SessionProposalView {
  id: string
  title: string
  /** 起子会话时发给它的第一段话 */
  prompt: string
  /** 子会话的 harness。null 是跟父会话一样 */
  harness: HarnessId | null
  model: string | null
  kind: LineageKind
  wakeParent: boolean
  /** 毫秒 */
  createdAt: number
  /** 到这个时间（毫秒）还没点就过期，界面按它收掉 */
  expiresAt: number
  /** 目标 harness 收不到父会话那么严时，子会话实际会是的沙箱档；收得紧是 null。卡片上要写明 */
  widerSandbox: 'read-only' | 'workspace-write' | 'danger-full-access' | null
}

/** 注入给父会话的一条回报：哪个子会话、这一回合怎么结束的、最后一条回答的开头 */
export interface SessionNoteView {
  threadId: string
  title: string
  status: 'completed' | 'failed' | 'interrupted' | 'needsUser'
  excerpt: string
}

/**
 * 设备进程注入给父会话的文字（包在 <litch-session-event> 里）认出来之后的样子。
 * notes：附在用户消息前面的回报；wake：子会话都停下了，设备进程替父会话开的回合
 */
export interface SessionEventView {
  kind: 'notes' | 'wake'
  notes: SessionNoteView[]
}

/** 一个子代理在子代理调用里的状态（协议的 CollabAgentStatus 原样；不认识的是 null） */
export type AgentState =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound'

/** 子代理调用（collabAgentToolCall）涉及的一个子线程 */
export interface AgentRefView {
  threadId: string
  /** 这一次调用时它的状态和对面给的一句话。条目里没报的是 null */
  state: AgentState | null
  message: string | null
}

/** litch_sessions.start 的结果：直接起了的子会话，或者降成了提案 */
export interface SpawnedView {
  /** 起出来的子会话。降成了提案、还没有结果的是 null */
  threadId: string | null
  /** 降成了提案时的提案号 */
  proposalId: string | null
  /** 调用时给的标题 */
  title: string
  /** 调用时给的 harness，没给是 null（跟父会话一样） */
  harness: HarnessId | null
}

/** 引擎自己的一个子代理线程（thread/list 带 parentThreadId 列出来的） */
export interface AgentThreadView {
  id: string
  /** 引擎给的昵称、角色。没有是 null */
  nickname: string | null
  role: string | null
  /** 第一句话或名字 */
  title: string
  status: SessionStatus
  /** 能不能在它里面直接输入。没载入的对面说不知道，是 null */
  canInput: boolean | null
  /** 毫秒 */
  updatedAt: number
}
