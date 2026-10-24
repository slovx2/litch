// 定时任务回合里要人答的请求（审批、提问、MCP 征询）：设备进程的内部连接接过来，等人答，到时限替人拒绝。
//
// 各引擎都把这类请求发给会话的全部订阅连接，后来订阅（打开这个会话）的客户端补收到同一条，等待期间会话状态带
// waitingOnApproval / waitingOnUserInput，状态通知发给每条连接：所以连着的客户端侧栏上看得到“等你处理”，
// 打开会话就能答，答了引擎发 serverRequest/resolved，这里取消计时。没人答的，到时限（设备设置
// tasks.approvalTimeoutMinutes）由这条内部连接按“拒绝”答复引擎，记进运行记录（DeviceTaskRun.approvals）。
//
// 只管下面 REQUEST_KINDS 里的几种方法。客户端工具调用（item/tool/call，含 litch_browser 的 request_sign_in）
// 不经这里：登录审批有它自己的过期和事先授权。
import {
  TASK_RUN_APPROVAL_TITLE_MAX,
  TASK_RUN_APPROVALS_MAX,
  type TaskRunApproval,
  type TaskRunApprovalKind,
} from '../../protocol/src/device-tasks.mjs'
import type { EngineLink } from './engine-link.mjs'
import { isObject, type RpcId } from './wire.mjs'

/** 管的请求是哪一种 */
const REQUEST_KINDS: Record<string, TaskRunApprovalKind> = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
  'item/tool/requestUserInput': 'question',
  'mcpServer/elicitation/request': 'elicitation',
}

const kindOf = (method: string): TaskRunApprovalKind | undefined =>
  Object.hasOwn(REQUEST_KINDS, method) ? REQUEST_KINDS[method] : undefined

/** 默认等多久（分钟），和 Go 层 settings_tasks.go 的默认值一样 */
export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 30

export interface ApprovalClock {
  /** 毫秒 */
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface ApprovalGuardHost {
  clock: ApprovalClock
  /** 现在的时限（毫秒）。按请求到的那一刻取，设置改了只影响之后的请求 */
  timeoutMs(): number
  log(line: string): void
  /** 记录变了（多了一条、有了结果、被自动拒绝），给的是整份 */
  changed(approvals: TaskRunApproval[]): void
}

const seconds = (ms: number): number => Math.floor(ms / 1000)

const clip = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  return chars.length > TASK_RUN_APPROVAL_TITLE_MAX
    ? `${chars.slice(0, TASK_RUN_APPROVAL_TITLE_MAX - 1).join('')}…`
    : line
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 一句话说这条请求是什么 */
export function approvalTitle(kind: TaskRunApprovalKind, params: Record<string, unknown>): string {
  switch (kind) {
    case 'command':
      return clip(
        str(params.command) ||
          (Array.isArray(params.command) ? params.command.join(' ') : '') ||
          str(params.reason),
      )
    case 'fileChange':
      return clip(str(params.reason) || str(params.grantRoot))
    case 'permissions': {
      const permissions = isObject(params.permissions) ? params.permissions : {}
      const network = isObject(permissions.network) && permissions.network.enabled === true
      const files = isObject(permissions.fileSystem) ? permissions.fileSystem : {}
      const write = Array.isArray(files.write) ? files.write.map(String) : []
      const read = Array.isArray(files.read) ? files.read.map(String) : []
      const wanted = [
        ...(network ? ['network'] : []),
        ...write.map((path) => `write ${path}`),
        ...read.map((path) => `read ${path}`),
      ].join(', ')
      return clip(str(params.reason) || wanted)
    }
    case 'question': {
      const first = Array.isArray(params.questions) ? params.questions[0] : null
      return clip(isObject(first) ? str(first.question) || str(first.header) : '')
    }
    case 'elicitation': {
      const said = str(params.message) || str(params.title)
      return clip([str(params.serverName), said].filter(Boolean).join(': '))
    }
  }
}

/** “拒绝”的答复：审批是 decline、权限申请一样都不给、提问每道题都跳过、MCP 征询是 decline */
export function declineAnswer(
  kind: TaskRunApprovalKind,
  params: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case 'command':
    case 'fileChange':
      return { decision: 'decline' }
    case 'permissions':
      return { permissions: {}, scope: 'turn' }
    case 'question': {
      const answers: Record<string, { answers: string[] }> = {}
      for (const question of Array.isArray(params.questions) ? params.questions : [])
        if (isObject(question) && typeof question.id === 'string')
          answers[question.id] = { answers: [] }
      return { answers }
    }
    case 'elicitation':
      return { action: 'decline', content: null, _meta: null }
  }
}

