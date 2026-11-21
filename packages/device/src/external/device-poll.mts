// 轮询、分类与回写分开排队；一个慢仓库不阻塞其他经理的投递。
import type {
  ExternalDiagnostic,
  ExternalSource,
  ExternalSourceStatus,
} from '../../../protocol/src/external-sources.mjs'
import type { ExternalStore } from '../external-store.mjs'
import { pollGithubRepository, SqliteGithubPollStore } from './github/poll.mjs'
import { pollGithubNotifications } from './github/poll-notifications.mjs'
import {
  createGithubApi,
  type GithubApi,
  GithubFault,
  githubApiForLoopbackTest,
  verifyGithubRepository,
} from './github/read-api.mjs'
import { GithubWriteFault } from './github/write-api.mjs'
import { boundIssue, isTerminalIssue } from './intake.mjs'
import { createGithubExternalVerification } from './mandate-github.mjs'
import type { ExternalGithubSecrets, GithubCredentialSnapshot } from './secrets.mjs'

type PollStatus = Pick<
  NonNullable<ExternalSourceStatus['runtime']>,
  'state' | 'lastAttemptAt' | 'lastSuccessAt' | 'nextAttemptAt' | 'credentialState'
>

export class DeviceGithubPoll {
  readonly poll: SqliteGithubPollStore
  readonly verification: ReturnType<typeof createGithubExternalVerification>
  private readonly clients = new Map<string, { generation: number; api: GithubApi }>()
  private readonly controller = new AbortController()
  private readonly state = new Map<string, PollStatus>()
  private readonly resumed = new Set<string>()
  private readonly notificationState = new Map<
    string,
    { next: number; diagnostics: ExternalDiagnostic[] }
  >()
  private readonly nextReconcile = new Map<string, number>()

  private readonly options: {
    store: ExternalStore
    secrets: ExternalGithubSecrets
    now: () => number
    changed(): void
    loopbackFixture?: string
  }
  constructor(options: DeviceGithubPoll['options']) {
    this.options = options
    this.poll = new SqliteGithubPollStore(options.store, () => options.now() * 1000)
    // 只为已有来源建立新流的起点；旧流的完整水位和续页不迁移。
    options.store.transaction(() => {
      for (const source of options.store.config.sources()) {
        const repo = source.repos[0]
        if (!repo) continue
        const key = {
          sourceId: source.sourceId,
          repoId: repo.repoId,
          stream: 'github:notifications',
        }
        if (options.store.pollCheckpoint(key.sourceId, key.repoId, key.stream, 'floor', 'state'))
          continue
        const covered = options.store
          .cursors(source.sourceId)
          .filter((one) => one.repoId === repo.repoId && !one.stream.startsWith('notifications:'))
          .flatMap((one) => (one.coveredThrough === null ? [] : [one.coveredThrough]))
        options.store.writePollCheckpoints(key, [
          {
            bucket: 'floor',
            key: 'state',
            value: {
              at: Math.max(source.createdAt, covered.length ? Math.max(...covered) : options.now()),
            },
          },
        ])
      }
    })
    this.verification = createGithubExternalVerification(
      async (source) => this.apiFor(source),
      (id) => this.options.store.config.source(id),
    )
  }

  status(source: ExternalSource): PollStatus {
    return this.state.get(source.sourceId) ?? { state: source.enabled ? 'collecting' : 'paused' }
  }

  due(source: ExternalSource): boolean {
    return (this.status(source).nextAttemptAt ?? 0) <= this.options.now()
  }

  private notificationIdentities(source: ExternalSource): string[] {
    const { store } = this.options
    const repo = source.repos[0]
    return repo && source.enabled
      ? [
          ...new Set(
            store.config
              .assignments()
              .flatMap(({ identityId, managerId, repoIds }) =>
                identityId &&
                repoIds.includes(repo.repoId) &&
                store.manager.manager(managerId)?.status === 'active'
                  ? [identityId]
                  : [],
              ),
          ),
        ]
      : []
  }

  notificationsDue(source: ExternalSource): boolean {
    return (
      (this.notificationState.get(source.sourceId)?.next ?? 0) <= this.options.now() &&
      this.notificationIdentities(source).length > 0
    )
  }

  notificationDiagnostics(source: ExternalSource): ExternalDiagnostic[] {
    const state = this.notificationState.get(source.sourceId)
    const repo = source.repos[0]
    if (!repo || !source.enabled) return []
    return this.notificationIdentities(source).map((identity) => {
      const recent = state?.diagnostics.find(({ check }) => check === `notifications:${identity}`)
      if (recent) return recent
      return this.options.secrets.notificationCredential(repo.repoId, identity)
        ? this.notificationDiagnostic(identity, 'unverified', 'github_notifications_unverified')
        : this.notificationDiagnostic(
            identity,
            'blocked',
            this.notificationCredentialProblem(identity),
          )
    })
  }

