// 会话树里客户端发起的五个方法（litch/session/*、litch/sessionProposal/*，参数和应答见
// packages/protocol/src/session-tree.mts）。只有聚合面有，由设备进程自己答，不转给引擎；
// 设置里“会话编排”关着时一律回“不支持”（设备信息里这时也不列 sessionTree）。

import { SESSION_TREE_METHOD, type SessionLineageKind } from '../../protocol/src/session-tree.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import {
  acceptProposal,
  type ProposalOverrides,
  StartRefused,
  startChild,
} from './session-start.mjs'
import type { SessionTree } from './session-tree.mjs'
import { DeviceError, isObject } from './wire.mjs'

const optional = (value: unknown, name: string): string | undefined => {
  if (value == null) return undefined
  if (typeof value !== 'string') throw new ProtocolError(-32602, `${name} 必须是字符串`)
  return value || undefined
}

function kindOf(value: unknown): SessionLineageKind {
  if (value === 'fresh' || value === 'fork') return value
  throw new ProtocolError(-32602, 'kind 只能是 fresh 或 fork')
}

/** 提案开始时改的东西。字符串项给空字符串是清掉提案里的值、用缺省；标题、简报给了就不能是空的 */
function overridesOf(value: unknown): ProposalOverrides {
  if (value == null) return {}
  if (!isObject(value)) throw new ProtocolError(-32602, 'overrides 必须是对象')
  const out: ProposalOverrides = {}
  for (const name of ['harness', 'model', 'effort', 'cwd', 'projectId'] as const) {
    const given = value[name]
    if (given == null) continue
    if (typeof given !== 'string') throw new ProtocolError(-32602, `overrides.${name} 必须是字符串`)
    out[name] = given
  }
  if (value.kind != null) out.kind = kindOf(value.kind)
  if (value.title != null) out.title = requiredString(value.title, 'overrides.title')
  if (value.prompt != null) out.prompt = requiredString(value.prompt, 'overrides.prompt')
  if (value.approvalPolicy != null) out.approvalPolicy = value.approvalPolicy
  if (value.sandbox != null) out.sandbox = value.sandbox
  if (value.wakeParent != null) {
    if (typeof value.wakeParent !== 'boolean')
      throw new ProtocolError(-32602, 'overrides.wakeParent 必须是布尔值')
    out.wakeParent = value.wakeParent
  }
  return out
}

/** 派不出来的原因（StartRefused）按参数不对回给客户端 */
async function refusedAsInvalid<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof StartRefused) throw new ProtocolError(-32602, error.message)
    throw error
  }
}

export async function sessionTreeCall(
  tree: SessionTree,
  enabled: boolean,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!enabled)
    throw new DeviceError('unsupported', `这台设备的设置里关掉了会话编排，${method} 用不了`, {
      method,
    })
  const fields = isObject(params) ? params : {}
  switch (method) {
    case SESSION_TREE_METHOD.start: {
      const wakeParent = fields.wakeParent
      if (typeof wakeParent !== 'boolean')
        throw new ProtocolError(-32602, 'wakeParent 必须是布尔值')
      const { threadId } = await refusedAsInvalid(() =>
        startChild(
          tree,
          requiredString(fields.parentThreadId, 'parentThreadId'),
          {
            harness: optional(fields.harness, 'harness') ?? null,
            model: optional(fields.model, 'model') ?? null,
            effort: optional(fields.effort, 'effort') ?? null,
            cwd: optional(fields.cwd, 'cwd') ?? null,
            projectId: optional(fields.projectId, 'projectId') ?? null,
            kind: kindOf(fields.kind),
            title: requiredString(fields.title, 'title'),
            prompt: requiredString(fields.prompt, 'prompt'),
            wakeParent,
            approvalPolicy: fields.approvalPolicy,
            sandbox: fields.sandbox,
          },
          'user',
        ),
      )
      return { threadId }
    }
    case SESSION_TREE_METHOD.detach:
      tree.detach(requiredString(fields.threadId, 'threadId'))
      return {}
    case SESSION_TREE_METHOD.proposalList:
      return {
        proposals: tree.proposals(
          requiredString(fields.threadId, 'threadId'),
          fields.includeSettled === true,
        ),
      }
    case SESSION_TREE_METHOD.proposalAccept: {
      const id = requiredString(fields.proposalId, 'proposalId')
      const overrides = overridesOf(fields.overrides)
      const { threadId } = await refusedAsInvalid(() => acceptProposal(tree, id, overrides))
      return { threadId }
    }
    case SESSION_TREE_METHOD.proposalDismiss: {
      const id = requiredString(fields.proposalId, 'proposalId')
      if (tree.accepting.has(id)) throw new DeviceError('unsupported', `提案 ${id} 正在开始`)
      tree.pendingProposal(id)
      tree.settleProposal(id, 'dismissed', null)
      return {}
    }
    default:
      throw new DeviceError('unsupported', `聚合面不支持 ${method}`, { method })
  }
}
