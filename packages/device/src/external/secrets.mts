import { join } from 'node:path'
import type {
  ExternalCredential,
  ExternalDiagnostic,
} from '../../../protocol/src/external-sources.mjs'
import type { ExternalConfigResult, ExternalStore } from '../external-store.mjs'
import { managerNow } from '../manager-store.mjs'
import {
  digest,
  type GithubSender,
  GithubWriteFault,
  isFineGrainedToken,
  isGithubScopedToken,
  isManagedGithubToken,
  login,
  numericId,
  sendGithub,
} from './github/write-api.mjs'
import { ExternalPrivateFiles, privateName } from './secrets-files.mjs'
import {
  type GithubGhScope,
  type GithubOAuthProbe,
  probeGithubGhToken,
} from './secrets-oauth-probe.mjs'
import {
  type GithubResolvedRepository,
  listGithubCredentialRepoIds,
  probeGithubCredential,
  resolveGithubRepositories,
  type VerifiedGithubRepo,
} from './secrets-probe.mjs'

interface StoredSecret {
  token: string
  botLogin: string
  repos: VerifiedGithubRepo[]
  ownerConfirmedRevision?: number
}
export type GithubPublicCredential = ExternalCredential
export interface GithubCredentialSnapshot extends StoredSecret {
  metadata: GithubPublicCredential
}
export type CredentialResult = ExternalConfigResult<GithubPublicCredential> & {
  diagnostics: ExternalDiagnostic[]
}
type Mutation = { operationId: string; credentialRef: string; expectedGeneration: number }

export interface GithubDeviceIdentity {
  identityId: string
  botUserId: string
  login: string
  revision: number
  credentials: GithubPublicCredential[]
}
export interface GithubIdentityRepository extends GithubResolvedRepository {
  grants: Array<{
    identityId: string
    botUserId: string
    credentialRef: string
    read: boolean
    write: VerifiedGithubRepo['writeAccess']
  }>
}

function identityCredentialRef(botUserId: string, resourceOwnerId: string): string {
  return `gh-${digest(JSON.stringify([botUserId, resourceOwnerId])).slice(0, 40)}`
}
function credentialGrant(credential: ExternalCredential | null): GithubPublicCredential | null {
  return credential
}

export interface PreparedGithubGhAuthorization {
  // 此对象只在设备登录任务的内存中停留，不能直接做 RPC 投影。
  token: string
  ownerRevision: number
  previous: GithubPublicCredential | null
  probe: GithubOAuthProbe
}

/** 私有设备控制面调用 configure/rotate/revoke。读取快照只供设备适配器。 */
export class ExternalGithubSecrets {
  readonly directory: string
  private readonly files: ExternalPrivateFiles
  private readonly store: ExternalStore
  private readonly send: GithubSender
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readonly preparedGh = new WeakSet<PreparedGithubGhAuthorization>()
  constructor(
    store: ExternalStore,
    stateDirectory: string,
    options: {
      send?: GithubSender
      now?: () => number
    } = {},
  ) {
    this.store = store
    this.send = options.send ?? sendGithub
    this.now = options.now ?? managerNow
    this.files = new ExternalPrivateFiles(join(stateDirectory, 'external-credentials'))
    this.directory = this.files.directory
  }

