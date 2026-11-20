// 显式绑定与可选的自动关联都以 GitHub 当前对象及唯一绑定为准。
import {
  type ExternalEvent,
  type ExternalIssueId,
  type ExternalRef,
  type ExternalRepo,
  type ExternalSource,
  type ExternalSubject,
  externalSubjectKey,
} from '../../../protocol/src/external-sources.mjs'
import type { ManagerIssue } from '../../../protocol/src/manager-issues.mjs'
import type { ExternalStore } from '../external-store.mjs'
import { invalid } from '../manager-validate.mjs'
import { issuedLink } from './intake.mjs'
import type { ExternalManagerTurn, ExternalMandateService } from './mandate.mjs'
import {
  type ExternalRoutingPolicy,
  isLocalBot,
  managerIdentity,
  repositoryRouting,
  routeManagerMatches,
} from './routing.mjs'

export interface ExternalLinkRequest {
  sourceId: string
  repoId: string
  number: string
  kind: ExternalSubject['kind']
  issueId: ExternalIssueId
  expectedIssueRevision: number
}
export interface InspectedExternalSubject {
  subject: ExternalSubject
  actorUserId?: string
  head?: { repoId: string; ref: string }
  agentMarked: boolean
  agentOperationIds?: readonly string[]
}
export interface ExternalLinkHost {
  now(): number
  configuration: ExternalRoutingPolicy
  inspectSubject(input: {
    source: ExternalSource
    repo: ExternalRepo
    number: string
    kind: ExternalSubject['kind']
  }): Promise<InspectedExternalSubject | null>
  /** 仅在用户配置开启后，匹配设备实际签发的标记或已登记的分支，不从正文解析任意 X-n。 */
  resolveAgentPr?(input: {
    source: ExternalSource
    repo: ExternalRepo
    proof: InspectedExternalSubject
  }): {
    managerId: string
    issueId: ExternalIssueId
    association: 'marker' | 'head'
  } | null
  onIssueChanged?(managerId: string, issueId: ExternalIssueId): void
}
type LinkResult =
  | { outcome: 'applied'; ref: ExternalRef }
  | { outcome: 'conflict'; reason: 'binding' | 'issue_revision'; ref?: ExternalRef }

export class ExternalLinkService {
  private readonly store: ExternalStore
  private readonly mandates: ExternalMandateService
  private readonly host: ExternalLinkHost
  constructor(store: ExternalStore, mandates: ExternalMandateService, host: ExternalLinkHost) {
    this.store = store
    this.mandates = mandates
    this.host = host
  }

  private async inspect(
    sourceId: string,
    repoId: string,
    number: string,
    kind: ExternalSubject['kind'],
  ) {
    const source = this.store.config.source(sourceId)
    const repo = source?.repos.find((repo) => repo.repoId === repoId)
    const credential = source && this.store.config.credential(source.credentialRef)
    const routing = repositoryRouting(this.host.configuration(), repoId)
    if (
      !source?.enabled ||
      !repo ||
      credential?.state !== 'active' ||
      credential.botUserId !== source.botUserId ||
      (credential.expiresAt !== undefined && credential.expiresAt <= this.host.now())
    )
      invalid('The external repository is outside an enabled source.')
    const proof = await this.host.inspectSubject({ source, repo, number, kind })
    const url = `https://github.com/${repo.owner}/${repo.name}/${kind === 'issue' ? 'issues' : 'pull'}/${number}`
    if (
      !proof ||
      proof.subject.provider !== 'github' ||
      proof.subject.kind !== kind ||
      proof.subject.repoId !== repoId ||
      proof.subject.number !== number ||
      proof.subject.url.toLowerCase() !== url.toLowerCase()
    )
      invalid('The external subject identity could not be verified.')
    return { source, repo, proof, generation: credential.generation, routing }
  }

  private current(
    ctx: Awaited<ReturnType<ExternalLinkService['inspect']>>,
    managerId: string,
  ): boolean {
    const credential = this.store.config.credential(ctx.source.credentialRef)
    return (
      this.store.config.source(ctx.source.sourceId)?.revision === ctx.source.revision &&
      credential?.generation === ctx.generation &&
      credential.state === 'active' &&
      (credential.expiresAt === undefined || credential.expiresAt > this.host.now()) &&
      this.host.configuration().revision === ctx.routing.revision &&
      !!managerIdentity(ctx.routing, managerId) &&
      routeManagerMatches(this.store.manager.manager(managerId), ctx.repo)
    )
  }