  private notificationDiagnostic(
    identity: string,
    state: ExternalDiagnostic['state'],
    code: string,
    checkedAt?: number,
  ): ExternalDiagnostic {
    return { check: `notifications:${identity}`, state, code, ...(checkedAt ? { checkedAt } : {}) }
  }

  private notificationCredentialProblem(identity: string): string {
    return this.options.secrets.hasNotificationScope(identity)
      ? 'github_notifications_access_denied'
      : 'github_notifications_scope_required'
  }

  private floor(source: ExternalSource, repoId: string): number {
    const checkpoint = this.options.store.pollCheckpoint<{ at: number }>(
      source.sourceId,
      repoId,
      'github:notifications',
      'floor',
      'state',
    )
    return Math.max(source.createdAt, checkpoint?.at ?? source.createdAt) * 1000
  }

  async collectNotifications(source: ExternalSource): Promise<void> {
    const repo = source.repos[0]
    if (!source.enabled || !repo) return
    const { store, secrets, now } = this.options
    const at = now()
    const next = {
      next: at + source.interval,
      diagnostics: this.notificationDiagnostics(source),
    }
    this.notificationState.set(source.sourceId, next)
    const scope = { sourceId: source.sourceId, repoId: repo.repoId }
    const enabledAt = this.floor(source, repo.repoId)
    const boundNumbers = new Set(
      store.refsForRepo(repo.repoId).flatMap((ref) => {
        const issue = boundIssue(store, ref.managerId, ref.issueId)
        return issue?.followUp.state === 'on' && !isTerminalIssue(issue) ? [Number(ref.number)] : []
      }),
    )
    const botIds = secrets.botUserIds()
    await Promise.all(
      this.notificationIdentities(source).map(async (identity) => {
        const snapshot = secrets.notificationCredential(repo.repoId, identity)
        if (!snapshot) return { identity, code: this.notificationCredentialProblem(identity) }
        const api = this.scoped(source, this.forCredential(snapshot))
        const assigned = store.pollCheckpoint<{ at: number }>(
          source.sourceId,
          repo.repoId,
          'github:notifications',
          'assigned',
          identity,
        )
        const cursor = await pollGithubNotifications({
          api,
          repo,
          scope,
          store: this.poll,
          botIds,
          boundNumbers,
          bot: { userId: snapshot.metadata.botUserId, login: snapshot.botLogin },
          enabledAt: Math.max(enabledAt, (assigned?.at ?? 0) * 1000),
          interval: source.interval * 1000,
        })
        const fault = cursor.fault?.kind
        return {
          identity,
          code:
            fault === 'primary-rate' || fault === 'secondary-rate'
              ? 'github_notifications_rate_limited'
              : fault === 'permission' ||
                  fault === 'authentication' ||
                  fault === 'organization-approval'
                ? 'github_notifications_access_denied'
                : fault
                  ? 'github_notifications_unavailable'
                  : 'github_notifications_ready',
          next: Math.ceil(Math.max(cursor.nextPollAt ?? 0, cursor.fault?.retryAt ?? 0) / 1000),
        }
      }),
    ).then((results) => {
      next.diagnostics = results.map(({ identity, code }) =>
        this.notificationDiagnostic(
          identity,
          code === 'github_notifications_ready' ? 'ok' : 'blocked',
          code,
          at,
        ),
      )
      next.next = Math.min(...results.map((row) => row.next ?? at + source.interval))
    })
  }

  reset(): void {
    this.nextReconcile.clear()
    this.notificationState.clear()
    for (const state of this.state.values()) delete state.nextAttemptAt
    for (const [ref, client] of this.clients) {
      const current = this.options.store.config.credential(ref)
      if (current?.state !== 'active' || current.generation !== client.generation)
        this.clients.delete(ref)
    }
  }

  close(): void {
    this.controller.abort()
    this.clients.clear()
  }

  resume(sourceId: string): void {
    this.resumed.add(sourceId)
    this.nextReconcile.delete(sourceId)
    this.notificationState.delete(sourceId)
    const state = this.state.get(sourceId)
    if (state) delete state.nextAttemptAt
  }

  async check(source: ExternalSource): Promise<number> {
    const [repo] = source.repos
    if (!repo) throw new GithubWriteFault('github_repository_outside_credential')
    return Math.floor((await verifyGithubRepository(this.apiFor(source), repo)).serverTime / 1000)
  }

  apiFor(source: ExternalSource): GithubApi {
    const repo = source.repos[0]
    if (!repo) throw new GithubWriteFault('github_repository_outside_credential')
    const api = this.forCredential(
      this.options.secrets.activeForRepository(repo.repoId, repo.pollIdentity ?? undefined),
    )
    return source.revision > 0 ? this.scoped(source, api) : api
  }

