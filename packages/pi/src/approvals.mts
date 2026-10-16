// Pi 的审批（设计文档 03 第八节 A5）：哪些工具调用要先问用户、问的时候发什么、答复怎么读。
// 钩子挂在 Pi 扩展接口的 tool_call 事件上（runtime.mts），工具执行之前触发；等答复和落到 Pi 上在 server.mts。
// 由设置打开，默认不问。发的是标准的审批请求，不是我们的扩展。
//
// 两条限制写在声明里（declaration.mts）：子代理的子会话不继承这个钩子，里面的操作不问；
// Pi 没有沙箱，问只是让用户在动手之前看一眼，不是安全边界。
import {
  DECLINE_WITH_NOTE_DECISION,
  type ListedApprovalDecision,
} from '../../protocol/src/harness-capabilities.mjs'
import { declineNote } from '../../shared/src/harness-declaration.mjs'

/** 打开审批的环境变量：设置 harness.pi.approvals 落到它上面，值是 1 才算开。运行时起来时读一次 */
export const APPROVALS_VARIABLE = 'CHA_PI_APPROVALS'

export function approvalsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[APPROVALS_VARIABLE] === '1'
}

/** 工具作者给的提示，含义和 MCP 的工具标注相同。没有核实过，只用来决定问不问 */
export interface ToolHints {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** 一次工具调用，钩子从 Pi 的事件和工具登记里整理出来 */
export interface ToolCallAsk {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /** Pi 登记的工具来源：内置工具是 `builtin:<名字>`，扩展的是文件路径。登记里查不到这个工具时是 null */
  source: string | null
  annotations: ToolHints | undefined
  /** 随适配器分发的插件（计划模式、子代理）注册的工具 */
  managed: boolean
  /** 这次运行的中止信号：中止时撤回还在等的审批 */
  signal: AbortSignal | undefined
}

/** 交给 Pi 的结果：工具不执行，reason 成为这次调用的结果，模型看得到 */
export interface ToolCallBlock {
  block: true
  reason: string
  terminate?: boolean
}

/**
 * 要问的三类：
 * - command：跑命令，发命令审批（带命令和工作目录）
 * - fileChange：写文件、改文件，发文件改动审批（差异在条目上）
 * - tool：其余要问的工具调用，也发文件改动审批，调用的内容在条目上（和 Claude 引擎的做法一样）
 */
export type ApprovalKind = 'command' | 'fileChange' | 'tool'

// Pi 内置的工具按来源认，不按名字：扩展可以注册同名的工具顶掉内置的，那种按下面的标注规则走。
// 表里没有的内置来源（MCP 工具的来源是 builtin:mcp，以后新加的内置工具）同样按标注规则走。
const BUILTIN: Record<string, ApprovalKind | null> = {
  'builtin:read': null,
  'builtin:grep': null,
  'builtin:find': null,
  'builtin:ls': null,
  'builtin:bash': 'command',
  'builtin:powershell': 'command',
  'builtin:edit': 'fileChange',
  'builtin:write': 'fileChange',
  // 只查工具目录、把查到的工具列给模型。
  'builtin:tool-search': null,
  // 脚本自己在沙箱里跑，碰不到文件、网络和进程；它调的每个工具各自经过这道钩子。
  'builtin:codemode': null,
}

// 随适配器分发的插件里不用问的：计划模式的两个工具本身就是在向用户提问、交计划等用户决定；
// 取子代理的结果只是读。启动子代理、给子代理追加指示要问：子代理里的操作不会再问。
const MANAGED_SAFE = new Set(['plan_mode_question', 'plan_mode_complete', 'get_subagent_result'])

/**
 * 没有专门规矩的工具（MCP 工具、用户自己装的扩展）按标注定，和 codex 判断 MCP 工具要不要问是同一个式子
 * （codex-rs/core/src/mcp_tool_call.rs 的 requires_mcp_tool_approval）：标了会破坏的要问；
 * 标了只读的不问；其余的只要可能破坏、或者可能碰到外面的世界就问。提示缺了按最坏的算，所以没有标注的一律问。
 */
function hintsRequireApproval(hints: ToolHints | undefined): boolean {
  if (hints?.destructiveHint === true) return true
  if (hints?.readOnlyHint === true) return false
  return (hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)
}

/** 这次调用要不要问、问哪一类。client：这是客户端注册、由客户端执行的工具，客户端自己把关，不问 */
export function approvalKind(ask: ToolCallAsk, client: boolean): ApprovalKind | null {
  if (client) return null
  if (ask.source !== null && Object.hasOwn(BUILTIN, ask.source)) return BUILTIN[ask.source] ?? null
  if (ask.managed && MANAGED_SAFE.has(ask.toolName)) return null
  if (ask.managed) return 'tool'
  return hintsRequireApproval(ask.annotations) ? 'tool' : null
}

/** “其余要问的工具调用”在审批请求上给用户看的说明：调的是哪个工具，子代理另外交代一句 */
export function toolReason(ask: ToolCallAsk): string {
  if (ask.managed && ask.toolName === 'subagent')
    return 'Pi 要启动一个子代理。子代理里的操作不会再来问你'
  if (ask.managed && ask.toolName === 'steer_subagent')
    return 'Pi 要给一个子代理追加指示。子代理里的操作不会再来问你'
  return `Pi 要调用工具 ${ask.toolName}`
}

/** 命令工具的命令原文 */
export function commandOf(ask: ToolCallAsk): string {
  return typeof ask.input.command === 'string' ? ask.input.command : ''
}

/**
 * “这个会话里以后都允许”记的是什么，和 codex 一样按同类记：命令是同一条命令原文加工作目录，
 * 文件是同一个文件（写和改不分），别的工具是同一个工具。path 是文件改动解析好的绝对路径。
 */
export function grantKey(kind: ApprovalKind, ask: ToolCallAsk, cwd: string, path: string): string {
  if (kind === 'command') return JSON.stringify(['command', ask.toolName, cwd, commandOf(ask)])
  if (kind === 'fileChange') return JSON.stringify(['file', path])
  return JSON.stringify(['tool', ask.toolName])
}

export interface ApprovalRequest {
  method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval'
  // 标准协议的参数：没声明扩展的连接（官方桌面端）收到的就是它。
  params: Record<string, unknown>
  // 声明了 declineWithNote 的连接收到的：决定列表里多一个“拒绝并附说明”。
  paramsWithNote: Record<string, unknown>
}

// 四种决定 Pi 都做得到：允许这一次、这个会话里同类的都允许、拒绝这一次、取消并打断回合。
const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'] as const
const DECISIONS_WITH_NOTE: ListedApprovalDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
  DECLINE_WITH_NOTE_DECISION,
  'cancel',
]