interface Tracked {
  id: RpcId
  kind: TaskRunApprovalKind
  params: Record<string, unknown>
  timer: unknown
}

/** 这次运行此刻在跑的回合：会话和回合号（turn/start 发出去、应答还没回来时回合号是 null） */
export interface GuardedTurn {
  threadId: string
  turnId: string | null
}

/** 这条请求是不是这次运行的回合里的：别的回合（会话里用户自己的回合）的照原来的做法 */
const inTurn = (params: Record<string, unknown>, turn: GuardedTurn | null): boolean =>
  turn !== null &&
  params.threadId === turn.threadId &&
  (turn.turnId === null || params.turnId == null || params.turnId === turn.turnId)

/**
 * 接管一次运行的内部连接上、这次运行的回合里的请求。turn 给出此刻在跑的任务回合（没有是 null）。
 * earlier 是这次运行已经记着的（设备进程重启后接着等时）：引擎重放同一条还在等的请求时沿用原来的时限。
 * 一直管到连接关：关的时候还在等的记成有了结果（回合结束、连接断了，引擎那边也作废了）
 */
export function guardApprovals(
  link: EngineLink,
  turn: () => GuardedTurn | null,
  host: ApprovalGuardHost,
  earlier: readonly TaskRunApproval[] = [],
): void {
  const { clock } = host
  const approvals: TaskRunApproval[] = earlier.map((entry) => ({ ...entry }))
  const tracked = new Map<string, Tracked>()
  link.claimRequests(
    (method, params) => kindOf(method) !== undefined && isObject(params) && inTurn(params, turn()),
  )

  const publish = () => host.changed(approvals.map((entry) => ({ ...entry })))
  const entryOf = (key: string) => approvals.find((entry) => entry.requestId === key)

  const settle = (key: string, state: 'resolved' | 'autoDeclined') => {
    const one = tracked.get(key)
    if (one) clock.clearTimer(one.timer)
    tracked.delete(key)
    const entry = entryOf(key)
    if (!entry || entry.state !== 'waiting') return false
    entry.state = state
    entry.settledAt = seconds(clock.now())
    return true
  }

  const decline = (key: string) => {
    const one = tracked.get(key)
    if (!one) return
    const sent = link.answer(one.id, declineAnswer(one.kind, one.params))
    if (!settle(key, sent ? 'autoDeclined' : 'resolved')) return
    if (sent)
      host.log(
        `任务回合里的请求 ${key}（${one.kind}）等满时限没人答，替人拒绝了：${entryOf(key)?.title}`,
      )
    publish()
  }

  const unrequest = link.onServerRequest((method, params, id) => {
    const kind = kindOf(method)
    // 不归这里管的（客户端工具调用等）照原来的做法
    if (!kind || !isObject(params)) return
    const key = String(id)
    if (!inTurn(params, turn()) || tracked.has(key)) return
    const nowMs = clock.now()
    const before = entryOf(key)
    let delay = host.timeoutMs()
    if (before?.state === 'waiting') delay = before.declineAt * 1000 - nowMs
    else if (before) return
    else {
      const entry: TaskRunApproval = {
        requestId: key,
        kind,
        title: approvalTitle(kind, params),
        requestedAt: seconds(nowMs),
        declineAt: seconds(nowMs + delay),
        state: 'waiting',
        settledAt: null,
      }
      // 记满了的只计时、不记（极少：一个回合里几十个审批）
      if (approvals.length < TASK_RUN_APPROVALS_MAX) approvals.push(entry)
    }
    const timer = clock.setTimer(() => decline(key), Math.max(0, delay))
    tracked.set(key, { id, kind, params, timer })
    if (!before) publish()
  })

  const unnotify = link.onNotification((method, params) => {
    if (method !== 'serverRequest/resolved' || !isObject(params) || params.requestId == null) return
    if (settle(String(params.requestId), 'resolved')) publish()
  })

  link.onClose(() => {
    unrequest()
    unnotify()
    let changed = false
    for (const key of [...tracked.keys()]) changed = settle(key, 'resolved') || changed
    // 重启前记着、这次没再收到的
    for (const entry of approvals)
      if (entry.state === 'waiting') {
        entry.state = 'resolved'
        entry.settledAt = seconds(clock.now())
        changed = true
      }
    if (changed) publish()
  })
}
