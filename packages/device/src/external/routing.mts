// 一份仓库配置快照只读设备的已核验身份、经理分配和标签路线。
import { isAbsolute } from 'node:path'
import type {
  ExternalEvent,
  ExternalRepo,
  ExternalRole,
  ExternalSourceDraft,
} from '../../../protocol/src/external-sources.mjs'
import type { Manager } from '../../../protocol/src/manager.mjs'

export type ManagerLookup = (managerId: string) => Manager | null
export type Trigger = 'mention' | 'assignment' | 'review_request' | 'label'
export interface ExternalRouteIdentity {
  identityId: string
  botUserId: string
  login: string
}
export interface ExternalConfigurationSnapshot {
  revision: number
  identities: readonly ExternalRouteIdentity[]
  repositories: readonly {
    repoId: string
    pollIdentity?: string | null
    immediateFeedback?: boolean
    immediateFeedbackLanguage?: ExternalRepo['immediateFeedbackLanguage']
    labelRoutes?: readonly { labelId: string; managerId: string }[]
  }[]
  assignments: readonly {
    managerId: string
    identityId: string | null
    repoIds: readonly string[]
  }[]
}
export interface ExternalRoutingConfig {
  revision: number
  identities: readonly ExternalRouteIdentity[]
  assignments: readonly { managerId: string; identityId: string }[]
  labelRoutes: readonly { labelId: string; managerId: string }[]
}
export type ExternalRoutingPolicy = () => ExternalConfigurationSnapshot

export function repositoryRouting(
  snapshot: ExternalConfigurationSnapshot,
  repoId: string,
): ExternalRoutingConfig {
  const repo = snapshot.repositories.find((candidate) => candidate.repoId === repoId)
  return {
    revision: snapshot.revision,
    identities: snapshot.identities,
    labelRoutes: repo?.labelRoutes ?? [],
    assignments: repo
      ? snapshot.assignments.flatMap((entry) =>
          entry.identityId && entry.repoIds.includes(repoId)
            ? [{ identityId: entry.identityId, managerId: entry.managerId }]
            : [],
        )
      : [],
  }
}

export const isHumanFollowUp = (event: ExternalEvent) =>
  ['comment', 'review', 'review_comment'].includes(event.kind)
export const isExternalContent = (event: ExternalEvent) =>
  isHumanFollowUp(event) || event.kind === 'issue' || event.kind === 'pull_request'
export const isStatus = (event: ExternalEvent) =>
  ['ci', 'merged', 'closed', 'reopened'].includes(event.kind)
export const isTriggerWithdrawal = (event: ExternalEvent) =>
  ['unassigned', 'review_request_removed', 'unlabeled'].includes(event.kind)
export const isLocalBot = (cfg: ExternalRoutingConfig, userId: string | null | undefined) =>
  !!userId && cfg.identities.some((identity) => identity.botUserId === userId)
export const managerIdentity = (cfg: ExternalRoutingConfig, managerId: string) =>
  cfg.identities.find((identity) =>
    cfg.assignments.some(
      (assignment) =>
        assignment.managerId === managerId && assignment.identityId === identity.identityId,
    ),
  )
export const configuredAddresses = (cfg: ExternalRoutingConfig) =>
  cfg.identities.filter((identity) =>
    cfg.assignments.some((assignment) => assignment.identityId === identity.identityId),
  )

export function explicitTrigger(
  source: ExternalSourceDraft,
  event: ExternalEvent,
  cfg: ExternalRoutingConfig,
  mentions: readonly string[] = [],
): Trigger | null {
  const { kind, targetEvidence: target } = event
  if (
    source.triggers.mention &&
    isExternalContent(event) &&
    mentions.some((id) => isLocalBot(cfg, id))
  )
    return 'mention'
  if (source.triggers.assignment && kind === 'assigned' && isLocalBot(cfg, target.assigneeUserId))
    return 'assignment'
  if (
    source.triggers.reviewRequest &&
    kind === 'review_requested' &&
    target.subject.kind === 'pull_request' &&
    isLocalBot(cfg, target.reviewerUserId)
  )
    return 'review_request'
  if (
    source.triggers.label &&
    kind === 'labeled' &&
    ((!!target.labelId &&
      (cfg.labelRoutes.some((r) => r.labelId === target.labelId) ||
        source.triggers.labelIds.includes(target.labelId))) ||
      target.labelName?.toLowerCase() === 'litch')
  )
    return 'label'
  return null
}

export function routeManagerMatches(manager: Manager | null, repo: ExternalRepo): boolean {
  return manager?.status === 'active' && isAbsolute(repo.localRoot)
}

export type RouteResolution =
  | { routeId: string; managerId: string }
  | { reason: 'no_route' | 'route_conflict' | 'route_target_invalid' | 'route_labels_unverified' }

