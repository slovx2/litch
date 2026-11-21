import type {
  ExternalDiagnostic,
  ExternalOwnerIdentity,
  ExternalReadiness,
  ExternalRequests,
  ExternalSourceStatus,
} from '../../../protocol/src/external-sources.mjs'
import {
  EXTERNAL_NOTIFICATION,
  EXTERNAL_SOURCES_EXTENSION,
  EXTERNAL_METHOD as M,
} from '../../../protocol/src/external-sources.mjs'
import { isExternalMethodParams } from '../../../protocol/src/external-validation.mjs'
import { ProtocolError } from '../../../shared/src/protocol-contract.mjs'
import type { DeviceAutostart } from '../device-autostart.mjs'
import { externalOutboxSummary } from '../external-store.mjs'
import { DeviceError } from '../wire.mjs'
import { configurationResult, externalInput } from './device-configuration.mjs'
import { previewExternalSource } from './device-preview.mjs'
import type { DeviceExternalService } from './device-service.mjs'
import { checkIdentityRepositoryWrites } from './execution-boundary.mjs'
import { githubActor } from './github/identity.mjs'
import { parseGithubJson } from './github/read-api.mjs'
import { GithubWriteFault } from './github/write-api.mjs'

type Method = keyof ExternalRequests
const knownMethods = new Set<string>(Object.values(M))
const publicReads = new Set<Method>([
  M.accessGet,
  M.ownerGet,
  M.configurationGet,
  M.managerAssignmentGet,
  M.sourceList,
  M.sourceGet,
  M.sourceCheck,
  M.inboxList,
  M.inboxGet,
  M.outboxList,
  M.outboxGet,
])

export class DeviceExternalRpc {
  private readonly service: DeviceExternalService
  private readonly autostart: DeviceAutostart | undefined
  constructor(service: DeviceExternalService, autostart?: DeviceAutostart) {
    this.service = service
    this.autostart = autostart
  }

