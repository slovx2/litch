import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { isApprovalPolicy } from './approval-policy.mjs'
import { parseSandboxPolicy, type RuntimeSandboxPolicy } from './sandbox-policy.mjs'

export {
  historyHeadCursors,
  ProtocolError,
  pageRecords,
  pageThreadItems,
  requiredString,
  submissionHash,
  ThreadNotFound,
} from '../../shared/src/protocol-contract.mjs'

export interface ThreadRuntimeSettings {
  sandboxPolicy?: RuntimeSandboxPolicy
  planMode?: boolean
  historyMode?: 'legacy' | 'paginated'
  dynamicTools?: unknown[]
  config?: Record<string, unknown>
  gitInfo?: { sha: string | null; branch: string | null; originUrl: string | null } | null
  // 子代理线程：CLI 给这个子代理的 ID，追问时按它寻址。
  claudeAgentId?: string
  // 分叉出来的会话：上一次放在用户消息前面交给模型的那份开发者指令，和带着它的回合
  // （server.mts 的 instructionsInjected）。上下文压缩过就去掉
  injectedInstructions?: { text: string; turnId: string }
}

// Codex（OpenAI）那边的模型名。Claude 入口不接这种模型：普通请求带着它就拒绝（rejectForeignModel），
// 客户端拿来做杂事的请求（允许回退的新建、临时分叉）换成本入口的模型。
export function isForeignModel(model: unknown): boolean {
  return typeof model === 'string' && /^(gpt-|codex|o[134](?:-|$))/.test(model)
}

export function rejectForeignModel(model: unknown): void {
  if (isForeignModel(model))
    throw new ProtocolError(-32602, 'Claude 入口不支持 Codex 模型或跨引擎会话')
}

export function validateRuntimePermissions(params: Record<string, unknown>): void {
  if (params.permissions != null && (params.sandbox != null || params.sandboxPolicy != null))
    throw new ProtocolError(-32602, '权限档位不能与沙箱策略同时设置')
  if (params.sandbox != null && params.sandboxPolicy != null)
    throw new ProtocolError(-32602, 'sandbox 与 sandboxPolicy 不能同时设置')
  if (params.approvalPolicy != null && !isApprovalPolicy(params.approvalPolicy))
    throw new ProtocolError(-32602, '未知审批策略')
  const mode = (params.collaborationMode as { mode?: unknown } | undefined)?.mode
  if (mode != null && mode !== 'plan' && mode !== 'default')
    throw new ProtocolError(-32602, '未知协作模式')
  if (
    params.permissions != null &&
    (typeof params.permissions !== 'string' ||
      ![':read-only', ':workspace', ':danger-full-access'].includes(params.permissions))
  )
    throw new ProtocolError(-32602, '未知权限配置')
  if (
    params.sandbox != null &&
    (typeof params.sandbox !== 'string' ||
      !['read-only', 'workspace-write', 'danger-full-access'].includes(params.sandbox))
  )
    throw new ProtocolError(-32602, '未知 sandbox 模式')
  if (params.sandboxPolicy != null) parseSandboxPolicy(params.sandboxPolicy)
}
