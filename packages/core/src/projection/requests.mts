// 对面停下来等人答复的请求 → 界面看到的请求，以及怎么把用户的选择换回协议里的应答。纯函数。
// 审批卡片上有哪些按钮从请求里来，界面不按请求类型写死。
import type {
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  DeclineWithNoteDecision,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  McpServerElicitationRequestParams,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from '../../../protocol/src/index.mjs'
import type { ApprovalOption, RequestView } from '../model.mjs'
import { projectElicitation } from './elicitation.mjs'
import { projectQuestion, settleAnswers } from './questions.mjs'

export interface RequestChoice {
  optionId?: string
  /** 附在决定上的一句说明。选项没声明能带说明时给了就算选得不对 */
  note?: string
  /** 提问的答案：题目标识 → 这道题的答案。每道题都要有一项，跳过的给空数组 */
  answers?: Record<string, string[]>
  /** 表单各栏填的值 */
  values?: Record<string, unknown>
}

export interface PendingRequest {
  threadId: string
  /** 协议里的回合标识。提问可能不属于任何回合 */
  turnId: string | null
  /** 协议里的条目标识 */
  itemId: string | null
  /** 界面看到的请求。itemId 先空着，由调用方按自己的条目标识填 */
  view: RequestView
  /** 把用户的选择换成协议里的应答。选择对不上时返回 null */
  answer(choice: RequestChoice): unknown | null
}

type Decided<D> = ApprovalOption & { decision: D }

/** 请求是在什么条件下来的：它所属的 harness 声明了什么 */
export interface RequestTerms {
  /**
   * 这个会话所属的 harness 声明了“拒绝并附说明”这项扩展（这条连接握手时也声明了它）。
   * 没有声明的 harness，请求里就算列了这种决定也不出写说明的入口：它收不了这句话
   */
  declineWithNote: boolean
}

/**
 * “拒绝并附说明”这种决定在请求里的名字（我们的扩展，见协议包的 extensions.mts）。
 * 对面把它列在 availableDecisions 里才算这一次收得了；列了的话卡片上还是只有一个“拒绝”，只是它可以带说明
 */
const DECLINE_WITH_NOTE = 'declineWithNote'

const pick = <D,>(
  options: Decided<D>[],
  choice: RequestChoice,
): { decision: D | DeclineWithNoteDecision } | null => {
  const chosen = options.find((option) => option.id === choice.optionId)
  if (!chosen) return null
  const note = choice.note?.trim() ?? ''
  if (!note) return { decision: chosen.decision }
  // 这个选项带不了说明：不替用户把话悄悄丢掉，算选得不对
  return chosen.note ? { decision: { declineWithNote: { note } } } : null
}

const strip = <D,>(options: Decided<D>[]): ApprovalOption[] =>
  options.map(({ id, role, note, rule }) => ({
    id,
    role,
    ...(note ? { note } : {}),
    ...(rule === undefined ? {} : { rule }),
  }))

/**
 * 把“拒绝并附说明”并到“拒绝”上：对面列了它，“拒绝”就能带说明；没单独列“拒绝”的补一个在它的位置上。
 * 返回剩下的决定，和能不能带说明。它所属的 harness 没声明这项扩展时，列了也不算能带说明
 */
function foldNote<D>(
  decisions: readonly unknown[],
  terms: RequestTerms,
): { decisions: D[]; note: boolean } {
  const note = terms.declineWithNote && decisions.includes(DECLINE_WITH_NOTE)
  const plain = decisions.includes('decline')
  const kept = decisions.flatMap((decision) =>
    decision === DECLINE_WITH_NOTE ? (plain ? [] : ['decline']) : [decision],
  )
  return { decisions: kept as D[], note }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 带参数的决定（原生 codex 的命令审批会列）里“以后都允许”的那两种，记下来的是什么：
 * - 按规则放行：一条命令的前缀，以后同样开头的命令不再问；
 * - 改网络规则：以后允许访问这个主机。
 * 别的一律不认，返回 null，调用方不把它画成按钮：改网络规则里“以后都拒绝”的那一种、
 * 这一版还不认识的决定、形状对不上的。对面列了它们不能让卡片出不来，也不能把它们画成“允许”。
 */
function alwaysRule(decision: unknown): string | null {
  if (!isRecord(decision)) return null
  const exec = decision.acceptWithExecpolicyAmendment
  if (isRecord(exec) && Array.isArray(exec.execpolicy_amendment)) {
    const words = exec.execpolicy_amendment.filter((word) => typeof word === 'string')
    return words.length > 0 ? words.join(' ') : null
  }
  const network = decision.applyNetworkPolicyAmendment
  if (isRecord(network) && isRecord(network.network_policy_amendment)) {
    const { host, action } = network.network_policy_amendment
    return action === 'allow' && typeof host === 'string' && host ? host : null
  }
  return null
}

function commandOptions(
  params: CommandExecutionRequestApprovalParams,
  terms: RequestTerms,
): Decided<CommandExecutionApprovalDecision>[] {
  const listed = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
  const offered = foldNote<CommandExecutionApprovalDecision>(listed, terms)
  const decisions: CommandExecutionApprovalDecision[] = offered.decisions.length
    ? offered.decisions
    : [
        'accept',
        'acceptForSession',
        ...(params.proposedExecpolicyAmendment
          ? [
              {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: params.proposedExecpolicyAmendment,
                },
              } satisfies CommandExecutionApprovalDecision,
            ]
          : []),
        'decline',
        'cancel',
      ]
  const options = decisions.flatMap(
    (decision, index): Decided<CommandExecutionApprovalDecision>[] => {
      if (decision === 'accept') return [{ id: 'accept', role: 'accept', decision }]
      if (decision === 'acceptForSession')
        return [{ id: 'acceptSession', role: 'acceptSession', decision }]
      if (decision === 'decline')
        return [
          { id: 'decline', role: 'decline', decision, ...(offered.note ? { note: true } : {}) },
        ]
      if (decision === 'cancel') return [{ id: 'cancel', role: 'cancel', decision }]
      // 带着规则修改的同意：以后同类的不再问。认不出的不画
      const rule = alwaysRule(decision)
      return rule === null ? [] : [{ id: `always${index}`, role: 'acceptAlways', decision, rule }]
    },
  )
  // 列了一串、一个都认不出：不能给一张没有按钮的卡片（回合会一直停在那里），也不能替它编一个“允许”。
  // 只给协议里一直都有的两种拒绝
  return options.length > 0
    ? options
    : [
        { id: 'decline', role: 'decline', decision: 'decline' },
        { id: 'cancel', role: 'cancel', decision: 'cancel' },
      ]
}

const FILE_OPTIONS: Decided<FileChangeApprovalDecision>[] = [
  { id: 'accept', role: 'accept', decision: 'accept' },
  { id: 'acceptSession', role: 'acceptSession', decision: 'acceptForSession' },
  { id: 'decline', role: 'decline', decision: 'decline' },
  { id: 'cancel', role: 'cancel', decision: 'cancel' },
]

/**
 * 文件改动的审批在标准协议里不带决定列表，按钮是固定的那四个。
 * 对面按我们的扩展带了列表时：只留认识的那几种，“拒绝”能不能带说明也看它
 */
function fileOptions(
  params: FileChangeRequestApprovalParams,
  terms: RequestTerms,
): Decided<FileChangeApprovalDecision>[] {
  const listed = (params as { availableDecisions?: unknown }).availableDecisions
  if (!Array.isArray(listed) || listed.length === 0) return FILE_OPTIONS
  const offered = foldNote<FileChangeApprovalDecision>(listed, terms)
  const options = FILE_OPTIONS.filter((option) => offered.decisions.includes(option.decision))
  if (options.length === 0) return FILE_OPTIONS
  return options.map((option) =>
    option.role === 'decline' && offered.note ? { ...option, note: true } : option,
  )
}

const PERMISSION_OPTIONS: ApprovalOption[] = [
  { id: 'accept', role: 'accept' },
  { id: 'acceptSession', role: 'acceptSession' },
  { id: 'decline', role: 'decline' },
]

/** 什么都没声明的 harness：只有标准协议里的东西 */
const NO_TERMS: RequestTerms = { declineWithNote: false }

/** 认不出的请求返回 null，调用方据此回“方法不存在” */
export function projectRequest(
  method: string,
  raw: unknown,
  id: string,
  terms: RequestTerms = NO_TERMS,
): PendingRequest | null {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const params = raw as CommandExecutionRequestApprovalParams
      const options = commandOptions(params, terms)
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        view: {
          id,
          kind: 'approval',
          subject: 'command',
          itemId: null,
          command: params.command ?? null,
          cwd: params.cwd ?? null,
          reason: params.reason ?? null,
          permissions: null,
          tool: null,
          options: strip(options),
        },
        answer: (choice) => pick(options, choice),
      }
    }
    case 'item/fileChange/requestApproval': {
      const params = raw as FileChangeRequestApprovalParams
      const options = fileOptions(params, terms)
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        view: {
          id,
          kind: 'approval',
          subject: 'fileChange',
          itemId: null,
          command: null,
          cwd: params.grantRoot ?? null,
          reason: params.reason ?? null,
          permissions: null,
          tool: null,
          options: strip(options),
        },
        answer: (choice) => pick(options, choice),
      }
    }
    case 'item/permissions/requestApproval': {
      const params = raw as PermissionsRequestApprovalParams
      const { network, fileSystem } = params.permissions
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        view: {
          id,
          kind: 'approval',
          subject: 'permissions',
          itemId: null,
          command: null,
          cwd: params.cwd,
          reason: params.reason,
          permissions: {
            network: network?.enabled === true,
            read: fileSystem?.read ?? [],
            write: fileSystem?.write ?? [],
          },
          tool: null,
          options: PERMISSION_OPTIONS,
        },
        answer(choice): PermissionsRequestApprovalResponse | null {
          if (choice.optionId === 'decline') return { permissions: {}, scope: 'turn' }
          if (choice.optionId !== 'accept' && choice.optionId !== 'acceptSession') return null
          return {
            permissions: { ...(network ? { network } : {}), ...(fileSystem ? { fileSystem } : {}) },
            scope: choice.optionId === 'accept' ? 'turn' : 'session',
          }
        },
      }
    }
    case 'item/tool/requestUserInput': {
      const params = raw as ToolRequestUserInputParams
      const questions = (params.questions ?? []).map(projectQuestion)
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        view: { id, kind: 'question', itemId: null, questions },
        // 每道题在应答里都有一项：答了的是那一个答案，跳过的是空数组。
        // 各引擎拿到空数组都当“这道题没有回答”：Claude Code 交给模型的是空的答案，Pi 的提问接口返回“没选”
        answer(choice): ToolRequestUserInputResponse | null {
          const settled = settleAnswers(questions, choice.answers)
          if (!settled) return null
          const answers: ToolRequestUserInputResponse['answers'] = {}
          for (const question of questions) {
            answers[question.id] = { answers: settled[question.id] ?? [] }
          }
          return { answers }
        },
      }
    }
    case 'mcpServer/elicitation/request':
      return projectElicitation(raw as McpServerElicitationRequestParams, id)
    default:
      return null
  }
}
