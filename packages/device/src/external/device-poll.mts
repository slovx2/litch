// 轮询、分类与回写分开排队；一个慢仓库不阻塞其他经理的投递。
import type {
  ExternalSource,
  ExternalSourceStatus,
} from '../../../protocol/src/external-sources.mjs'
import type { ExternalStore } from '../external-store.mjs'
import { pollGithubRepository, SqliteGithubPollStore } from './github/poll.mjs'
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

  reset(): void {
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
      get: async (path, etag) => {
        assertCurrent()
        const result = await api.get(path, etag)
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
      get: async (path, etag) => {
        if (!this.options.secrets.isCurrent(snapshot.metadata))
          throw new GithubFault('authentication')
        try {
          return await client.get(path, etag)
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
      const boundPulls = store.refsForRepo(repo.repoId).flatMap((ref) => {
        const issue = boundIssue(store, ref.managerId, ref.issueId)
        const number = Number(ref.number)
        return ref.kind === 'pull_request' &&
          Number.isSafeInteger(number) &&
          issue?.followUp.state === 'on' &&
          !isTerminalIssue(issue)
          ? [{ number }]
          : []
      })
      const result = await pollGithubRepository({
        sourceId,
        repo,
        api,
        boundPulls,
        store: this.poll,
        botUserId: credential.metadata.botUserId,
        enabledAt: createdAt * 1000,
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
