// 会话树在核心和界面之间的形状。两种“子”分开说：
// - Litch 子会话（设备进程的 sessionTree 扩展）：完整的顶层会话，父子关系存在设备库里，侧栏里嵌在父会话下面。
//   会话摘要上的 lineage、对话里派出它的那张卡片（ToolCallItem.spawned）、父会话上的提案、注入给父会话的回报。
// - 引擎自己的子代理线程（标准协议的 parentThreadId、canAcceptDirectInput）：不进侧栏，
//   在父会话的对话里点子代理条目（ToolCallItem.agents）在侧面板里看，父会话的信息卡里列出来（session.agents）。
// 界面不认识协议类型，只认识这里的；协议那一份在 packages/protocol/src/session-tree.mts。
import type { HarnessId, SessionStatus, SessionSummary } from './model.mjs'

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

/** 沙箱的三档，越往后越宽 */
export type SandboxLevel = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * 提案的状态：pending 等用户点；started 用户开始了；dismissed 用户不要了；withdrawn 模型自己撤回了；
 * expired 到期没人点
 */
export type ProposalStatus =
  | 'pending'
  | 'offered'
  | 'chosen'
  | 'here'
  | 'started'
  | 'dismissed'
  | 'withdrawn'
  | 'expired'

/**
 * 模型提的“要不要另起一个子会话”（建议任务），用户点了才起。等着的和了结的都给界面：
 * 对话流里的卡片翻到老的也要写对状态，侧面板的“建议任务”列全部
 */
export interface SessionProposalView {
  id: string
  title: string
  /** 起子会话时发给它的第一段话 */
  prompt: string
  /** 子会话的 harness。null 是跟父会话一样 */
  harness: HarnessId | null
  model: string | null
  /** 子会话的目录。null 是跟父会话一样 */
  cwd: string | null
  kind: LineageKind
  wakeParent: boolean
  /** 投影那一刻的状态。pending 的到了 expiresAt 就算过期，界面用 proposalStatus 现算 */
  status: ProposalStatus
  /** 毫秒 */
  createdAt: number
  /** 到这个时间（毫秒）还没点就过期 */
  expiresAt: number
  /** 了结的时间（毫秒）；还等着是 null */
  settledAt: number | null
  /** 开始了：起出来的子会话。没开始、或者对面没说是 null */
  startedId: string | null
  /** 在父会话的哪个回合、哪次 litch_sessions.start 调用（条目的 id）里提的。旧提案没有是 null */
  turnId: string | null
  callId: string | null
  /** 目标 harness 收不到父会话那么严时，子会话实际会是的沙箱档；收得紧是 null。卡片上要写明 */
  widerSandbox: SandboxLevel | null
}

/** 这一刻提案算什么状态：等着的过了期就是过期了（设备进程到点也会发通知，界面不等它） */
export const proposalStatus = (proposal: SessionProposalView, now: number): ProposalStatus =>
  proposal.status === 'pending' && proposal.expiresAt <= now ? 'expired' : proposal.status

/** 提案卡片、侧面板那一行上写的 harness、模型、目录、方式 */
export interface ProposalShape {
  harness: HarnessId | null
  model: string | null
  cwd: string | null
  kind: LineageKind
  /** 写的是实际起出来的子会话（不是提案里的） */
  actual: boolean
}

/**
 * 卡片上写什么：开始了、子会话还在侧栏里的，写实际起出来的那个（“改了再开始”可能换了 harness、目录、方式；
 * 子会话的模型侧栏里没有，不写）；别的写提案里的，没给 harness 的是父会话的
 */
export function proposalShape(
  planned: Pick<SessionProposalView, 'harness' | 'model' | 'cwd' | 'kind'>,
  child: Pick<SessionSummary, 'harness' | 'cwd' | 'lineage'> | null | undefined,
  parentHarness: HarnessId | null,
): ProposalShape {
  if (child) {
    return {
      harness: child.harness,
      model: null,
      cwd: child.cwd || null,
      kind: child.lineage?.kind ?? planned.kind,
      actual: true,
    }
  }
  return {
    harness: planned.harness ?? parentHarness,
    model: planned.model,
    cwd: planned.cwd,
    kind: planned.kind,
    actual: false,
  }
}

/**
 * 用户从提案开始时改的东西（“改了再开始”）。不给的照提案里的；沙箱照样收紧到不宽于父会话。
 * 工作区是界面上的项目，核心按设备有没有项目换成对面的 projectId
 */