  async call(method: string, raw: unknown, access: { declared: boolean; admin: boolean }) {
    if (!access.declared)
      throw new DeviceError(
        'extensionRequired',
        `${method} requires ${EXTERNAL_SOURCES_EXTENSION}`,
        { method, required: [EXTERNAL_SOURCES_EXTENSION] },
      )
    if (!knownMethods.has(method)) throw new ProtocolError(-32601, 'Unknown external source method')
    const key = method as Method
    if (!access.admin && !publicReads.has(key))
      throw new DeviceError('deviceAdminRequired', 'This operation requires a device administrator')
    const args = <K extends Method>(type: K): ExternalRequests[K]['params'] => {
      const params = raw === undefined ? {} : raw
      if (!isExternalMethodParams(type, params))
        throw new ProtocolError(-32602, 'Invalid external source request parameters')
      return params
    }
    const service = this.service
    const { store, configuration, secrets, authorization, outbox } = service
    try {
      switch (key) {
        case M.accessGet:
          args(key)
          return {
            configure: access.admin,
            configureAutostart: access.admin,
            pauseSource: access.admin,
            resumeSource: access.admin,
            reassignInbox: access.admin,
            triageInbox: access.admin,
          }
        case M.ownerGet:
          args(key)
          return { owner: store.config.owner('github') }
        case M.ownerSet: {
          const input = args(key)
          const owner = configurationResult(
            store.config.setOwner(
              await this.verifyOwner(input.owner),
              'device-admin',
              input.expectedRevision,
              input.operationId,
            ),
          )
          service.configurationChanged()
          service.options.announce(EXTERNAL_NOTIFICATION.ownerChanged, { revision: owner.revision })
          return { owner }
        }
        case M.credentialConfigure:
          return { credential: configurationResult(await secrets.configure(args(key))) }
        case M.credentialRotate:
          return { credential: configurationResult(await secrets.rotate(args(key))) }
        case M.credentialRevoke:
          return { credential: configurationResult(secrets.revoke(args(key))) }
        case M.identityList:
          args(key)
          return { identities: secrets.identities() }
        case M.identityAdd:
          return await authorization.add(args(key))
        case M.identityImport:
          return await authorization.importLogin(args(key))
        case M.identityPaste:
          return await authorization.paste(args(key))
        case M.identityLoginGet:
          return authorization.get(args(key).loginId)
        case M.identityLoginCancel:
          return await authorization.cancel(args(key))
        case M.identityLoginConfirm:
          return await authorization.confirm(args(key))
        case M.identityRotate:
          return await secrets.rotateIdentityCredential(args(key))
        case M.identityRevoke:
          return secrets.revokeIdentityCredential(args(key))
        case M.identityRepositories:
          return secrets.repositories(args(key))
        case M.configurationGet:
          args(key)
          return configuration.snapshot()
        case M.managerAssignmentGet:
          return store.config.assignment(args(key).managerId)
        case M.managerAssignmentSet: {
          const result = await configuration.setAssignment(args(key))
          service.configurationChanged()
          return result
        }
        case M.sourceList:
          args(key)
          return { sources: store.config.sources().map(({ sourceId }) => this.status(sourceId)) }
        case M.sourceGet:
          return this.status(args(key).sourceId)
        case M.sourceCheck: {
          const { sourceId } = args(key)
          const status = this.status(sourceId)
          const [repo] = status.source.repos
          const readiness = status.readiness
          const owner = store.config.owner('github')
          let agentGhIdentity: ExternalSourceStatus['agentGhIdentity']
          const system = await this.autostart?.readiness().catch(() => null)
          readiness.dispatch.diagnostics.push(
            diagnostic(
              'deviceAutostart',
              system?.state === 'ready' ? 'ok' : 'unverified',
              system?.repair?.code ??
                (system?.state === 'ready'
                  ? 'device_autostart_ready'
                  : 'device_autostart_unverified'),
            ),
          )
          if (repo && access.admin) {
            try {
              await configuration.checkRoot(repo)
              if (status.source.enabled) await service.poll.check(status.source)
            } catch (error) {
              readiness.collect.diagnostics.push(
                diagnostic(
                  'repository',
                  'blocked',
                  error instanceof GithubWriteFault ? error.code : 'github_repository_unreachable',
                ),
              )
              readiness.collect.state = 'blocked'
            }
            if (owner && service.agent) {
              for (const { managerId } of store.config
                .assignments()
                .filter((entry) => entry.repoIds.includes(repo.repoId))
                .slice(0, 4)) {
                const { identity, ...found } = await service.agent.probe(
                  managerId,
                  repo.localRoot,
                  owner.userId,
                )
                readiness.dispatch.diagnostics.push(found)
                agentGhIdentity = identity ?? agentGhIdentity
                if (agentGhIdentity?.isOwner) break
              }
            }
          }
          return {
            readiness,
            diagnostics: Object.values(readiness).flatMap((row) => row.diagnostics),
            ...(agentGhIdentity ? { agentGhIdentity } : {}),
          }
        }
        case M.sourceUpsert: {
          const { source, expectedRevision, operationId } = args(key)
          const draft = await configuration.prepareSource(source)
          const verifiedAt = await service.poll.check({
            ...draft,
            revision: 0,
            rulesVersion: 0,
            createdAt: service.now(),
          })
          const saved = configuration.saveSource(draft, expectedRevision, operationId, verifiedAt)
          service.configurationChanged()
          service.changed(saved)
          return this.status(saved.sourceId)
        }
        case M.sourcePreview: {
          const draft = await configuration.prepareSource(args(key).source)
          return await previewExternalSource(service, draft)
        }
        case M.sourcePause:
        case M.sourceResume: {
          const { sourceId, expectedRevision, operationId } = args(key)
          const { source } = this.status(sourceId)
          const draft = { ...source, enabled: key === M.sourceResume }
          const saved = draft.enabled
            ? configuration.saveSource(
                await configuration.prepareSource(draft),
                expectedRevision,
                operationId,
              )
            : configurationResult(
                store.config.saveSource(draft, expectedRevision, operationId, 'device-admin'),
              )
          service.configurationChanged()
          if (saved.enabled) service.poll.resume(sourceId)
          service.changed(saved)
          return this.status(saved.sourceId)
        }
        case M.inboxList: {
          const page = store.inbox(args(key))
          return { ...page, entries: page.entries.map((row) => service.project(row)) }
        }
        case M.inboxGet: {
          const input = args(key)
          const event = 'eventKey' in input ? store.inboxEvent(input.eventKey) : null
          const intakeId = 'intakeId' in input ? input.intakeId : event?.intakeId
          const intake = intakeId ? store.intake(intakeId) : null
          const rows = event
            ? [event]
            : (intake?.eventKeys ?? []).flatMap((key) => store.inboxEvent(key) ?? [])
          return { intake, events: rows.map((row) => service.project(row)) }
        }
        case M.inboxTriage:
          return await service.adminTriage(args(key))
        case M.outboxList:
          return store.queue.outbox(args(key))
        case M.outboxGet: {
          const row = store.queue.outboxRecord(args(key).operationId)
          if (!row) externalInput('external_outbox_operation_not_found')
          return externalOutboxSummary(row)
        }
        case M.outboxReconcile:
          return await outbox.reconcile(args(key).operationId)
        case M.outboxCancel: {
          const { targetOperationId, expectedRevision } = args(key)
          const row = outbox.cancel(targetOperationId, expectedRevision, 'device-admin')
          if (!row) externalInput('external_outbox_operation_not_found')
          return row
        }
      }
    } catch (error) {
      if (error instanceof GithubWriteFault)
        throw Object.assign(new ProtocolError(-32000, error.code), { data: { code: error.code } })
      if (error instanceof ProtocolError) throw error
      // 私有参数、GitHub 正文和子进程原始错误都不能出现在代理回包或日志。
      this.service.options.log(`外部来源请求未完成（${method}）`)
      throw new ProtocolError(-32603, 'External source operation failed')
    }
  }

