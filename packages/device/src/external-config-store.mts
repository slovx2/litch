// 设备来源配置及公开凭据元数据；变更和审计共用经理库事务。
import type {
  ExternalCredential,
  ExternalManagerAssignment,
  ExternalOwner,
  ExternalOwnerIdentity,
  ExternalProvider,
  ExternalSource,
  ExternalSourceDraft,
} from '../../protocol/src/external-sources.mjs'
import type { ExternalConfigResult, ExternalStore } from './external-store.mjs'
import { decode, encode, requireExternalId, requireRow } from './external-store-internal.mjs'
import { managerNow } from './manager-store.mjs'

export class ExternalConfigStore {
  private readonly store: ExternalStore
  constructor(store: ExternalStore) {
    this.store = store
  }

  private get db() {
    return this.store.manager.db
  }

  revision(): number {
    return this.configRequest<{ revision: number }>('configuration', 'current')?.revision ?? 0
  }

  bump(): void {
    this.db
      .prepare(`INSERT INTO external_config_requests VALUES ('configuration','current',?)
      ON CONFLICT(scope,operation_id) DO UPDATE SET body=excluded.body`)
      .run(encode({ revision: this.revision() + 1 }))
  }

  assignments(): ExternalManagerAssignment[] {
    return this.db
      .prepare(`SELECT body FROM external_config_requests
      WHERE scope='assignment:current' ORDER BY operation_id`)
      .all()
      .map((row) => decode<ExternalManagerAssignment>(row))
  }

  assignment(managerId: string): ExternalManagerAssignment {
    return (
      this.configRequest<ExternalManagerAssignment>('assignment:current', managerId) ?? {
        managerId,
        identityId: null,
        repoIds: [],
        revision: 0,
      }
    )
  }

  saveAssignment(
    draft: Omit<ExternalManagerAssignment, 'revision'>,
    expectedRevision: number,
    operationId: string,
    validate: () => void,
  ): ExternalConfigResult<ExternalManagerAssignment> {
    return this.store.transaction(() => {
      const scope = `assignment:${draft.managerId}`
      const replay = this.configRequest<ExternalManagerAssignment>(scope, operationId)
      if (replay) return { outcome: 'applied', record: replay }
      const before = this.assignment(draft.managerId)
      if (before.revision !== expectedRevision) return { outcome: 'conflict', record: before }
      validate()
      const record = { ...draft, revision: expectedRevision + 1 }
      this.db
        .prepare(`INSERT INTO external_config_requests VALUES ('assignment:current',?,?)
        ON CONFLICT(scope,operation_id) DO UPDATE SET body=excluded.body`)
        .run(draft.managerId, encode(record))
      this.saveConfigRequest(scope, operationId, record)
      if (draft.identityId) {
        for (const repoId of draft.repoIds) {
          if (before.identityId === draft.identityId && before.repoIds.includes(repoId)) continue
          const source = this.db
            .prepare('SELECT source_id FROM external_repos WHERE repo_id=? LIMIT 1')
            .get(repoId)
          if (!source) continue
          this.store.writePollCheckpoints(
            { sourceId: String(source.source_id), repoId, stream: 'github:notifications' },
            [{ bucket: 'assigned', key: draft.identityId, value: { at: managerNow() } }],
          )
        }
      }
      this.bump()
      return { outcome: 'applied', record }
    })
  }

  owner(provider: ExternalProvider): ExternalOwner | null {
    return decode(this.db.prepare('SELECT body FROM external_owner WHERE provider=?').get(provider))
  }

  setOwner(
    identity: ExternalOwnerIdentity,
    configuredBy: string,
    expectedRevision: number,
    operationId: string,
  ): ExternalConfigResult<ExternalOwner> {
    return this.store.transaction(() => {
      requireExternalId(identity.userId)
      const scope = `owner:${identity.provider}`
      const before = this.owner(identity.provider)
      const request = this.configRequest<ExternalOwner>(scope, operationId)
      if (request) return { outcome: 'applied', record: request }
      if ((before?.revision ?? 0) !== expectedRevision)
        return { outcome: 'conflict', record: before }
      const record = {
        provider: identity.provider,
        userId: identity.userId,
        loginCache: identity.loginCache,
        profileUrl: identity.profileUrl,
        method: identity.method,
        configuredBy,
        revision: expectedRevision + 1,
      }
      this.db
        .prepare(
          'INSERT INTO external_owner VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET body=excluded.body',
        )
        .run(record.provider, encode(record))
      this.saveConfigRequest(scope, operationId, record)
      this.bump()
      this.store.appendAudit({
        subject: scope,
        action: 'owner_set',
        actorId: configuredBy,
        operationId,
        at: managerNow(),
      })
      return { outcome: 'applied', record }
    })
  }

