// 无人值守界面的纯逻辑：桌面（packages/ui）和手机（apps/mobile）共用，不碰 DOM 与 React。
// 只认核心给的快照与协议类型；字由各端自己的文案表拼。
import type {
  ExternalAccess,
  ExternalConfiguration,
  ExternalIdentityRepository,
  ExternalInboxEvent,
  ExternalInboxFilter,
  ExternalManagerAssignment,
  ExternalReadiness,
  ExternalReadinessArea,
  ExternalSourceDraft,
  ExternalSourceStatus,
} from '@litch/core'

/** 配置快照里的身份头（ID、机器人数字 ID、登录名） */
export type IdentityHead = ExternalConfiguration['identities'][number]

/** 收件箱三个页签 */
export const INBOX_TABS = ['pending', 'processed', 'blocked'] as const
export type InboxTab = (typeof INBOX_TABS)[number]

/** 页签换成设备查询条件。已处理含“已提醒”；onlyNotified 只看已提醒 */
export function inboxFilter(
  tab: InboxTab,
  managerId: string,
  options: { reason?: string | undefined; onlyNotified?: boolean } = {},
): ExternalInboxFilter {
  const base: ExternalInboxFilter = { managerId }
  if (tab === 'pending')
    return {
      ...base,
      status: 'pending_triage',
      ...(options.reason ? { reason: options.reason } : {}),
    }
  if (tab === 'blocked') return { ...base, status: 'blocked' }
  return options.onlyNotified
    ? { ...base, status: 'notified' }
    : { ...base, statuses: ['processed', 'notified'] }
}

/** access 只有布尔 true 才算可用；缺省、断线一律只读 */
export function allowed(access: ExternalAccess | undefined, key: keyof ExternalAccess): boolean {
  return access?.[key] === true
}

export type SourceState = 'collecting' | 'paused' | 'backoff' | 'blocked'

export function sourceState(status: ExternalSourceStatus): SourceState {
  if (!status.source.enabled) return 'paused'
  return status.runtime?.state ?? 'collecting'
}

export const READINESS_AREAS: readonly ExternalReadinessArea[] = [
  'collect',
  'notify',
  'dispatch',
  'write',
]

/** 就绪四项的状态；设备没报的项当作未验证 */
export function readinessStates(
  readiness: ExternalReadiness | undefined,
): { area: ExternalReadinessArea; state: 'ok' | 'blocked' | 'unverified' }[] {
  return READINESS_AREAS.map((area) => ({ area, state: readiness?.[area]?.state ?? 'unverified' }))
}

/** 设备一行摘要：各状态的仓库数与待分拣总数 */
export function sourcesSummary(sources: readonly ExternalSourceStatus[]) {
  const counts: Record<SourceState, number> = { collecting: 0, paused: 0, backoff: 0, blocked: 0 }
  let pending = 0
  for (const status of sources) {
    counts[sourceState(status)]++
    pending += status.runtime?.backlog.pending ?? 0
  }
  return { counts, pending, total: sources.length }
}

/** “owner/name#number”：从设备给的规范链接读出；读不出只给编号 */
export function subjectLabel(subject: { url: string; number: string }): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//u.exec(subject.url)
  return match ? `${match[1]}/${match[2]}#${subject.number}` : `#${subject.number}`
}

