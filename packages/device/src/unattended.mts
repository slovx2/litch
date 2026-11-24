// 无人值守：经理分到的仓库里有“采集开着、自动提醒经理也开着”的外部来源，或者经理绑了启用的飞书应用、
// 接入了至少一个群（feishu/service.mts 的 unattended）时，经理和它整棵子树（工作线、
// 工作线再派的子会话）都没人在看。这些会话里要人答的东西（引擎原生的提问、审批、MCP 征询，客户端工具
// 的审批卡，Litch 自己要等人选的工具）不挂起等人，当场以拒绝或工具错误返回，并告诉 Agent 改走什么路。
//
// 判定在 DeviceManagers.unattended（经理与子树，见 manager.mts），外部来源的那一半在
// DeviceExternalService.unattended。这里只放给 Agent 的话和各方法的拒绝答复。
//
// 给模型的话不跟界面语言走，和设备给模型的其它话一样用英文。

import type {
  ExternalManagerAssignment,
  ExternalSource,
} from '../../protocol/src/external-sources.mjs'
import { DECLINE_WITH_NOTE_DECISION } from '../../protocol/src/harness-capabilities.mjs'
import { isObject } from './wire.mjs'

/** 会话在无人值守经理的树里是什么身份 */
export type UnattendedRole = 'manager' | 'line'

/** 告诉 Agent：这次请求没人答，被当场拒绝了；接下来该怎么做 */
export function unattendedNotice(role: UnattendedRole): string {
  const head =
    'Litch is running this session unattended (its manager receives external events automatically), ' +
    'so it cannot block waiting for a user to answer a question or approve an action. ' +
    'This request was refused without asking anyone; do not retry it the same way.'
  const next =
    role === 'manager'
      ? 'Instead, put the question on the board as a decision (litch_manager add, kind=decision) and continue with other work, or use another approach that needs no question or approval.'
      : 'Instead, raise it as a decision or include it in your report to your manager, or use another approach that needs no question or approval.'
  return `${head} ${next}`
}

/** 引擎发来、本来要等人答的请求：设备在无人值守时替人答的那几种 */
export const UNATTENDED_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
])

/**
 * 替人答的结果。审批：对面列了 declineWithNote 的（Claude、Pi、OpenCode）带上这句话拒绝，模型拿到它；
 * 没列的（原生 codex、dsh、ACP 系）只能普通拒绝，协议带不了说明。权限申请一样都不给；提问每道题都答这句话
 * （Claude 的计划确认因此按“未确认、用户说了这句话”收尾）；MCP 征询拒绝。不归这里管的方法是 null
 */
export function unattendedAnswer(
  method: string,
  params: unknown,
  notice: string,
): Record<string, unknown> | null {
  if (!UNATTENDED_REQUESTS.has(method) || !isObject(params)) return null
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return Array.isArray(params.availableDecisions) &&
        params.availableDecisions.includes(DECLINE_WITH_NOTE_DECISION)
        ? { decision: { [DECLINE_WITH_NOTE_DECISION]: { note: notice } } }
        : { decision: 'decline' }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' }
    case 'item/tool/requestUserInput': {
      const answers: Record<string, { answers: string[] }> = {}
      for (const question of Array.isArray(params.questions) ? params.questions : [])
        if (isObject(question) && typeof question.id === 'string')
          answers[question.id] = { answers: [notice] }
      return { answers }
    }
    default:
      return { action: 'decline', content: null, _meta: null }
  }
}

/**
 * 经理处在无人值守：分给它的仓库里至少有一个属于“采集开着、自动提醒经理也开着”的来源。
 * 只分了仓库、来源暂停或没开自动提醒时，外部事件不会自己唤醒经理，仍是有人在驱动，不算
 */
export function externalUnattended(
  config: {
    assignment(managerId: string): Pick<ExternalManagerAssignment, 'repoIds'>
    sources(): Pick<ExternalSource, 'enabled' | 'unattended' | 'repos'>[]
  },
  managerId: string,
): boolean {
  const { repoIds } = config.assignment(managerId)
  if (repoIds.length === 0) return false
  return config
    .sources()
    .some(
      (source) =>
        source.enabled &&
        source.unattended?.autoNotify === true &&
        source.repos.some((repo) => repoIds.includes(repo.repoId)),
    )
}

/** 判定：这个会话此刻是不是在无人值守经理的树里。不在是 null */
export type UnattendedCheck = (threadId: string) => UnattendedRole | null

/** 给引擎连接、聚合面用：这条请求要不要当场替人拒绝，要的话给出答复 */
export function unattendedReply(
  check: UnattendedCheck | undefined,
  method: string,
  params: unknown,
): Record<string, unknown> | null {
  if (!check || !UNATTENDED_REQUESTS.has(method) || !isObject(params)) return null
  if (typeof params.threadId !== 'string') return null
  const role = check(params.threadId)
  return role ? unattendedAnswer(method, params, unattendedNotice(role)) : null
}