  credential(credentialRef: string): ExternalCredential | null {
    return decode(
      this.db
        .prepare('SELECT body FROM external_credentials WHERE credential_ref=?')
        .get(credentialRef),
    )
  }

  saveCredential(
    credential: ExternalCredential,
    expectedGeneration: number,
    operationId: string,
  ): ExternalConfigResult<ExternalCredential> {
    return this.store.transaction(() => {
      requireExternalId(credential.botUserId)
      requireExternalId(credential.resourceOwnerId)
      const scope = `credential:${credential.credentialRef}`
      const replay = this.configRequest<ExternalCredential>(scope, operationId)
      if (replay) return { outcome: 'applied', record: replay }
      const before = this.credential(credential.credentialRef)
      if (
        (before?.generation ?? 0) !== expectedGeneration ||
        credential.generation !== expectedGeneration + 1
      )
        return { outcome: 'conflict', record: before }
      // 显式拣选公开元数据，调用者额外带进来的秘密不会落库。
      const {
        credentialRef,
        provider,
        botUserId,
        resourceOwnerId,
        createdAt,
        expiresAt,
        lastVerifiedAt,
        state,
        generation,
      } = credential
      const record = {
        credentialRef,
        provider,
        botUserId,
        resourceOwnerId,
        createdAt,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        lastVerifiedAt,
        state,
        generation,
        ...(credential.credentialKind === undefined
          ? {}
          : { credentialKind: credential.credentialKind }),
        ...(credential.scopes === undefined ? {} : { scopes: credential.scopes }),
      }
      this.db
        .prepare(
          'INSERT INTO external_credentials VALUES(?,?) ON CONFLICT(credential_ref) DO UPDATE SET body=excluded.body',
        )
        .run(credentialRef, encode(record))
      this.saveConfigRequest(scope, operationId, record)
      this.bump()
      this.store.appendAudit({
        at: managerNow(),
        subject: scope,
        action: 'credential_changed',
        operationId,
        state,
      })
      return {
        outcome: 'applied',
        record,
      }
    })
  }

  source(sourceId: string): ExternalSource | null {
    const source = decode<Omit<ExternalSource, 'repos' | 'routes'>>(
      this.db.prepare('SELECT body FROM external_sources WHERE source_id=?').get(sourceId),
    )
    if (!source) return null
    return {
      ...source,
      repos: this.db
        .prepare('SELECT body FROM external_repos WHERE source_id=? ORDER BY rowid')
        .all(sourceId)
        .map((row) => decode<ExternalSource['repos'][number]>(row)),
      routes: this.db
        .prepare('SELECT body FROM external_routes WHERE source_id=? ORDER BY rowid')
        .all(sourceId)
        .map((row) => decode<ExternalSource['routes'][number]>(row)),
    }
  }

  sources(): ExternalSource[] {
    return this.db
      .prepare('SELECT source_id FROM external_sources ORDER BY rowid')
      .all()
      .map((row) => requireRow(this.source(String(row.source_id))))
  }

  reconcilePollIdentity(source: ExternalSource, credential: ExternalCredential): boolean {
    if (
      source.credentialRef === credential.credentialRef &&
      source.botUserId === credential.botUserId
    )
      return false
    return this.store.transaction(() => {
      const current = this.source(source.sourceId)
      if (!current?.enabled || current.revision !== source.revision) return false
      this.db
        .prepare('UPDATE external_sources SET body=json_patch(body,?) WHERE source_id=?')
        .run(
          encode({ credentialRef: credential.credentialRef, botUserId: credential.botUserId }),
          source.sourceId,
        )
      this.bump()
      return true
    })
  }

