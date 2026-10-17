import {
  DECLINE_WITH_NOTE_DECISION,
  type ListedApprovalDecision,
} from '../../protocol/src/harness-capabilities.mjs'
import { declineNote } from '../../shared/src/harness-declaration.mjs'
import type { LiveThread, OpencodeServer } from './server.mjs'

// OpenCode 的权限请求（permission.asked）转成 Codex 的审批，回复交回 OpenCode（POST /permission/{id}/reply）。
//
// OpenCode 什么时候来问由它自己的权限设置定（默认几乎都不问：改文件、运行命令都直接做；访问项目外的目录、
// 同一个调用反复出现时才问），适配器不另加规则。请求的种类（permission）怎么对：
// - bash：命令审批（item/commandExecution/requestApproval），命令是 metadata.command；
// - edit（edit、write、apply_patch 三个工具共用）：文件改动审批（item/fileChange/requestApproval），
//   OpenCode 给的 diff 记到文件改动条目上；
// - 别的（external_directory、webfetch、task、读 .env、doom_loop、MCP 工具……）：都走命令审批，
//   命令那一栏写“种类: 匹配的范围”，原因里说清楚是哪种权限。
//
// 回复怎么对：accept → once；acceptForSession → always（OpenCode 记住这一类匹配的范围，在这个目录里直到
// serve 退出都不再问，比“这个会话”宽，声明里写明）；decline → reject 并附一句话，模型拿到这句话接着做；
// declineWithNote → reject 附用户写的说明；cancel → reject 不附话（OpenCode 因此停下这一轮，同会话别的挂起请求
// 一起被拒），再打断回合。没人答（没有连着的客户端、连接都断了、回合被停了）按 cancel 的样子拒。

export interface PermissionReply {
  reply: 'once' | 'always' | 'reject'
  message?: string
  // 要不要接着打断回合（用户选了取消）
  interrupt?: boolean
}

const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'] as const
const DECISIONS_WITH_NOTE: ListedApprovalDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
  DECLINE_WITH_NOTE_DECISION,
  'cancel',
]

// 交给模型的话，用英文（和 Pi、Claude 入口的说法一致）。
export const DECLINED_MESSAGE = 'denied by user'
const noted = (note: string) => `denied by user. The user left this note explaining why: ${note}`

const PERMISSION_TITLE: Record<string, string> = {
  external_directory: '访问项目目录以外的路径',
  webfetch: '抓取网页',
  websearch: '联网搜索',
  codesearch: '代码搜索',
  task: '启动子代理',
  read: '读取文件',
  glob: '按模式列文件',
  grep: '搜索文件内容',
  list: '列目录',
  skill: '加载技能',
  lsp: '调用语言服务',
  doom_loop: '同一个调用反复出现，是否继续',
  question: '向你提问',
  todowrite: '更新待办',
}

/** 这个请求发哪种审批、带什么参数（标准的一份和带“拒绝并附说明”的一份） */
export function approvalRequest(
  live: LiveThread,
  request: any,
  ids: { threadId: string; turnId: string },
): { method: string; params: any; paramsWithNote: any } {
  const { projection } = live
  const permission = String(request.permission ?? '')
  const patterns: string[] = Array.isArray(request.patterns) ? request.patterns.map(String) : []
  const meta = request.metadata ?? {}
  const item = projection.itemByCall(request.tool?.callID)
  const itemId = item?.id ?? String(request.id)
  const base = { ...ids, itemId, startedAtMs: Date.now() }
  if (permission === 'edit' && (!item || item.type === 'fileChange')) {
    const params = {
      ...base,
      reason: typeof meta.filepath === 'string' ? `修改 ${meta.filepath}` : null,
      grantRoot: null,
    }
    return {
      method: 'item/fileChange/requestApproval',
      params,
      paramsWithNote: { ...params, availableDecisions: DECISIONS_WITH_NOTE },
    }
  }
  const bash = permission === 'bash'
  const command = bash
    ? String(meta.command ?? item?.command ?? patterns.join(' '))
    : `${permission}: ${patterns.join(' ')}`
  const params = {
    ...base,
    approvalId: null,
    reason: bash
      ? null
      : `OpenCode 请求权限：${PERMISSION_TITLE[permission] ?? permission}（${patterns.join('、') || '全部'}）`,
    command,
    cwd: item?.type === 'commandExecution' ? item.cwd : projection.thread.cwd,
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

/** 客户端的应答换成交回 OpenCode 的回复。认不出的形状（带规则修改的同意等）一律按拒绝 */
export function replyOf(response: unknown): PermissionReply {
  const note = declineNote(response)
  if (note !== null) return { reply: 'reject', message: note ? noted(note) : DECLINED_MESSAGE }
  const decision =
    response && typeof response === 'object' ? (response as { decision?: unknown }).decision : null
  if (decision === 'accept') return { reply: 'once' }
  if (decision === 'acceptForSession') return { reply: 'always' }
  if (decision === 'cancel') return { reply: 'reject', interrupt: true }
  return { reply: 'reject', message: DECLINED_MESSAGE }
}

/** 问用户，返回交回 OpenCode 的回复 */
export async function approve(
  server: OpencodeServer,
  live: LiveThread,
  request: any,
  signal: AbortSignal,
): Promise<PermissionReply> {
  const { projection } = live
  const threadId = projection.thread.id
  const callID = typeof request.tool?.callID === 'string' ? request.tool.callID : null
  // 改文件的请求带着 OpenCode 算好的 diff：先记到条目上，审批卡片里看到的就是要改的内容
  if (callID && typeof request.metadata?.diff === 'string')
    projection.approvalDiff(callID, request.metadata.diff, (method, params) =>
      server.notify(threadId, method, params),
    )
  const ask = approvalRequest(live, request, {
    threadId,
    turnId: projection.active?.id ?? '',
  })
  let reply: PermissionReply
  try {
    const response = await projection.waiting(
      'approval',
      (method, params) => server.notify(threadId, method, params),
      () => server.callWithNote(threadId, ask.method, ask.params, ask.paramsWithNote, signal),
    )
    reply = replyOf(response)
  } catch {
    reply = { reply: 'reject' }
  }
  if (reply.reply === 'reject' && callID) projection.decline(callID)
  return reply
}