  private async verifyOwner(owner: ExternalOwnerIdentity): Promise<ExternalOwnerIdentity> {
    const base = this.service.options.fixture?.github ?? 'https://api.github.com'
    const path =
      owner.method === 'profileUrl'
        ? `/users/${encodeURIComponent(owner.loginCache)}`
        : `/user/${encodeURIComponent(owner.userId)}`
    const response = await fetch(new URL(path, base), {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    }).catch(() => null)
    if (!response?.ok) externalInput('github_owner_unverified')
    const account = githubActor(parseGithubJson(await response.text()))
    if (
      !account ||
      account.userId !== owner.userId ||
      account.login.toLowerCase() !== owner.loginCache.toLowerCase()
    )
      externalInput('github_owner_unverified')
    return {
      ...owner,
      loginCache: account.login,
      profileUrl: `https://github.com/${account.login}`,
    }
  }

  status(id: string): ExternalSourceStatus & { readiness: ExternalReadiness } {
    const { store, poll, dispatch, secrets } = this.service
    const source = store.config.source(id)
    if (!source) externalInput('external_source_not_found')
    const [repo] = source.repos
    const coverage = store
      .cursors(id)
      .map(({ repoId, stream, coveredThrough, checkedAt, backoffUntil, gap }) => ({
        repoId,
        stream,
        coveredThrough,
        ...(checkedAt === undefined ? {} : { checkedAt }),
        ...(backoffUntil === undefined ? {} : { backoffUntil }),
        ...(gap ? { gap } : {}),
      }))
    const pollStatus = poll.status(source)
    const assigned = store.config
      .assignments()
      .filter(({ repoIds }) => repo && repoIds.includes(repo.repoId))
    const pressure = assigned.map(({ managerId }) => dispatch.pressure(managerId, id))
    const collect = source.enabled && pollStatus.state !== 'blocked'
    const notify = source.unattended?.autoNotify === true
    const blocks = assigned.flatMap(({ managerId }) => {
      const blocked = this.service.managerBlock(store.manager.manager(managerId))
      return blocked
        ? [
            {
              ...diagnostic('managerTools', 'blocked', blocked.reason),
              ...(blocked.recovery ? { recovery: blocked.recovery } : {}),
            },
          ]
        : []
    })
    const missingFeedback =
      repo?.immediateFeedback !== false &&
      assigned.some(({ identityId }) => {
        if (!repo || !identityId) return false
        try {
          const snapshot = secrets.activeForRepository(repo.repoId, identityId)
          return ['issue', 'pull_request'].some((kind) =>
            secrets.feedbackWriteMissing(snapshot, repo.repoId, kind as 'issue' | 'pull_request'),
          )
        } catch {
          return true
        }
      })
    const readiness: ExternalReadiness = {
      collect: area(
        diagnostic(
          'repository',
          collect ? 'ok' : 'blocked',
          source.enabled
            ? collect
              ? 'github_collection_available'
              : 'github_collection_blocked'
            : 'source_paused',
        ),
      ),
      notify: !notify
        ? area(diagnostic('managerTools', 'blocked', 'auto_notify_disabled'))
        : !assigned.length
          ? area(diagnostic('managerTools', 'blocked', 'manager_unassigned'))
          : blocks.length
            ? area(...blocks)
            : area(diagnostic('managerTools', 'ok', 'manager_tools_ready')),
      dispatch: area(
        diagnostic('executionIsolation', 'unverified', 'agent_uses_device_credentials'),
      ),
      write: area(
        diagnostic(
          'immediateFeedbackComments',
          missingFeedback ? 'blocked' : 'unverified',
          missingFeedback
            ? 'github_feedback_write_permission_required'
            : 'github_repository_write_permission_unverified',
        ),
      ),
    }
    if (repo)
      for (const { identityId } of assigned) {
        if (identityId)
          readiness.write.diagnostics.push(
            ...checkIdentityRepositoryWrites({
              secrets,
              identityId,
              repositories: [repo],
            }).map(({ check, state, code }) => ({ check, state, code })),
          )
      }
    const times = pressure.flatMap((row) =>
      row.nextAdmissionAt === null ? [] : [row.nextAdmissionAt],
    )
    const waits = pressure.flatMap((row) =>
      row.pendingGroups > 0 ? [row.oldestWaitingSeconds] : [],
    )
    return {
      source,
      coverage,
      readiness,
      runtime: {
        ...pollStatus,
        state: source.enabled ? pollStatus.state : 'paused',
        backlog: {
          pending: store.inboxPending(id),
          limited: pressure.reduce((sum, row) => sum + row.limitedGroups, 0),
          ...(waits.length ? { oldestAt: this.service.now() - Math.max(...waits) } : {}),
          ...(times.length ? { nextWakeAt: Math.min(...times) } : {}),
        },
      },
    }
  }
}

const diagnostic = (
  check: string,
  state: ExternalDiagnostic['state'],
  code: string,
): ExternalDiagnostic => ({ check, state, code })
const area = (...diagnostics: ExternalDiagnostic[]) => ({
  state: diagnostics[0]?.state ?? ('unverified' as const),
  diagnostics,
})