  private scoped(source: ExternalSource, api: GithubApi): GithubApi {
    const assertCurrent = () => {
      const current = this.options.store.config.source(source.sourceId)
      if (!current?.enabled || current.revision !== source.revision)
        throw new GithubFault('disabled')
    }
    return {
      ...api,
      get: async (path, etag, modifiedSince) => {
        assertCurrent()
        const result = await api.get(path, etag, modifiedSince)
        assertCurrent()
        return result
      },
    }
  }

  private forCredential(snapshot: GithubCredentialSnapshot): GithubApi {
    const { generation, credentialRef } = snapshot.metadata
    const existing = this.clients.get(credentialRef)
    if (existing?.generation === generation) return existing.api
    const params = {
      token: snapshot.token,
      generation: `${credentialRef}/${generation}`,
      now: () => this.options.now() * 1000,
      signal: this.controller.signal,
    }
    const client = this.options.loopbackFixture
      ? githubApiForLoopbackTest(this.options.loopbackFixture, params)
      : createGithubApi(params)
    const api: GithubApi = {
      ...client,
      get: async (path, etag, modifiedSince) => {
        if (!this.options.secrets.isCurrent(snapshot.metadata))
          throw new GithubFault('authentication')
        try {
          return await client.get(path, etag, modifiedSince)
        } catch (error) {
          if (error instanceof GithubFault && error.kind === 'authentication')
            this.options.secrets.invalidate(
              snapshot.metadata,
              new GithubWriteFault('github_credential_invalid'),
            )
          if (error instanceof GithubFault && error.kind === 'organization-approval')
            this.options.secrets.invalidate(
              snapshot.metadata,
              new GithubWriteFault('github_organization_approval_required'),
            )
          throw error
        }
      },
    }
    this.clients.set(credentialRef, { generation, api })
    return api
  }

  async collect(source: ExternalSource): Promise<void> {
    const { sourceId, createdAt, interval, enabled } = source
    const repo = source.repos[0]
    if (!enabled || !repo) return
    const { store, secrets, now, changed } = this.options
    const start = now()
    const current = {
      ...this.status(source),
      lastAttemptAt: start,
      nextAttemptAt: start + interval,
    }
    this.state.set(sourceId, current)
    try {
      const credential = secrets.activeForRepository(repo.repoId, repo.pollIdentity ?? undefined)
      if (store.config.reconcilePollIdentity(source, credential.metadata)) changed()
      const api = this.scoped(source, this.forCredential(credential))
      const refs = store.refsForRepo(repo.repoId).flatMap((ref) => {
        const issue = boundIssue(store, ref.managerId, ref.issueId)
        const number = Number(ref.number)
        return Number.isSafeInteger(number) &&
          issue?.followUp.state === 'on' &&
          !isTerminalIssue(issue)
          ? [{ number, pull: ref.kind === 'pull_request', since: ref.createdAt * 1000 }]
          : []
      })
      const boundPulls = refs.filter(({ pull }) => pull)
      const lastChecked = (number: number) =>
        store.cursor(sourceId, repo.repoId, `subject-comments:${number}`)?.checkedAt ?? 0
      const boundSubjects = refs
        .sort((a, b) => lastChecked(a.number) - lastChecked(b.number) || a.number - b.number)
        .slice(0, 4)
      const reconcile = (this.nextReconcile.get(sourceId) ?? 0) <= start
      const diagnostics = this.notificationState.get(sourceId)?.diagnostics ?? []
      const notificationsReady =
        diagnostics.length > 0 && diagnostics.every(({ state }) => state === 'ok')
      if (reconcile && notificationsReady) this.nextReconcile.set(sourceId, start + 300)
      // 没有活跃绑定时，中间几轮只收通知，无需重复查身份和仓库。
      if (!reconcile && refs.length === 0) return
      const result = await pollGithubRepository({
        sourceId,
        repo,
        api,
        boundPulls,
        boundSubjects,
        reconcile,
        store: this.poll,
        botUserId: credential.metadata.botUserId,
        enabledAt: createdAt * 1000,
        newStreamAt: this.floor(source, repo.repoId),
        ...(this.resumed.delete(sourceId) ? { resume: true } : {}),
      })
      const fault = result.fault
      current.credentialState =
        store.config.credential(credential.metadata.credentialRef)?.state ?? 'invalid'
      current.state = fault ? (fault.paused ? 'blocked' : 'backoff') : 'collecting'
      if (!fault) current.lastSuccessAt = now()
      if (fault?.retryAt)
        current.nextAttemptAt = Math.max(current.nextAttemptAt, Math.ceil(fault.retryAt / 1000))
    } catch {
      current.state = 'blocked'
      current.credentialState = store.config.credential(source.credentialRef)?.state ?? 'invalid'
    }
  }
}
