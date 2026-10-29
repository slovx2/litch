import { isQuestionSourceId } from '../../protocol/src/pending-asks.mjs'
// 会话树里客户端发起的方法（litch/session/*、litch/sessionProposal/*，参数和应答见
// packages/protocol/src/session-tree.mts）。只有聚合面有，由设备进程自己答，不转给引擎；
// 设置里“会话编排”关着时一律回“不支持”（设备信息里这时也不列 sessionTree）。
// 答 offer 卡（litch/sessionProposal/answer）只收握手时声明了 sessionTree 的连接：没声明的看不到 offer 卡。
// 答复提案的几个方法带了 threadId（提案所属的会话）的，设备进程核对提案是不是那个会话的（proposalIdOf）。
// 普通提案卡上的“在这里做”（litch/sessionProposal/here）只收 pending 的提案，往父会话发一条用户消息（session-tree.mts）；
// litch/sessionProposal/markHere 只了结提案、把那句话交回给客户端，由客户端放进自己的输入队列发（看得见、能撤）。

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

const flag = (value: unknown, name: string): boolean | undefined => {
  if (value == null) return undefined
  if (typeof value !== 'boolean') throw new ProtocolError(-32602, `${name} 必须是布尔值`)
  return value
}

function kindOf(value: unknown): SessionLineageKind {
  if (value === 'fresh' || value === 'fork') return value
  throw new ProtocolError(-32602, 'kind 只能是 fresh 或 fork')
}

/** 提案开始时改的东西。字符串项给空字符串是清掉提案里的值、用缺省（背景是去掉）；标题、任务给了就不能是空的 */
function overridesOf(value: unknown): ProposalOverrides {
  if (value == null) return {}
  if (!isObject(value)) throw new ProtocolError(-32602, 'overrides 必须是对象')
  const out: ProposalOverrides = {}
  for (const name of ['harness', 'model', 'effort', 'cwd', 'projectId', 'background'] as const) {
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
  const worktree = flag(value.worktree, 'overrides.worktree')
  if (worktree !== undefined) out.worktree = worktree
  return out
}

/**
 * 答复提案的方法（accept、dismiss、answer、here、markHere）的提案号。带了 threadId 的核对提案是不是这个会话的，
 * 不是回参数不对；没有这个提案的照旧由后面各自报。不带（旧客户端）不核对
 */
function proposalIdOf(tree: SessionTree, fields: Record<string, unknown>): string {
  const id = requiredString(fields.proposalId, 'proposalId')
  const threadId = optional(fields.threadId, 'threadId')
  if (threadId === undefined) return id
  const owner = tree.proposal(id)?.threadId
  if (owner !== undefined && owner !== threadId)
    throw new ProtocolError(-32602, `提案 ${id} 不是会话 ${threadId} 的`)
  return id
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
  declared: boolean,
): Promise<unknown> {
  if (!enabled)
    throw new DeviceError('unsupported', `这台设备的设置里关掉了会话编排，${method} 用不了`, {
      method,
    })
  const fields = isObject(params) ? params : {}
  switch (method) {
    case SESSION_TREE_METHOD.ignoreQuestions: {
      if (!declared) throw new DeviceError('unsupported', 'sessionTree must be declared')
      if (
        !Array.isArray(fields.sourceIds) ||
        !fields.sourceIds.length ||
        fields.sourceIds.length > 1000 ||
        fields.sourceIds.some((id) => !isQuestionSourceId(id))
      )
        throw new ProtocolError(-32602, 'sourceIds 必须是问题来源标识数组')
      return tree.ignoreQuestions(
        requiredString(fields.threadId, 'threadId'),
        fields.sourceIds as string[],
      )
    }
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
            background: optional(fields.background, 'background') ?? null,
            wakeParent,
            approvalPolicy: fields.approvalPolicy,
            sandbox: fields.sandbox,
            worktree: flag(fields.worktree, 'worktree') ?? null,
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
      const id = proposalIdOf(tree, fields)
      const overrides = overridesOf(fields.overrides)
      const { threadId } = await refusedAsInvalid(() => acceptProposal(tree, id, overrides))
      return { threadId }
    }
    case SESSION_TREE_METHOD.proposalDismiss: {
      const id = proposalIdOf(tree, fields)
      if (tree.accepting.has(id)) throw new DeviceError('unsupported', `提案 ${id} 正在开始`)
      tree.pendingProposal(id)
      tree.settleProposal(id, 'dismissed', null)
      return {}
    }
    case SESSION_TREE_METHOD.proposalAnswer: {
      if (!declared)
        throw new DeviceError('unsupported', `${method} 只给握手时声明了 sessionTree 的连接用`, {
          method,
        })
      const id = proposalIdOf(tree, fields)
      const choice = fields.choice
      if (choice !== 'session' && choice !== 'here')
        throw new ProtocolError(-32602, 'choice 只能是 session 或 here')
      tree.answerOffer(id, choice, flag(fields.worktree, 'worktree'))
      return {}
    }
    case SESSION_TREE_METHOD.proposalHere:
      tree.proposalHere(proposalIdOf(tree, fields), optional(fields.lead, 'lead'))
      return {}
    case SESSION_TREE_METHOD.proposalMarkHere:
      return {
        text: tree.proposalHere(proposalIdOf(tree, fields), optional(fields.lead, 'lead'), false),
      }
    case SESSION_TREE_METHOD.queuedNotesDeliver:
      return { delivered: await tree.deliver(requiredString(fields.threadId, 'threadId')) }
    default:
      throw new DeviceError('unsupported', `聚合面不支持 ${method}`, { method })
  }
}