export interface ProposalOverrides {
  harness?: HarnessId
  model?: string
  effort?: string
  workspaceId?: string
  cwd?: string
  kind?: LineageKind
  title?: string
  prompt?: string
  sandbox?: SandboxLevel
  /** 子会话停下后要不要唤醒父会话。不给的照提案里的 */
  wakeParent?: boolean
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
 * notes：附在用户消息前面的回报；wake：子会话都停下了，设备进程替父会话开的回合；
 * remind：用户发起的回合结束时模型没调收尾（litch_sessions.wrap_up），设备进程替它再开的回合，notes 是空的
 */
export interface SessionEventView {
  kind: 'notes' | 'wake' | 'remind'
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

/**
 * 子代理在界面上的五种状态：排队、进行中、完成、失败、已停止。对话流里的那一行、子代理页的列表和标题、
 * 侧栏的信息卡都用这一个（取值的先后见 projection/tree.mts 的 agentRunState）
 */
export type AgentRunState = 'queued' | 'running' | 'completed' | 'failed' | 'stopped'

/** 协议的 CollabAgentStatus 归到五种里的哪一种 */
export const AGENT_RUN_STATE: Record<AgentState, AgentRunState> = {
  pendingInit: 'queued',
  running: 'running',
  completed: 'completed',
  errored: 'failed',
  notFound: 'failed',
  interrupted: 'stopped',
  shutdown: 'stopped',
}

/** 做完了的三种（完成、失败、已停止）：不会再变了，除非又给它派了活 */
export const agentSettled = (state: AgentRunState): boolean =>
  state === 'completed' || state === 'failed' || state === 'stopped'

/** 子代理线程自己最近的一个回合：在跑、完成、失败、被打断 */
export interface AgentTurnView {
  state: Exclude<AgentRunState, 'queued'>
  /** 开始的时间，毫秒。对面没给是 null */
  startedAt: number | null
  /** 用了多久，毫秒。还在跑、对面没给是 null（在跑的按 startedAt 走表） */
  durationMs: number | null
  /** 失败时对面给的原话。没失败、没给是 null */
  error: string | null
}

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
  /** 调用时给的第一段话（提案卡片在拿不到提案时照它画） */
  prompt: string
  /** 调用时给的 harness，没给是 null（跟父会话一样） */
  harness: HarnessId | null
  /** 调用时给的模型、目录，没给是 null */
  model: string | null
  cwd: string | null
  kind: LineageKind
}

/** 收尾（litch_sessions.wrap_up）里的一条建议：调用时给的样子，加上结果里它成了哪张提案或者为什么没收 */
export interface WrapUpSuggestionView {
  title: string
  prompt: string
  /** 没给是 null（跟父会话一样） */
  harness: HarnessId | null
  model: string | null
  cwd: string | null
  kind: LineageKind
  /** 成了哪张提案。被拒了、还没有结果是 null */
  proposalId: string | null
  /** 没收下的原因（结果里的 refused，对面写的原话）。收下了、还没有结果是 null */
  refused: string | null
}

/**
 * litch_sessions.wrap_up 的条目：模型每回合最后调一次，建议任务放在里面（没有就是空列表）。
 * 每条建议成一张提案，提案的 callId 都是这次调用的条目 id；空的那种界面不画（quietOf）
 */
export interface WrapUpView {
  /** 照调用时给的顺序 */
  suggestions: WrapUpSuggestionView[]
}

/** 引擎自己的一个子代理线程（thread/list 带 parentThreadId 列出来的，之后跟着通知变） */
export interface AgentThreadView {
  id: string
  /** 父会话 */
  parentId: string
  /** 引擎给的昵称（Claude 的是 agent-xxxxxxxxxxxx）、角色（Claude 的 subagent_type）。没有是 null */
  nickname: string | null
  role: string | null
  /**
   * 一句话描述：对面给子线程起的名字（Claude 入口放的是 Agent 工具的 description），没有的取任务说明的
   * 第一句，截到 40 字上下。都没有是空的
   */
  description: string
  /** 派给它的任务（会话对象上的第一句话；对面截过的就是截过的）。不知道是空的 */
  prompt: string
  status: SessionStatus
  /** 它最近的一个回合。还没有回合、对面没给是 null */
  turn: AgentTurnView | null
  /** 能不能在它里面直接输入。没载入的对面说不知道，是 null */
  canInput: boolean | null
  /** 毫秒 */
  updatedAt: number
}