  private commit(
    managerId: string,
    issueId: ExternalIssueId,
    subject: ExternalSubject,
    actorId: string,
    revision?: number,
  ): LinkResult {
    const ref = this.store.ref(subject)
    if (ref)
      return {
        outcome: 'conflict',
        reason: 'binding',
        ...(ref.managerId === managerId ? { ref } : {}),
      }
    const issue = this.store.manager.issue(managerId, issueId) as ManagerIssue | null
    const meta = this.store.manager.issueMeta(managerId, issueId) as { revision?: number } | null
    if (
      !issue ||
      issue.kind !== 'ordinary' ||
      (revision !== undefined && issue.revision + (meta?.revision ?? 0) !== revision)
    )
      return { outcome: 'conflict', reason: 'issue_revision' }
    const at = this.host.now()
    const stored = this.store.bindRef({
      ...subject,
      managerId,
      issueId,
      origin: 'manual',
      createdAt: at,
    }).record
    const updated = { ...issue, revision: issue.revision + 1, updatedAt: at }
    this.store.manager.saveIssue(managerId, issueId, updated)
    this.store.manager.recordIssue(
      managerId,
      issueId,
      'manager',
      issue,
      updated,
      'Linked an external subject',
    )
    this.store.appendAudit({
      action: 'external_link',
      subject: externalSubjectKey(subject),
      actorId,
      managerId,
      issueId,
      at,
    })
    for (const row of this.store.agentPullInbox(subject)) {
      this.store.updateInboxEvent(row.eventKey, row.revision, {
        managerId,
        issueId,
        reason: 'agent_pr_bound',
      })
    }
    return { outcome: 'applied', ref: stored }
  }

  async link(turn: ExternalManagerTurn, request: ExternalLinkRequest): Promise<LinkResult> {
    const manager = this.mandates.requireManager(turn)
    const ctx = await this.inspect(request.sourceId, request.repoId, request.number, request.kind)
    const result = this.store.transaction(() => {
      this.mandates.requireManager(turn)
      if (!this.current(ctx, manager.id)) invalid('The source or manager scope changed.')
      return this.commit(
        manager.id,
        request.issueId,
        ctx.proof.subject,
        turn.threadId,
        request.expectedIssueRevision,
      )
    })
    if (result.outcome === 'applied') this.host.onIssueChanged?.(manager.id, request.issueId)
    return result
  }

  /** 可选路径：只关联观察到的机器人 PR；无证明时由收件箱保留手动绑定提示。 */
  async observeAgentPr(sourceId: string, event: ExternalEvent): Promise<boolean> {
    if (!this.host.resolveAgentPr || event.kind !== 'pull_request') return false
    const subject = event.targetEvidence.subject
    if (
      !isLocalBot(
        repositoryRouting(this.host.configuration(), subject.repoId),
        event.actorEvidence?.userId,
      ) ||
      this.store.ref(subject)
    )
      return false
    const ctx = await this.inspect(sourceId, subject.repoId, subject.number, 'pull_request')
    if (
      !issuedLink(ctx.repo, event) ||
      ctx.proof.actorUserId !== event.actorEvidence?.userId ||
      ctx.proof.head?.repoId !== ctx.repo.repoId
    )
      return false
    const target = this.host.resolveAgentPr({ ...ctx, proof: ctx.proof })
    if (
      !target ||
      managerIdentity(ctx.routing, target.managerId)?.botUserId !== ctx.proof.actorUserId ||
      (target.association === 'marker' && !ctx.proof.agentMarked) ||
      (target.association === 'head' && !ctx.proof.head.ref.startsWith(ctx.repo.headNamespace))
    )
      return false
    const result = this.store.transaction(() => {
      if (!this.current(ctx, target.managerId)) return null
      // 已受理依据必须覆盖同一个仓库。标记或分支只用来找目标，不授予处置权限。
      if (
        !this.store
          .refs(target.managerId, target.issueId)
          .some((ref) => ref.repoId === ctx.repo.repoId)
      )
        return null
      return this.commit(target.managerId, target.issueId, ctx.proof.subject, 'device')
    })
    if (result?.outcome !== 'applied') return false
    this.host.onIssueChanged?.(target.managerId, target.issueId)
    return true
  }
}
