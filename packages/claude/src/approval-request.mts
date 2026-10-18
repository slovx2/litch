// 工具调用的审批请求：发给客户端的参数，以及用户拒绝后交给模型的那句话。
// 命令走命令审批，MCP 工具照原生 codex 的做法走征询的形状，其余的走文件改动审批。
// “拒绝时附说明”是我们加的扩展（protocol/extensions/decline-with-note.json），
// 协议扩展的规矩是扩展内容只发给握手时声明过的连接，官方桌面端照常能用：同一条请求备两份参数，标准的一份和带扩展的一份。
import {
  DECLINE_WITH_NOTE_DECISION,
  type ListedApprovalDecision,
} from '../../protocol/src/harness-capabilities.mjs'
import type { McpToolRef } from './mcp-tool-name.mjs'
import type { PermissionDecision, RuntimeEvent, ThreadRecord } from './types.mjs'
import { nowMillis } from './util.mjs'

type PermissionRequest = Extract<RuntimeEvent, { type: 'permission_request' }>

export interface ApprovalRequest {
  method:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'mcpServer/elicitation/request'
  // 标准协议的参数。没声明扩展的连接（官方桌面端）收到的就是它，和加扩展之前逐字段相同。
  params: Record<string, unknown>
  // 声明了 declineWithNote 的连接收到的：决定列表里多一个 declineWithNote。
  paramsWithNote: Record<string, unknown>
}

export function approvalRequest(
  event: PermissionRequest,
  // cwd 是这次调用在哪个目录里跑，和条目上记的一样（命令审批的卡片上显示它）。
  ids: { threadId: string; turnId: string; itemId: string; requestId: string; cwd: string },
  // 这次调用的是哪个 MCP 服务的哪个工具；不是 MCP 工具时是 null。
  mcp: McpToolRef | null = null,
): ApprovalRequest {
  const { threadId, turnId, itemId, requestId, cwd } = ids
  if (mcp) {
    const params = mcpToolApprovalParams(event, threadId, turnId, mcp)
    // 征询的形状上没有“拒绝并附说明”这项扩展，两份参数一样。
    return { method: 'mcpServer/elicitation/request', params, paramsWithNote: params }
  }
  const command = String(event.input.command ?? '')
  const startedAtMs = nowMillis()
  // 带扩展的那份只列引擎真的区分对待的决定：“这个会话里都允许”是按命令原文记的，
  // 没有命令原文的调用（改文件等）选了它和“允许这一次”没有区别，下次照样会问，所以不列。
  const listed: ListedApprovalDecision[] = [
    'accept',
    ...(command ? (['acceptForSession'] as const) : []),
    'decline',
    DECLINE_WITH_NOTE_DECISION,
    'cancel',
  ]
  if (event.toolName === 'Bash') {
    const params = {
      threadId,
      turnId,
      itemId,
      startedAtMs,
      approvalId: requestId,
      reason: null,
      command,
      cwd,
      commandActions: [],
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }
    return {
      method: 'item/commandExecution/requestApproval',
      params,
      paramsWithNote: { ...params, availableDecisions: listed },
    }
  }
  // 标准协议里文件改动的审批不带决定列表；带扩展的那份加上这个字段。
  const params = { threadId, turnId, itemId, startedAtMs, reason: null, grantRoot: null }
  return {
    method: 'item/fileChange/requestApproval',
    params,
    paramsWithNote: { ...params, availableDecisions: listed },
  }
}

// “这个会话里都允许”记下的是什么：命令按原文记，MCP 工具按服务和工具记（不分参数，和原生 codex 一样）。
// 审批档位或沙箱换了，以前记下的就对不上了。没有可记的东西（改文件等）时是 null。
export function sessionGrantKey(
  thread: Pick<ThreadRecord, 'cwd' | 'approvalPolicy' | 'sandboxMode'> | null,
  event: PermissionRequest,
  mcp: McpToolRef | null,
): string | null {
  if (mcp)
    return JSON.stringify([
      'mcp',
      thread?.approvalPolicy,
      thread?.sandboxMode,
      mcp.server,
      mcp.tool,
    ])
  const command = String(event.input.command ?? '')
  return command
    ? JSON.stringify([thread?.cwd, thread?.approvalPolicy, thread?.sandboxMode, command])
    : null
}

// 工具调用被拒绝时写进工具结果、模型看得到的那句话。没写说明的拒绝和以前一样。
export function deniedMessage(decision: PermissionDecision): string {
  return decision.note
    ? `denied by user. The user left this note explaining why: ${decision.note}`
    : 'denied by user'
}

// MCP 工具调用的审批。原生 codex（0.157.1，core/src/mcp_tool_call.rs）问的是一条表单为空的征询，
// 靠 _meta 里的 codex_approval_kind: mcp_tool_call 认出来；这里发的是同一个形状：
// - persist 列出除了“只这一次”之外还能选哪些：只列 session（这个会话里这个工具都允许）。
//   上游还有 always（以后都允许，写进配置）；Claude Code 也能把规则写进它的设置文件，
//   但那改的是用户自己的 Claude Code 配置，这里不提供。
// - tool_params 是调用的参数，tool_params_display 是排好给人看的那一份（上游没有模板时也是按参数名排）。
// 应答：action 是 accept 时放行，_meta.persist 是 session 表示这个会话里都允许；decline 是拒绝这一次；
// cancel 是连回合一起停。
function mcpToolApprovalParams(
  event: PermissionRequest,
  threadId: string,
  turnId: string,
  mcp: McpToolRef,
): Record<string, unknown> {
  return {
    threadId,
    turnId,
    serverName: mcp.server,
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: 'session',
      tool_params: event.input,
      tool_params_display: Object.keys(event.input)
        .sort()
        .map((name) => ({ name, value: event.input[name], display_name: name })),
    },
    message: `允许 MCP 服务 ${mcp.server} 运行工具“${mcp.tool}”吗？`,
    requestedSchema: { type: 'object', properties: {} },
  }
}

// 客户端对 MCP 工具审批的应答 → 决定。认不出的应答一律算拒绝，不能把任意内容当成放行。
export function mcpToolApprovalDecision(response: unknown): PermissionDecision['decision'] {
  const answer =
    response !== null && typeof response === 'object' ? (response as Record<string, unknown>) : {}
  if (answer.action === 'cancel') return 'cancel'
  if (answer.action !== 'accept') return 'decline'
  const meta = answer._meta
  const persist =
    meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>).persist : null
  // 没提供的 always 不认：当成只这一次
  return persist === 'session' ? 'acceptForSession' : 'accept'
}