export function selectRoute(
  source: ExternalSourceDraft,
  event: ExternalEvent,
  repo: ExternalRepo,
  manager: ManagerLookup,
  cfg: ExternalRoutingConfig,
  mentions: readonly string[] = [],
): RouteResolution {
  const trigger = explicitTrigger(source, event, cfg, mentions)
  const target = event.targetEvidence
  const addressed =
    trigger === 'mention'
      ? mentions
      : trigger === 'assignment'
        ? [target.assigneeUserId]
        : trigger === 'review_request'
          ? [target.reviewerUserId]
          : []
  let matches: ExternalRoutingConfig['assignments'] = []
  let key = 'identity'
  if (trigger === 'label') {
    const labelId = target.labelId
    const routes = labelId ? cfg.labelRoutes.filter((route) => route.labelId === labelId) : []
    if (
      !labelId &&
      cfg.labelRoutes.length &&
      target.labelName?.toLowerCase() === 'litch' &&
      target.labelIds === undefined
    )
      return { reason: 'route_labels_unverified' }
    if (routes.length) {
      matches = cfg.assignments.filter((assignment) =>
        routes.some((route) => route.managerId === assignment.managerId),
      )
      key = `label:${labelId}`
    } else if (target.labelName?.toLowerCase() === 'litch' && cfg.assignments.length === 1) {
      matches = cfg.assignments
      key = 'label:litch'
    }
  } else if (addressed.length) {
    matches = cfg.assignments.filter((assignment) =>
      cfg.identities.some(
        (identity) =>
          identity.identityId === assignment.identityId && addressed.includes(identity.botUserId),
      ),
    )
  }
  if (matches.length > 1) return { reason: 'route_conflict' }
  const chosen = matches[0]
  if (!chosen) return { reason: 'no_route' }
  const identity = managerIdentity(cfg, chosen.managerId)
  if (!identity || !routeManagerMatches(manager(chosen.managerId), repo))
    return { reason: 'route_target_invalid' }
  return {
    routeId: `${key}:${identity.identityId}:${identity.botUserId}`,
    managerId: chosen.managerId,
  }
}

export function validateExternalRoutes(
  repo: ExternalRepo,
  cfg: ExternalRoutingConfig,
  manager: ManagerLookup,
): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  const managers = new Set<string>()
  for (const assignment of cfg.assignments) {
    const identity = cfg.identities.find((entry) => entry.identityId === assignment.identityId)
    if (identity && ids.has(identity.botUserId)) problems.push('duplicate_repo_identity')
    if (identity) ids.add(identity.botUserId)
    if (managers.has(assignment.managerId)) problems.push('duplicate_repo_manager')
    managers.add(assignment.managerId)
    if (!identity || !routeManagerMatches(manager(assignment.managerId), repo))
      problems.push('route_target_invalid')
  }
  const labels = new Set<string>()
  for (const route of cfg.labelRoutes) {
    if (labels.has(route.labelId)) problems.push('duplicate_label_route')
    labels.add(route.labelId)
    if (!managers.has(route.managerId)) problems.push('route_target_invalid')
  }
  return [...new Set(problems)]
}
// 结构与 B 的 lookupGithubRole 结果相同；组装时绑定每个源自己的 API。
export type RoleLookupResult =
  | { state: 'verified'; eligible: boolean; roleName: string; baseRole?: ExternalRole }
  | { state: 'identity-mismatch' }
  | { state: 'unavailable'; reason: string; retryAt?: number }

export type RoleLookup = (
  sourceId: string,
  repo: ExternalRepo,
  actor: { userId: string; login: string },
) => Promise<RoleLookupResult>

const ROLES: readonly ExternalRole[] = ['read', 'triage', 'write', 'maintain', 'admin']

export async function checkRequester(
  source: ExternalSourceDraft,
  repo: ExternalRepo,
  actor: ExternalEvent['actorEvidence'],
  ownerId: string | undefined,
  config: ExternalRoutingConfig,
  lookupGithubRole: RoleLookup,
): Promise<
  | { role: ExternalRole | 'owner'; eligible: boolean }
  | { reason: 'actor_unverified' | 'actor_mismatch' | 'robot_action' }
  | { reason: 'role_unavailable'; failure: string; retryAt?: number }
> {
  if (!actor || !/^[1-9][0-9]*$/.test(actor.userId)) return { reason: 'actor_unverified' }
  if (isLocalBot(config, actor.userId)) return { reason: 'robot_action' }
  if (actor.userId === ownerId) return { role: 'owner', eligible: true }
  if (!actor.login) return { reason: 'actor_unverified' }
  const result = await lookupGithubRole(source.sourceId, repo, {
    userId: actor.userId,
    login: actor.login,
  })
  if (result.state === 'identity-mismatch') return { reason: 'actor_mismatch' }
  if (result.state === 'unavailable')
    return {
      reason: 'role_unavailable',
      failure: result.reason,
      ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
    }
  // 自定义角色只使用已证实的底层权限；B 只证明达到 triage 时不推断更高权限。
  const declared = ROLES.find((role) => role === result.roleName)
  const role = result.eligible ? (result.baseRole ?? declared ?? 'triage') : 'read'
  return { role, eligible: result.eligible && ROLES.indexOf(role) >= ROLES.indexOf(source.minRole) }
}