/** 拼一条审批请求。reason 是给用户看的补充说明，没有就是 null */
export function approvalRequest(
  kind: ApprovalKind,
  ids: { threadId: string; turnId: string; itemId: string },
  detail: { command: string; cwd: string; reason: string | null },
): ApprovalRequest {
  const base = { ...ids, startedAtMs: Date.now(), reason: detail.reason }
  if (kind === 'command') {
    const params = {
      ...base,
      kind: 'command',
      // 一次调用只问一遍，用不着另外的回调标识。
      approvalId: null,
      environmentId: null,
      command: detail.command,
      cwd: detail.cwd,
      commandActions: [],
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: [...DECISIONS],
    }
    return {
      method: 'item/commandExecution/requestApproval',
      params,
      paramsWithNote: { ...params, availableDecisions: DECISIONS_WITH_NOTE },
    }
  }
  // 标准协议里文件改动的审批不带决定列表，按钮是固定的那四个，Pi 都做得到；带扩展的那份才带列表。
  const params = { ...base, grantRoot: null }
  return {
    method: 'item/fileChange/requestApproval',
    params,
    paramsWithNote: { ...params, availableDecisions: DECISIONS_WITH_NOTE },
  }
}

export interface ApprovalDecision {
  decision: (typeof DECISIONS)[number]
  /** 拒绝时用户写的说明 */
  note?: string
}

/** 读客户端的应答。只认列出去的那几种决定，别的（带规则修改的同意、认不出的形状）一律当拒绝 */
export function decisionOf(response: unknown): ApprovalDecision {
  const note = declineNote(response)
  if (note !== null) return note ? { decision: 'decline', note } : { decision: 'decline' }
  const decision =
    response && typeof response === 'object' ? (response as { decision?: unknown }).decision : null
  const listed = DECISIONS.find((known) => known === decision)
  return { decision: listed ?? 'decline' }
}

// 下面几句写进工具结果，是给模型看的，所以用英文；前两句和 Claude 引擎的原话一样。

/** 用户拒绝了这次调用 */
export function deniedMessage(note?: string): string {
  return note ? `denied by user. The user left this note explaining why: ${note}` : 'denied by user'
}

/** 用户取消了：这次调用不执行，回合随即被打断 */
export const CANCELLED_MESSAGE = 'denied by user; the user stopped the turn'

/** 没等到答复（没有客户端连着、连接都断了、回合被停了）：不执行 */
export function unansweredMessage(cause: string): string {
  return `not run: the approval request got no answer (${cause})`
}