  async configure(input: {
    operationId: string
    token: string
    repoIds?: string[]
    resourceOwnerId?: string
    signal?: AbortSignal
  }): Promise<CredentialResult> {
    this.checkMutation(input.operationId)
    const owner = this.store.config.owner('github')
    if (!owner) throw new GithubWriteFault('github_owner_not_configured')
    if (!isFineGrainedToken(input.token))
      throw new GithubWriteFault('github_fine_grained_pat_required')
    const send: GithubSender = (token, path, options) =>
      this.send(token, path, {
        ...options,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    const repoIds =
      input.repoIds ?? (await listGithubCredentialRepoIds(send, input.token, input.resourceOwnerId))
    const probe = await probeGithubCredential(send, input.token, owner.userId, repoIds)
    if (input.signal?.aborted) throw input.signal.reason
    if (input.resourceOwnerId && probe.resourceOwnerId !== input.resourceOwnerId)
      throw new GithubWriteFault('github_resource_owner_unverified')
    const credentialRef = identityCredentialRef(probe.botUserId, probe.resourceOwnerId)
    const current = this.store.config.credential(credentialRef)
    const prior = this.store.credentialRequest(credentialRef, input.operationId)
    if (prior) return { outcome: 'applied', record: prior, diagnostics: probe.diagnostics }
    if (current && current.state !== 'revoked')
      return { outcome: 'conflict', record: current, diagnostics: [] }
    return this.commit(
      {
        operationId: input.operationId,
        token: input.token,
        credentialRef,
        expectedGeneration: current?.generation ?? 0,
      },
      probe,
      owner.revision,
      current,
    )
  }

  rotate(input: Mutation & { token: string }): Promise<CredentialResult> {
    this.checkMutation(input.operationId, input.credentialRef)
    return this.save(input)
  }

  async prepareGhAuthorization(
    token: string,
    scopes: readonly GithubGhScope[],
    signal?: AbortSignal,
  ) {
    const owner = this.store.config.owner('github')
    if (!owner) throw new GithubWriteFault('github_owner_not_configured')
    const probe = await probeGithubGhToken(this.send, token, owner.userId, scopes, signal)
    if (signal?.aborted) throw new GithubWriteFault('github_gh_login_canceled')
    const ref = identityCredentialRef(probe.botUserId, 'oauth')
    const prepared = {
      token,
      ownerRevision: owner.revision,
      previous: this.store.config.credential(ref),
      probe,
    }
    this.preparedGh.add(prepared)
    return prepared
  }

  commitGhAuthorization(
    prepared: PreparedGithubGhAuthorization,
    operationId: string,
    confirmOwner = false,
  ) {
    this.checkMutation(operationId)
    if (!this.preparedGh.delete(prepared))
      throw new GithubWriteFault('github_gh_authorization_not_current')
    const { token, ownerRevision, previous, probe } = prepared
    if (probe.isOwner && !confirmOwner)
      throw new GithubWriteFault('github_gh_owner_confirmation_required')
    const credentialRef = identityCredentialRef(probe.botUserId, 'oauth')
    const result = this.commit(
      { token, credentialRef, operationId, expectedGeneration: previous?.generation ?? 0 },
      probe,
      ownerRevision,
      previous,
      {
        credentialKind: 'oauth',
        scopes: probe.scopes,
        ...(probe.isOwner ? { ownerConfirmedRevision: ownerRevision } : {}),
      },
    )
    if (result.outcome !== 'applied')
      throw new GithubWriteFault('github_credential_generation_changed')
    return this.identity(result.record.botUserId)
  }

  async addIdentity(input: { operationId: string; token: string; signal?: AbortSignal }) {
    const result = await this.configure(input)
    if (result.outcome !== 'applied')
      throw new GithubWriteFault('github_identity_credential_already_exists')
    return { identity: this.identity(result.record.botUserId) }
  }

  credentialWasWrittenBy(credentialRef: string, operationId: string): boolean {
    const current = this.store.config.credential(credentialRef)
    return (
      current?.state === 'active' &&
      this.store.credentialRequest(credentialRef, operationId)?.generation === current.generation
    )
  }

  async rotateIdentityCredential(input: Mutation & { identityId: string; token: string }) {
    this.checkIdentityCredential(input.identityId, input.credentialRef)
    const result = await this.rotate(input)
    if (result.outcome !== 'applied')
      throw new GithubWriteFault('github_credential_generation_changed')
    return { identity: this.identity(input.identityId) }
  }

  revokeIdentityCredential(input: Mutation & { identityId: string }) {
    this.checkIdentityCredential(input.identityId, input.credentialRef)
    const result = this.revoke(input)
    if (result.outcome !== 'applied')
      throw new GithubWriteFault('github_credential_generation_changed')
    return { identity: this.identity(input.identityId) }
  }

  private checkIdentityCredential(identityId: string, credentialRef: string): void {
    if (
      !numericId(identityId) ||
      this.store.config.credential(credentialRef)?.botUserId !== identityId
    )
      throw new GithubWriteFault('github_identity_credential_not_found')
  }

  /** 设置预览可用临时 PAT 探查，不保存；使用已绑定引用时不扩大已核验仓库列表。 */
  async resolveRepositories(
    input: { repositories: string[] } & ({ token: string } | { credentialRef: string }),
  ) {
    const snapshot = 'credentialRef' in input ? this.active(input.credentialRef) : undefined
    const token = 'token' in input ? input.token : snapshot?.token
    if (!isManagedGithubToken(token) || (!snapshot && !isFineGrainedToken(token)))
      throw new GithubWriteFault('github_fine_grained_pat_required')
    const beforeDispatch = () => {
      if (snapshot && !this.isCurrent(snapshot.metadata))
        throw new GithubWriteFault('github_credential_generation_changed')
    }
    const result = await resolveGithubRepositories(
      async (path) => {
        try {
          return await this.send(token, path, { beforeDispatch })
        } catch (error) {
          if (snapshot) this.invalidate(snapshot.metadata, error)
          throw error
        }
      },
      input.repositories,
      snapshot ? new Set(snapshot.repos.map((repo) => repo.repoId)) : undefined,
      snapshot?.metadata.credentialKind === 'oauth',
    )
    beforeDispatch()
    if (
      (snapshot?.metadata.credentialKind !== 'oauth' &&
        result.botUserId === this.store.config.owner('github')?.userId) ||
      (snapshot && result.botUserId !== snapshot.metadata.botUserId)
    )
      throw new GithubWriteFault('github_dedicated_bot_required')
    return result
  }

  private async save(
    input: Mutation & { token: string; repoIds?: string[] },
  ): Promise<CredentialResult> {
    const { operationId, credentialRef, expectedGeneration, token } = input
    const replay = this.store.credentialRequest(credentialRef, operationId)
    if (replay) return { outcome: 'applied', record: replay, diagnostics: [] }
    const previous = this.store.config.credential(credentialRef)
    if (
      (previous?.generation ?? 0) !== expectedGeneration ||
      (!input.repoIds && (!previous || previous.state === 'revoked'))
    )
      return { outcome: 'conflict', record: previous, diagnostics: [] }
    if (credentialGrant(previous)?.credentialKind === 'oauth')
      throw new GithubWriteFault('github_gh_reauthorize_required')
    if (!isFineGrainedToken(token)) throw new GithubWriteFault('github_fine_grained_pat_required')
    const owner = this.store.config.owner('github')
    if (!owner) throw new GithubWriteFault('github_owner_not_configured')
    const repoIds =
      input.repoIds ??
      (await listGithubCredentialRepoIds(this.send, token, previous?.resourceOwnerId))
    const probe = await probeGithubCredential(this.send, token, owner.userId, repoIds)
    if (
      previous &&
      (previous.botUserId !== probe.botUserId || previous.resourceOwnerId !== probe.resourceOwnerId)
    )
      throw new GithubWriteFault('github_rotation_identity_changed')
    return this.commit(input, probe, owner.revision, previous)
  }

  private commit(
    input: Mutation & { token: string },
    probe: Awaited<ReturnType<typeof probeGithubCredential>>,
    ownerRevision: number,
    previous: GithubPublicCredential | null,
    grant: {
      credentialKind: 'fine_grained' | 'oauth'
      scopes?: string[]
      ownerConfirmedRevision?: number
    } = {
      credentialKind: 'fine_grained',
    },
  ): CredentialResult {
    const { operationId, credentialRef, token, expectedGeneration } = input
    const at = this.now()
    if (probe.expiresAt !== undefined && probe.expiresAt <= at)
      throw new GithubWriteFault('github_credential_expired')
    const repeated = this.store.credentialRequest(credentialRef, operationId)
    if (repeated) return { outcome: 'applied', record: repeated, diagnostics: probe.diagnostics }
    const current = this.store.config.credential(credentialRef)
    if (
      (current?.generation ?? 0) !== expectedGeneration ||
      this.store.config.owner('github')?.revision !== ownerRevision
    )
      return { outcome: 'conflict', record: current, diagnostics: [] }
    const record: GithubPublicCredential = {
      credentialRef,
      provider: 'github',
      botUserId: probe.botUserId,
      resourceOwnerId: probe.resourceOwnerId,
      createdAt: previous?.createdAt ?? at,
      lastVerifiedAt: at,
      state: 'active',
      generation: expectedGeneration + 1,
      credentialKind: grant.credentialKind,
      ...(grant.scopes ? { scopes: grant.scopes } : {}),
      ...(probe.expiresAt === undefined ? {} : { expiresAt: probe.expiresAt }),
    }
    const key = this.fileKey(record)
    // 探针完成后不再让出执行；原子文件落盘后才切换数据库活动代。
    this.files.write(
      key,
      JSON.stringify({
        token,
        botLogin: probe.botLogin,
        repos: probe.repos,
        ...(grant.ownerConfirmedRevision !== undefined
          ? { ownerConfirmedRevision: grant.ownerConfirmedRevision }
          : {}),
      } satisfies StoredSecret),
    )
    let result: ExternalConfigResult<GithubPublicCredential>
    try {
      result = this.store.transaction(() => {
        const saved = this.store.config.saveCredential(record, expectedGeneration, operationId)
        if (saved.outcome === 'applied') {
          this.store.setExternalCredentialGrant(
            credentialRef,
            operationId,
            grant.credentialKind,
            grant.scopes,
          )
          this.store.recordExternalIdentityChange(record.botUserId, probe.botLogin)
          return { outcome: 'applied', record } as const
        }
        return saved
      })
    } catch {
      // 文件没有数据库引用；下次清理，避免覆盖已经提交但调用者未收到的记录。
      throw new GithubWriteFault('github_credential_commit_failed')
    }
    if (result.outcome === 'applied') this.notify()
    const cleaned = result.outcome === 'applied' && this.cleanup(credentialRef, key)
    return {
      ...result,
      diagnostics: [...probe.diagnostics, ...(!cleaned ? [this.cleanupDiagnostic()] : [])],
    }
  }

  identities(): GithubDeviceIdentity[] {
    const grouped = new Map<string, GithubDeviceIdentity>()
    for (const credential of this.store.externalCredentials()) {
      let identity = grouped.get(credential.botUserId)
      if (!identity) {
        const profile = this.store.externalIdentityProfile(credential.botUserId)
        if (!profile) continue
        identity = {
          identityId: credential.botUserId,
          botUserId: credential.botUserId,
          ...profile,
          credentials: [],
        }
        grouped.set(credential.botUserId, identity)
      }
      identity.credentials.push(credential)
    }
    return [...grouped.values()]
  }

  identity(identityId: string): GithubDeviceIdentity {
    const identity = this.identities().find((entry) => entry.identityId === identityId)
    if (!identity) throw new GithubWriteFault('github_identity_not_found')
    return identity
  }

  repositories(
    input: { identityId?: string; repoId?: string; cursor?: string; limit?: number } = {},
  ) {
    const byId = new Map<string, GithubIdentityRepository>()
    for (const credential of this.store.externalCredentials()) {
      if (input.identityId !== undefined && input.identityId !== credential.botUserId) continue
      let snapshot: GithubCredentialSnapshot
      try {
        snapshot = this.active(credential.credentialRef)
      } catch {
        continue
      }
      for (const {
        writeAccess,
        feedbackWriteAccess: _feedbackWriteAccess,
        resourceOwnerId: _resourceOwnerId,
        ...repo
      } of snapshot.repos) {
        const existing = byId.get(repo.repoId) ?? { ...repo, grants: [] }
        existing.grants.push({
          identityId: credential.botUserId,
          botUserId: credential.botUserId,
          credentialRef: credential.credentialRef,
          read: true,
          write: writeAccess,
        })
        byId.set(repo.repoId, existing)
      }
    }
    const readCursor =
      input.cursor && /^[A-Za-z0-9_-]{1,128}$/.test(input.cursor)
        ? Buffer.from(input.cursor, 'base64url').toString('utf8')
        : ''
    const after = /^repo-v1:([1-9]\d{0,30})$/.exec(readCursor)?.[1]
    if (input.cursor !== undefined && !after)
      throw new GithubWriteFault('github_repository_cursor_invalid')
    const all = [...byId.values()]
      .sort((a, b) => a.repoId.localeCompare(b.repoId))
      .filter(
        (repo) =>
          (!input.repoId || repo.repoId === input.repoId) &&
          (!after || repo.repoId.localeCompare(after) > 0),
      )
    const limit = Number.isSafeInteger(input.limit)
      ? Math.max(1, Math.min(100, input.limit ?? 50))
      : 50
    const repositories = all.slice(0, limit)
    const next = all.length > limit ? repositories.at(-1)?.repoId : undefined
    return {
      repositories,
      nextCursor: next ? Buffer.from(`repo-v1:${next}`).toString('base64url') : null,
    }
  }

  botUserIds(): ReadonlySet<string> {
    return new Set(this.store.externalCredentials().map((credential) => credential.botUserId))
  }

  activeForRepository(repoId: string, identityId?: string): GithubCredentialSnapshot {
    const entries = this.store
      .externalCredentials()
      .sort(
        (a, b) =>
          Number(credentialGrant(a)?.credentialKind === 'oauth') -
          Number(credentialGrant(b)?.credentialKind === 'oauth'),
      )
    for (const credential of entries) {
      if (identityId !== undefined && credential.botUserId !== identityId) continue
      try {
        return this.active(credential.credentialRef, repoId)
      } catch {
        /* 继续查其他所有者或身份。 */
      }
    }
    throw new GithubWriteFault('github_repository_outside_credential')
  }

  feedbackWriteMissing(
    snapshot: GithubCredentialSnapshot,
    repoId: string,
    kind: 'issue' | 'pull_request',
  ): boolean {
    if (snapshot.repos.find((repo) => repo.repoId === repoId)?.feedbackWriteAccess === 'missing')
      return true
    const at = this.store.githubFeedbackPermissionFailure(
      this.feedbackPermissionScope(snapshot, repoId, kind),
    )
    return at !== null && this.now() < at + 3600
  }

  noteFeedbackWriteDenied(
    snapshot: GithubCredentialSnapshot,
    repoId: string,
    kind: 'issue' | 'pull_request',
  ): void {
    if (this.isCurrent(snapshot.metadata))
      this.store.noteGithubFeedbackPermissionFailure(
        this.feedbackPermissionScope(snapshot, repoId, kind),
        this.now(),
      )
  }

  private feedbackPermissionScope(
    snapshot: GithubCredentialSnapshot,
    repoId: string,
    kind: 'issue' | 'pull_request',
  ) {
    return `${snapshot.metadata.credentialRef}/${snapshot.metadata.generation}/${repoId}/${kind}`
  }

  revoke(input: Mutation): CredentialResult {
    const { operationId, credentialRef, expectedGeneration } = input
    this.checkMutation(operationId, credentialRef)
    const repeated = this.store.credentialRequest(credentialRef, operationId)
    const before = credentialGrant(this.store.config.credential(credentialRef))
    if (repeated) {
      if (repeated.state !== 'revoked')
        return { outcome: 'conflict', record: before, diagnostics: [] }
      this.notify()
      const cleaned = before?.state !== 'revoked' || this.cleanup(credentialRef)
      return {
        outcome: 'applied',
        record: repeated,
        diagnostics: cleaned ? [] : [this.cleanupDiagnostic()],
      }
    }
    if (!before || before.generation !== expectedGeneration)
      return { outcome: 'conflict', record: before, diagnostics: [] }
    const result = this.store.transaction(() => {
      const saved = this.store.config.saveCredential(
        { ...before, state: 'revoked', generation: before.generation + 1 },
        expectedGeneration,
        operationId,
      )
      if (saved.outcome === 'applied') {
        if (before.credentialKind)
          this.store.setExternalCredentialGrant(
            credentialRef,
            operationId,
            before.credentialKind,
            before.scopes,
          )
        this.store.recordExternalIdentityChange(before.botUserId)
        const record = this.store.credentialRequest(credentialRef, operationId) ?? saved.record
        return { outcome: 'applied' as const, record }
      }
      return saved
    })
    if (result.outcome === 'applied') this.notify()
    const cleaned = result.outcome !== 'applied' || this.cleanup(credentialRef)
    return { ...result, diagnostics: cleaned ? [] : [this.cleanupDiagnostic()] }
  }

  active(credentialRef: string, repoId?: string): GithubCredentialSnapshot {
    const metadata = this.store.config.credential(credentialRef)
    if (!metadata || !this.isCurrent(metadata))
      throw new GithubWriteFault('github_credential_unavailable')
    const stored = this.readStored(metadata)
    if (repoId && !stored.repos.some((repo) => repo.repoId === repoId))
      throw new GithubWriteFault('github_repository_outside_credential')
    return { ...stored, metadata }
  }

  isCurrent(snapshot: ExternalCredential): boolean {
    const current = credentialGrant(this.store.config.credential(snapshot.credentialRef))
    const owner = this.store.config.owner('github')
    if (
      current?.generation !== snapshot.generation ||
      current?.state !== 'active' ||
      (current.expiresAt !== undefined && current.expiresAt <= this.now()) ||
      !owner
    )
      return false
    if (owner.userId !== current.botUserId) return true
    if (current.credentialKind !== 'oauth') return false
    try {
      return this.readStored(current).ownerConfirmedRevision === owner.revision
    } catch {
      return false
    }
  }

  /** 只有平台明确拒绝此令牌或指出组织审批时才能使该代断用。 */
  invalidate(snapshot: ExternalCredential, error: unknown): void {
    if (
      error instanceof GithubWriteFault &&
      ['github_credential_invalid', 'github_organization_approval_required'].includes(error.code)
    ) {
      this.store.invalidateExternalCredential(
        snapshot.credentialRef,
        snapshot.generation,
        this.now(),
        error.code,
      )
      this.notify()
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* 代次已提交；回调取用仍会检查最新代次。 */
      }
    }
  }

  /** 重启后清理未提交代、旧代和已撤销文件。不会删除当前活动代。 */
  sweep(): void {
    for (const key of this.files.keys()) {
      const match = /^credential-(gh-[a-f\d]{40})-([1-9][\d]*)$/.exec(key)
      const ref = match?.[1]
      const metadata = ref ? this.store.config.credential(ref) : null
      if (
        key.startsWith('temporary-') ||
        (ref &&
          (!metadata || metadata.state === 'revoked' || String(metadata.generation) !== match?.[2]))
      )
        this.files.remove(key)
    }
  }

  private fileKey(record: ExternalCredential): string {
    return `credential-${record.credentialRef}-${record.generation}`
  }

  private readStored(record: ExternalCredential): StoredSecret {
    try {
      const contents = this.files.read(this.fileKey(record))
      if (!contents) throw new Error()
      const stored = JSON.parse(contents) as StoredSecret
      if (
        !(credentialGrant(record)?.credentialKind === 'oauth'
          ? isGithubScopedToken(stored.token)
          : isFineGrainedToken(stored.token)) ||
        !login(stored.botLogin) ||
        !Array.isArray(stored.repos)
      )
        throw new Error()
      return stored
    } catch {
      throw new GithubWriteFault('github_credential_unavailable')
    }
  }

  private cleanup(ref: string, keep?: string): boolean {
    try {
      for (const key of this.files.keys()) {
        if (key.startsWith(`credential-${ref}-`) && key !== keep) this.files.remove(key)
      }
      return true
    } catch {
      return false
    }
  }

  private cleanupDiagnostic(): ExternalDiagnostic {
    return { check: 'credential_cleanup', state: 'blocked', code: 'github_local_cleanup_required' }
  }

  private checkMutation(operationId: string, ref?: string): void {
    if (
      !privateName(operationId) ||
      isManagedGithubToken(operationId) ||
      (ref !== undefined && !/^gh-[a-f\d]{40}$/.test(ref))
    )
      throw new GithubWriteFault('github_credential_operation_invalid')
  }
}