  saveSource(
    draft: ExternalSourceDraft,
    expectedRevision: number,
    operationId: string,
    actorId: string,
    verifiedAt?: number,
  ): ExternalConfigResult<ExternalSource> {
    return this.store.transaction(() => {
      const scope = `source:${draft.sourceId}`
      const replay = this.configRequest<ExternalSource>(scope, operationId)
      if (replay) return { outcome: 'applied', record: replay }
      const before = this.source(draft.sourceId)
      if ((before?.revision ?? 0) !== expectedRevision)
        return { outcome: 'conflict', record: before }
      requireExternalId(draft.botUserId)
      for (const repo of draft.repos) requireExternalId(repo.repoId)
      if (draft.enabled) {
        for (const repo of draft.repos) {
          const other = this.db
            .prepare(
              'SELECT source_id FROM external_repos WHERE provider=? AND repo_id=? AND enabled=1 AND source_id<>?',
            )
            .get(draft.provider, repo.repoId, draft.sourceId)
          if (other) return { outcome: 'conflict', record: this.source(String(other.source_id)) }
        }
      }
      const revision = expectedRevision + 1
      const {
        sourceId,
        provider,
        enabled,
        credentialRef,
        botUserId,
        triggers,
        minRole,
        writePolicy,
        interval,
        repos,
        routes,
        unattended,
      } = draft
      const value = {
        sourceId,
        provider,
        enabled,
        credentialRef,
        botUserId,
        triggers,
        minRole,
        writePolicy,
        interval,
        ...(unattended === undefined ? {} : { unattended }),
        revision,
        rulesVersion: revision,
        createdAt: before?.createdAt ?? verifiedAt ?? managerNow(),
      }
      this.db
        .prepare(
          'INSERT INTO external_sources VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET body=excluded.body',
        )
        .run(sourceId, encode(value))
      this.db.prepare('DELETE FROM external_repos WHERE source_id=?').run(sourceId)
      this.db.prepare('DELETE FROM external_routes WHERE source_id=?').run(sourceId)
      for (const repo of repos)
        this.db
          .prepare('INSERT INTO external_repos VALUES(?,?,?,?,?)')
          .run(sourceId, repo.repoId, provider, enabled ? 1 : 0, encode(repo))
      if (enabled && !before?.enabled) {
        for (const { repoId } of repos) {
          const key = { sourceId, repoId, stream: 'github:notifications' }
          const hasWatermark = this.db
            .prepare('SELECT 1 FROM external_cursor WHERE source_id=? AND repo_id=? LIMIT 1')
            .get(sourceId, repoId)
          if (!hasWatermark)
            this.store.writePollCheckpoints(key, [
              {
                bucket: 'floor',
                key: 'state',
                value: { at: verifiedAt ?? managerNow() },
              },
            ])
        }
      }
      for (const route of routes)
        this.db
          .prepare('INSERT INTO external_routes VALUES(?,?,?)')
          .run(sourceId, route.routeId, encode(route))
      const record = { ...value, repos, routes }
      this.saveConfigRequest(scope, operationId, record)
      this.bump()
      this.store.appendAudit({
        at: managerNow(),
        subject: scope,
        action: 'source_changed',
        actorId,
        operationId,
        rulesVersion: revision,
      })
      return { outcome: 'applied', record }
    })
  }

  /** 配置请求回执也是规则版本快照。 */
  private configRequest<T>(scope: string, operationId: string): T | null {
    return decode(
      this.db
        .prepare('SELECT body FROM external_config_requests WHERE scope=? AND operation_id=?')
        .get(scope, operationId),
    )
  }

  private saveConfigRequest(scope: string, operationId: string, record: unknown): void {
    this.db
      .prepare('INSERT INTO external_config_requests VALUES(?,?,?)')
      .run(scope, operationId, encode(record))
  }

  sourceRevision(sourceId: string, revision: number): ExternalSource | null {
    return decode(
      this.db
        .prepare(
          "SELECT body FROM external_config_requests WHERE scope=? AND json_extract(body, '$.revision')=?",
        )
        .get(`source:${sourceId}`, revision),
    )
  }
}