export function repoLabel(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`
}

/** 设备给的原因码中界面认得的几个；其余原样显示 */
export const KNOWN_REASONS = [
  'rate_limited',
  'role_below_minimum',
  'manager_busy',
  'manager_paused',
  'source_paused',
  'stale',
  'external_actor',
  'evidence_missing',
  'route_missing',
  'route_conflict',
  'manual',
] as const
export type KnownReason = (typeof KNOWN_REASONS)[number]
export function knownReason(reason: string | undefined): KnownReason | null {
  return reason && (KNOWN_REASONS as readonly string[]).includes(reason)
    ? (reason as KnownReason)
    : null
}

/** 收件条目按候选聚合：同一 intakeId 只出一行，保留最新的那条作代表 */
export function groupInbox(entries: readonly ExternalInboxEvent[]): {
  head: ExternalInboxEvent
  count: number
}[] {
  const rows: { head: ExternalInboxEvent; count: number }[] = []
  const byIntake = new Map<string, { head: ExternalInboxEvent; count: number }>()
  for (const entry of entries) {
    const key = entry.intakeId
    const found = key ? byIntake.get(key) : undefined
    if (found) {
      found.count++
      continue
    }
    const row = { head: entry, count: 1 }
    rows.push(row)
    if (key) byIntake.set(key, row)
  }
  return rows
}

/** 新仓库的默认来源草稿：触发全开、默认标签、triage 门槛、即时反馈开、自动提醒关 */
export function newSourceDraft(
  repository: ExternalIdentityRepository,
  options: { sourceId: string; localRoot: string; pollIdentity?: string | null },
): ExternalSourceDraft {
  const grant =
    repository.grants.find((one) => one.identityId === options.pollIdentity && one.read) ??
    repository.grants.find((one) => one.read)
  return {
    sourceId: options.sourceId,
    provider: 'github',
    enabled: true,
    credentialRef: grant?.credentialRef ?? '',
    botUserId: grant?.botUserId ?? '',
    triggers: {
      mention: true,
      assignment: true,
      reviewRequest: true,
      label: Boolean(repository.defaultLabelId),
      labelIds: repository.defaultLabelId ? [repository.defaultLabelId] : [],
    },
    minRole: 'triage',
    writePolicy: { comment: true, draftPr: true, status: false, managedPush: false },
    interval: 120,
    repos: [
      {
        repoId: repository.repoId,
        owner: repository.owner,
        name: repository.name,
        url: repository.url,
        localRoot: options.localRoot,
        allowedBase: [repository.defaultBranch],
        headNamespace: 'litch/',
        pollIdentity: options.pollIdentity ?? null,
        labelRoutes: [],
        immediateFeedback: true,
        immediateFeedbackLanguage: 'follow-ui',
      },
    ],
    routes: [],
    unattended: { autoNotify: false },
  }
}

/** 来源 ID：仓库数字 ID 稳定且同设备唯一 */
export const sourceIdOf = (repoId: string) => `github-${repoId}`

/** 经理所用身份对其所接仓库缺写权限的那些仓库（只提示，不拦保存） */
export function writeMissing(
  assignment: Pick<ExternalManagerAssignment, 'identityId' | 'repoIds'>,
  repositories: readonly ExternalIdentityRepository[],
): ExternalIdentityRepository[] {
  if (!assignment.identityId) return []
  return repositories.filter(
    (repo) =>
      assignment.repoIds.includes(repo.repoId) &&
      repo.grants.some(
        (one) => one.identityId === assignment.identityId && one.write === 'missing',
      ),
  )
}

/** 同一仓库上同一身份已分给别的经理：返回冲突的仓库 ID */
export function assignmentConflicts(
  next: Pick<ExternalManagerAssignment, 'managerId' | 'identityId' | 'repoIds'>,
  all: readonly ExternalManagerAssignment[],
): string[] {
  if (!next.identityId) return []
  return next.repoIds.filter((repoId) =>
    all.some(
      (one) =>
        one.managerId !== next.managerId &&
        one.identityId === next.identityId &&
        one.repoIds.includes(repoId),
    ),
  )
}

/** 设备码剩余秒数（设备给 UTC 秒，客户端时钟是毫秒） */
export function secondsLeft(expiresAt: number, nowMs: number): number {
  return Math.max(0, Math.floor(expiresAt - nowMs / 1000))
}

export function clockText(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 一次写操作的 ID：设备按它去重 */
export function operationId(): string {
  return (
    (globalThis as { crypto?: { randomUUID?(): string } }).crypto?.randomUUID?.() ??
    `op-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}
