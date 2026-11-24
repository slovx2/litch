// 限时授权（timedApprovals 扩展）：用户在审批卡上点“N 小时内允许”，这个会话里这一类审批在到期前
// 不再询问。授权记在会话所在的设备上，按绝对到期时间算，设备重启后仍在；桌面、手机看到同一份。
// 定义原文在 protocol/extensions/timed-approvals.json。本文件自包含，设备进程和客户端核心都直接引用。

export const TIMED_APPROVALS_EXTENSION = 'timedApprovals'

export const TIMED_APPROVAL = {
  list: 'litch/timedApproval/list',
  grant: 'litch/timedApproval/grant',
  revoke: 'litch/timedApproval/revoke',
  changed: 'litch/timedApproval/changed',
} as const

/**
 * 审批的类别。一次授权只放行同一会话里的同一类：
 * - command、fileChange、permissions：各 harness 原生的命令、改文件、追加权限审批（设备代答）；
 * - machine：远程会话操作控制端电脑（litch_machine 的命令与文件）；
 * - browser：内置浏览器的网站许可；
 * - chrome：Chrome 的网站许可；
 * - mcp：MCP 工具调用的审批，以及只有允许、拒绝的 MCP 征询（设备代答），再按 MCP 服务名分（scope）。
 */
export const TIMED_APPROVAL_CATEGORIES = [
  'command',
  'fileChange',
  'permissions',
  'machine',
  'browser',
  'chrome',
  'mcp',
] as const
export type TimedApprovalCategory = (typeof TIMED_APPROVAL_CATEGORIES)[number]

/** 设备代答的类别（原生审批）；其余由执行客户端工具的桌面端按设备给的名单判定 */
export const DEVICE_ANSWERED_CATEGORIES: readonly TimedApprovalCategory[] = [
  'command',
  'fileChange',
  'permissions',
  'mcp',
]

/** 时长上下限（小时）。下限 15 分钟，上限 7 天 */
export const TIMED_APPROVAL_MIN_HOURS = 0.25
export const TIMED_APPROVAL_MAX_HOURS = 168
/** 卡片上的快捷值（小时） */
export const TIMED_APPROVAL_PRESETS = [1, 4, 8, 24] as const
/** 一台设备上同时生效的授权最多几条（超出时最早到期的先让位） */
export const TIMED_APPROVALS_MAX = 512

export interface TimedApproval {
  id: string
  threadId: string
  category: TimedApprovalCategory
  /** 类别下再细分的范围：mcp 是 MCP 服务名，其余类别是空串 */
  scope: string
  /** 毫秒时间戳 */
  grantedAt: number
  /** 毫秒时间戳；到这一刻起不再放行 */
  expiresAt: number
}

export interface TimedApprovalGrantParams {
  threadId: string
  category: TimedApprovalCategory
  /** mcp 必填（MCP 服务名），其余类别不给 */
  scope?: string
  hours: number
}

/** 一张审批卡归哪一类、哪个范围 */
export interface TimedApprovalTarget {
  category: TimedApprovalCategory
  scope: string
}

/** MCP 服务名的长度上限 */
export const TIMED_APPROVAL_SCOPE_MAX = 256

export interface TimedApprovalRevokeParams {
  /** 给 id 撤一条；给 threadId 撤这个会话的全部（可再加 category 只撤一类） */
  id?: string
  threadId?: string
  category?: TimedApprovalCategory
}

export interface TimedApprovalList {
  grants: TimedApproval[]
}

export interface TimedApprovalRequests {
  'litch/timedApproval/list': { params: Record<string, never>; result: TimedApprovalList }
  'litch/timedApproval/grant': { params: TimedApprovalGrantParams; result: TimedApproval }
  'litch/timedApproval/revoke': { params: TimedApprovalRevokeParams; result: { revoked: number } }
}

export const isTimedApprovalCategory = (value: unknown): value is TimedApprovalCategory =>
  typeof value === 'string' && (TIMED_APPROVAL_CATEGORIES as readonly string[]).includes(value)

/** 时长合法：有限数，在上下限之间 */
export const validTimedApprovalHours = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= TIMED_APPROVAL_MIN_HOURS &&
  value <= TIMED_APPROVAL_MAX_HOURS

/** 这条授权此刻是否生效 */
export const timedApprovalActive = (grant: TimedApproval, now: number): boolean =>
  grant.expiresAt > now

/** 名单里有没有覆盖这个会话、这一类（这个范围）的生效授权 */
export function findTimedApproval(
  grants: readonly TimedApproval[],
  threadId: string,
  category: TimedApprovalCategory,
  now: number,
  scope = '',
): TimedApproval | null {
  return (
    grants.find(
      (grant) =>
        grant.threadId === threadId &&
        grant.category === category &&
        grant.scope === scope &&
        timedApprovalActive(grant, now),
    ) ?? null
  )
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * 审批性质的 MCP 征询是哪个服务的；不是的返回 null。审批性质指只有允许、拒绝两种答法：
 * - 原生 codex 与 Claude 入口用征询问“要不要让这个 MCP 工具跑”（_meta.codex_approval_kind 是 mcp_tool_call）；
 * - 不要填任何栏目的普通表单（requestedSchema 没有栏目），答复就是允许或拒绝。
 * 要填内容的表单、网页上办的事、别的带特权标记的征询（登录、推荐工具）都不是。
 */
export function mcpApprovalServer(params: unknown): string | null {
  const fields = record(params)
  if (fields?.mode !== 'form' || typeof fields.serverName !== 'string') return null
  const server = fields.serverName
  if (!server || server.length > TIMED_APPROVAL_SCOPE_MAX) return null
  const kind = record(fields._meta)?.codex_approval_kind
  if (kind === 'mcp_tool_call') return server
  if (kind !== undefined) return null
  const properties = record(record(fields.requestedSchema)?.properties)
  return properties && Object.keys(properties).length > 0 ? null : server
}

/**
 * 原生审批的请求对应哪一类、哪个范围；不认识的返回 null
 * （提问、要填内容的表单、计划确认等不在限时授权里）
 */
export function nativeApprovalTarget(method: string, params: unknown): TimedApprovalTarget | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { category: 'command', scope: '' }
    case 'item/fileChange/requestApproval':
      return { category: 'fileChange', scope: '' }
    case 'item/permissions/requestApproval':
      return { category: 'permissions', scope: '' }
    case 'mcpServer/elicitation/request': {
      const server = mcpApprovalServer(params)
      return server === null ? null : { category: 'mcp', scope: server }
    }
    default:
      return null
  }
}
