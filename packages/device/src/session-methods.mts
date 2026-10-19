// 会话树里客户端发起的五个方法（litch/session/*、litch/sessionProposal/*，参数和应答见
// packages/protocol/src/session-tree.mts）。只有聚合面有，由设备进程自己答，不转给引擎；
// 设置里“会话编排”关着时一律回“不支持”（设备信息里这时也不列 sessionTree）。

import { SESSION_TREE_METHOD, type SessionLineageKind } from '../../protocol/src/session-tree.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import { StartRefused, startChild } from './session-start.mjs'
import type { SessionTree } from './session-tree.mjs'
import { DeviceError, isObject } from './wire.mjs'

/** 正在起的提案：同一个提案点了两下只起一个 */
const accepting = new WeakMap<SessionTree, Set<string>>()

const optional = (value: unknown, name: string): string | undefined => {
  if (value == null) return undefined
  if (typeof value !== 'string') throw new ProtocolError(-32602, `${name} 必须是字符串`)
  return value || undefined
}

function kindOf(value: unknown): SessionLineageKind {
  if (value === 'fresh' || value === 'fork') return value
  throw new ProtocolError(-32602, 'kind 只能是 fresh 或 fork')
}

/** 派不出来的原因（StartRefused）按参数不对回给客户端 */
async function start(...args: Parameters<typeof startChild>): Promise<{ threadId: string }> {
  try {
    const { threadId } = await startChild(...args)
    return { threadId }
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
      if (typeof fields.wakeParent !== 'boolean')
        throw new ProtocolError(-32602, 'wakeParent 必须是布尔值')
      return start(
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
          wakeParent: fields.wakeParent,
          approvalPolicy: fields.approvalPolicy,
          sandbox: fields.sandbox,
        },
        'user',
      )
    }
    case SESSION_TREE_METHOD.detach:
      tree.detach(requiredString(fields.threadId, 'threadId'))
      return {}
    case SESSION_TREE_METHOD.proposalList:
      return { proposals: tree.proposals(requiredString(fields.threadId, 'threadId')) }
    case SESSION_TREE_METHOD.proposalAccept: {
      const id = requiredString(fields.proposalId, 'proposalId')
      const busy = accepting.get(tree) ?? new Set<string>()
      accepting.set(tree, busy)
      if (busy.has(id)) throw new DeviceError('unsupported', `提案 ${id} 正在开始`)
      const proposal = tree.pendingProposal(id)
      busy.add(id)
      try {
        const started = await start(
          tree,
          proposal.threadId,
          {
            harness: proposal.harness,
            model: proposal.model,
            cwd: proposal.cwd,
            kind: proposal.kind,
            title: proposal.title,
            prompt: proposal.prompt,
            wakeParent: proposal.wakeParent,
            proposalId: proposal.id,
          },
          'proposal',
        )
        tree.settleProposal(id, 'started', started.threadId)
        return started
      } finally {
        busy.delete(id)
      }
    }
    case SESSION_TREE_METHOD.proposalDismiss: {
      const id = requiredString(fields.proposalId, 'proposalId')
      tree.pendingProposal(id)
      tree.settleProposal(id, 'dismissed', null)
      return {}
    }
    default:
      throw new DeviceError('unsupported', `聚合面不支持 ${method}`, { method })
  }
}
