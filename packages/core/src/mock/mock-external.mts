// 模拟设备走同一套设备快照和游标；令牌只当作请求参数，不保存在夹具里。
import {
  DEVICE_AUTOSTART_CHANGED,
  DEVICE_AUTOSTART_METHOD,
  type DeviceAutostartStatus,
} from '../../../protocol/src/device-autostart.mjs'
import {
  EXTERNAL_METHOD,
  EXTERNAL_NOTIFICATION,
  type ExternalCredential,
  type ExternalIdentity,
  type ExternalInboxEvent,
  type ExternalIntake,
  type ExternalManagerAssignment,
  type ExternalOwner,
  type ExternalOwnerIdentity,
  type ExternalReadiness,
  type ExternalSourceStatus,
  type ExternalSubject,
} from '../../../protocol/src/external-sources.mjs'
import { ChannelError, type Clock, type Commands } from '../channel/protocol.mjs'
import { createExternalDevice } from '../device/external.mjs'
import { createExternalOwner, githubProfileLogin } from '../device/external-owner.mjs'
import type { DeviceView } from '../model.mjs'
import {
  type ExternalWireRequests,
  type GlobalExternalOwner,
  isExternalCommand,
} from '../projection/external.mjs'

import { mockIdentityLogin } from './mock-identity-login.mjs'

const repo = {
  repoId: '20394867',
  owner: 'sample-org',
  name: 'litch-demo',
  url: 'https://github.com/sample-org/litch-demo',
  defaultBranch: 'main',
  defaultLabelId: '9301',
}
const ownerIdentity: ExternalOwnerIdentity = {
  provider: 'github',
  userId: '41623758',
  loginCache: 'sample-owner',
  profileUrl: 'https://github.com/sample-owner',
  method: 'localGh',
}

/** extraStates：预览场景（mock-states.mts）里加上投递受阻、通知权限缺失、未回原帖等状态 */
export function createMockExternal(clock: Clock, devices: () => DeviceView[], extraStates = false) {
  const states = new Map<string, ReturnType<typeof make>>()
  const now = () => Math.floor(clock.now() / 1000)
  const isOnline = (id: string) =>
    devices().some((device) => device.id === id && device.connection === 'online')
  const conflict = () => new ChannelError('conflict', 'Revision changed')
  const missing = () => new ChannelError('rejected', 'Record not found')
  let global: GlobalExternalOwner | null = { owner: ownerIdentity, revision: 1 }

  function make(id: string) {
    const managerId = id === 'local' ? 'm1' : 'm2'
    let online = isOnline(id)
    let owner: ExternalOwner | null =
      id === 'local' ? { ...ownerIdentity, revision: 1, configuredBy: 'desktop' } : null
    let autostart: DeviceAutostartStatus = {
      revision: 1,
      serviceManager: id === 'local' ? 'launchd' : 'systemd',
      state: 'disabled',
      requiresLogin: true,
      linger: id === 'local' ? 'notApplicable' : 'disabled',
      instance: { pid: 2051, mode: 'manual' },
    }
    const credential: ExternalCredential = {
      credentialRef: 'mock-credential',
      provider: 'github',
      botUserId: '9012',
      resourceOwnerId: '201',
      createdAt: now(),
      lastVerifiedAt: now(),
      state: 'active',
      generation: 1,
    }
    const readiness: ExternalReadiness = {
      collect: {
        state: 'ok',
        diagnostics: [
          {
            check: 'repository',
            state: 'ok',
            code: 'github_collection_available',
            checkedAt: now(),
          },
        ],
      },
      notify: extraStates
        ? {
            state: 'blocked',
            diagnostics: [
              {
                check: 'managerTools',
                state: 'blocked',
                code: 'manager_tools_outdated',
                checkedAt: now(),
                recovery: { managerId, threadId: managerId, action: 'refresh' },
              },
              {
                check: 'notifications',
                state: 'blocked',
                code: 'github_notifications_scope_required',
                checkedAt: now(),
              },
            ],
          }
        : {
            state: 'ok',
            diagnostics: [{ check: 'managerTools', state: 'ok', code: 'manager_tools_ready' }],
          },
      dispatch: {
        state: 'unverified',
        diagnostics: [
          {
            check: 'executionIsolation',
            state: 'unverified',
            code: 'agent_uses_device_credentials',
            checkedAt: now(),
          },
        ],
      },
      write: {
        state: 'unverified',
        diagnostics: [
          {
            check: 'identity_repository_write',
            state: 'unverified',
            code: 'github_repository_write_permission_unverified',
          },
          {
            check: 'immediateFeedbackComments',
            state: 'blocked',
            code: 'github_feedback_write_permission_required',
          },
        ],
      },
    }
    const agentIdentity = () => ({
      userId: id === 'local' ? ownerIdentity.userId : credential.botUserId,
      login: id === 'local' ? ownerIdentity.loginCache : 'sample-bot',
      isOwner: owner?.userId === (id === 'local' ? ownerIdentity.userId : credential.botUserId),
      checkedAt: now(),
    })
    const status: ExternalSourceStatus = {
      source: {
        sourceId: 'github-demo',
        provider: 'github',
        enabled: true,
        credentialRef: credential.credentialRef,
        botUserId: credential.botUserId,
        revision: 1,
        rulesVersion: 1,
        createdAt: now() - 86400,
        minRole: 'write',
        interval: 300,
        triggers: {
          mention: true,
          assignment: true,
          reviewRequest: true,
          label: true,
          labelIds: ['9301'],
        },
        writePolicy: { comment: true, draftPr: false, status: true, managedPush: false },
        repos: [
          {
            repoId: repo.repoId,
            owner: repo.owner,
            name: repo.name,
            url: repo.url,
            localRoot: id === 'local' ? '/work/litch-demo' : '/srv/work/litch-demo',
            allowedBase: ['main'],
            headNamespace: 'litch/',
            pollIdentity: null,
            labelRoutes: [],
          },
        ],
        routes: [],
      },
      coverage: [
        {
          repoId: repo.repoId,
          stream: 'issues',
          coveredThrough: now() - 30,
          checkedAt: now() - 18,
        },
        {
          repoId: repo.repoId,
          stream: 'reviews',
          coveredThrough: now() - 600,
          backoffUntil: now() + 60,
          gap: { from: now() - 600, to: now() - 180, reason: 'api_rate_limit' },
        },
      ],
      readiness,
      runtime: {
        state: 'collecting',
        credentialState: 'active',
        lastAttemptAt: now() - 18,
        lastSuccessAt: now() - 30,
        nextAttemptAt: now() + 282,
        backlog: { pending: 1, limited: 1, oldestAt: now() - 900, nextWakeAt: now() + 120 },
      },
    }
    const sources = new Map([[status.source.sourceId, status]])
    let revision = 1
    const primary: ExternalIdentity = {
      identityId: 'sample-bot',
      botUserId: credential.botUserId,
      login: 'sample-bot',
      revision: 1,
      credentials: [credential],
    }
    const identities = new Map([
      [primary.identityId, primary],
      [
        'spare-bot',
        {
          identityId: 'spare-bot',
          botUserId: '9013',
          login: 'spare-bot',
          revision: 1,
          credentials: [{ ...credential, credentialRef: 'spare-credential', botUserId: '9013' }],
        },
      ],
    ])
    const assignments = new Map<string, ExternalManagerAssignment>([
      [
        managerId,
        {
          managerId,
          identityId: primary.identityId,
          repoIds: [repo.repoId],
          revision: 1,
          injectCredentials: id !== 'local',
        },
      ],
    ])
    const assignment = (managerId: string): ExternalManagerAssignment =>
      assignments.get(managerId) ?? { managerId, identityId: null, repoIds: [], revision: 0 }
    const sourceRepos = () => [...sources.values()].flatMap((entry) => entry.source.repos)
    const config = () => ({
      revision,
      identities: [...identities.values()].map(({ identityId, botUserId, login }) => ({
        identityId,
        botUserId,
        login,
      })),
      repositories: sourceRepos().map(
        ({ repoId, pollIdentity, labelRoutes, immediateFeedback, immediateFeedbackLanguage }) => ({
          repoId,
          pollIdentity: pollIdentity ?? null,
          labelRoutes: labelRoutes ?? [],
          immediateFeedback: immediateFeedback ?? true,
          immediateFeedbackLanguage: immediateFeedbackLanguage ?? 'follow-ui',
        }),
      ),
      assignments: [...assignments.values()],
    })
    const changed = () =>
      notify(EXTERNAL_NOTIFICATION.configurationChanged, { revision: ++revision })
    const authorization = mockIdentityLogin({
      clock,
      profile(isOwner, scopes) {
        return {
          account: isOwner
            ? {
                login: ownerIdentity.loginCache,
                userId: ownerIdentity.userId,
                name: 'Sample Owner',
              }
            : { login: 'sample-bot', userId: credential.botUserId, name: 'Sample GitHub Bot' },
          scopes,
          repositories: [repo],
          isOwner,
        }
      },
      commit(result, credentialKind) {
        const current = identities.get(result.account.login)
        const updated: ExternalIdentity = {
          identityId: result.account.login,
          login: result.account.login,
          botUserId: result.account.userId,
          revision: (current?.revision ?? 0) + 1,
          credentials: [
            ...(current?.credentials ?? []),
            {
              ...credential,
              credentialRef: `mock-auth-${revision}`,
              botUserId: result.account.userId,
              resourceOwnerId:
                credentialKind === 'oauth' ? result.account.userId : String(200 + revision),
              credentialKind,
              scopes: result.scopes,
            },
          ],
        }
        identities.set(updated.identityId, updated)
        changed()
        return updated
      },
      changed(loginId, revision) {
        notify(EXTERNAL_NOTIFICATION.identityLoginChanged, { loginId, revision })
      },
    })
    function repoAccess(identityId?: string, repoId?: string) {
      return [
        repo,
        {
          ...repo,
          repoId: '20394868',
          name: 'empty-demo',
          url: 'https://github.com/sample-org/empty-demo',
        },
      ]
        .filter((row) => !repoId || row.repoId === repoId)
        .map((row) => ({
          ...row,
          grants: [...identities.values()]
            .filter((bot) => !identityId || bot.identityId === identityId)
            .flatMap((bot) => {
              const found = bot.credentials.find((one) => one.state === 'active')
              return found
                ? [
                    {
                      identityId: bot.identityId,
                      botUserId: bot.botUserId,
                      credentialRef: found.credentialRef,
                      read: true,
                      write: bot.identityId === 'spare-bot' ? 'missing' : 'verified',
                    },
                  ]
                : []
            }),
        }))
    }
    const subject = (n: number): ExternalSubject => ({
      provider: 'github',
      repoId: repo.repoId,
      number: String(n),
      kind: 'issue',
      url: `${repo.url}/issues/${n}`,
    })
    let events: ExternalInboxEvent[] = (['pending_triage', 'processed', 'blocked'] as const).map(
      (state, i) => ({
        seq: 3 - i,
        revision: 1,
        eventKey: `github:${108 - i}`,
        sourceId: 'github-demo',
        subjectKey: `github/${repo.repoId}/${108 - i}`,
        subject: subject(108 - i),
        sourceEventId: String(108 - i),
        kind: 'comment',
        managerId,
        actorId: i === 0 ? ownerIdentity.userId : String(12345 + i),
        actorRoleAtCheck: i === 2 ? 'read' : i === 0 ? 'owner' : 'write',
        occurredAt: now() - 900 - i * 300,
        observedAt: now() - 840 - i * 300,
        status: state,
        ...(i === 0
          ? {
              delivery: extraStates
                ? {
                    state: 'blocked' as const,
                    reason: 'manager_tools_outdated',
                    recovery: { managerId, threadId: managerId, action: 'refresh' as const },
                  }
                : { state: 'queued' as const, reason: 'rate_limited' },
            }
          : {}),
        ...(extraStates && i === 1
          ? { missingResultReply: { managerId, issueId: 'X-1' as const, subject: subject(107) } }
          : {}),
        eventUrl: `${repo.url}/issues/${108 - i}#issuecomment-1`,
        reason: i === 2 ? 'role_below_minimum' : i === 0 ? 'rate_limited' : 'manual',
        ruleId: 'owner_comment',
        rulesVersion: 1,
        contentVersion: null,
        ...(i === 0 ? { intakeId: 'intake-108' } : i === 1 ? { issueId: 'X-1' as const } : {}),
      }),
    )
    if (extraStates)
      status.missingResultReplies = [{ managerId, issueId: 'X-1', subject: subject(107) }]
    const intakes = new Map<string, ExternalIntake>()
    for (const evt of events)
      if (evt.intakeId)
        intakes.set(evt.intakeId, {
          intakeId: evt.intakeId,
          sourceId: evt.sourceId,
          subject: evt.subject,
          subjectKey: evt.subjectKey,
          managerId,
          eventKeys: [evt.eventKey],
          autoNotifyUntil: now() + 3600,
          status: 'pending_triage',
          revision: 1,
        })

    const notify = (method: string, scope: object) => device.notification(method, scope)
    const mutate = (sourceId: string, expectedRevision: number, enabled: boolean) => {
      const value = sources.get(sourceId)
      if (!value) throw missing()
      if (value.source.revision !== expectedRevision) throw conflict()
      value.source = { ...value.source, enabled, revision: value.source.revision + 1 }
      if (value.runtime)
        value.runtime = { ...value.runtime, state: enabled ? 'collecting' : 'paused' }
      notify(EXTERNAL_NOTIFICATION.sourcesChanged, { sourceId })
      return structured(value)
    }
    const structured = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

    async function request<M extends keyof ExternalWireRequests>(
      method: M,
      args: ExternalWireRequests[M]['params'],
    ) {
      const a = args as Record<string, unknown>
      const sourceId = String(a.sourceId)
      let result: unknown
      switch (method) {
        case EXTERNAL_METHOD.accessGet:
          result = {
            configure: true,
            configureAutostart: true,
            pauseSource: true,
            resumeSource: true,
            triageInbox: true,
            reassignInbox: true,
          }
          break
        case EXTERNAL_METHOD.ownerGet:
          result = { owner }
          break
        case EXTERNAL_METHOD.ownerSet: {
          const p = args as ExternalWireRequests[typeof EXTERNAL_METHOD.ownerSet]['params']
          if (p.expectedRevision !== (owner?.revision ?? 0)) throw conflict()
          owner = { ...p.owner, configuredBy: 'desktop', revision: p.expectedRevision + 1 }
          result = { owner }
          notify(EXTERNAL_NOTIFICATION.ownerChanged, {})
          break
        }
        case EXTERNAL_METHOD.sourceList:
          result = {
            sources: [...sources.values()].map((one) => ({
              ...one,
              agentGhIdentity: agentIdentity(),
            })),
          }
          break
        case EXTERNAL_METHOD.sourceGet:
          result = sources.get(sourceId) ?? null
          break
        case EXTERNAL_METHOD.sourceCheck:
          result = { readiness, diagnostics: [], agentGhIdentity: agentIdentity() }
          break
        case EXTERNAL_METHOD.sourcePause:
        case EXTERNAL_METHOD.sourceResume:
          result = mutate(
            sourceId,
            Number(a.expectedRevision),
            method === EXTERNAL_METHOD.sourceResume,
          )
          break
        case EXTERNAL_METHOD.sourceUpsert: {
          const p = args as ExternalWireRequests[typeof EXTERNAL_METHOD.sourceUpsert]['params']
          const previous = sources.get(p.source.sourceId)
          if (p.expectedRevision !== (previous?.source.revision ?? 0)) throw conflict()
          const entry = {
            ...previous,
            source: {
              ...p.source,
              revision: p.expectedRevision + 1,
              createdAt: previous?.source.createdAt ?? now(),
              rulesVersion: p.expectedRevision + 1,
            },
            coverage: previous?.coverage ?? [],
            readiness,
          }
          if (
            p.source.repos.length !== 1 ||
            [...sources.values()].some(
              ({ source }) =>
                source.sourceId !== p.source.sourceId &&
                source.repos.some((repo) => repo.repoId === p.source.repos[0]?.repoId),
            )
          )
            throw conflict()
          sources.set(p.source.sourceId, entry)
          changed()
          notify(EXTERNAL_NOTIFICATION.sourcesChanged, { sourceId: p.source.sourceId })
          result = entry
          break
        }
        case EXTERNAL_METHOD.sourcePreview: {
          const p = args as ExternalWireRequests[typeof EXTERNAL_METHOD.sourcePreview]['params']
          const matches = p.source.repos.some((one) => one.repoId === repo.repoId)
            ? events.slice(0, 2).map(({ seq: _seq, revision: _revision, ...evt }) => evt)
            : []
          result = { matches, diagnostics: [] }
          break
        }
        case EXTERNAL_METHOD.configurationGet:
          result = config()
          break
        case EXTERNAL_METHOD.managerAssignmentGet:
          result = assignment(String(a.managerId))
          break
        case EXTERNAL_METHOD.managerAssignmentSet: {
          const {
            operationId: _op,
            expectedRevision,
            ...next
          } = args as ExternalWireRequests[typeof EXTERNAL_METHOD.managerAssignmentSet]['params']
          if (
            expectedRevision !== assignment(next.managerId).revision ||
            [...assignments.values()].some(
              (one) =>
                one.managerId !== next.managerId &&
                one.identityId === next.identityId &&
                one.repoIds.some((repoId) => next.repoIds.includes(repoId)),
            )
          )
            throw conflict()
          const saved = { ...next, revision: expectedRevision + 1 }
          assignments.set(next.managerId, saved)
          changed()
          result = saved
          break
        }
        case EXTERNAL_METHOD.identityList:
          result = { identities: [...identities.values()] }
          break
        case EXTERNAL_METHOD.identityRepositories:
          result = {
            repositories: repoAccess(
              typeof a.identityId === 'string' ? a.identityId : undefined,
              typeof a.repoId === 'string' ? a.repoId : undefined,
            ),
            nextCursor: null,
          }
          break
        case EXTERNAL_METHOD.identityAdd: {
          const { scopes } =
            args as ExternalWireRequests[typeof EXTERNAL_METHOD.identityAdd]['params']
          result = authorization.add(scopes)
          break
        }
        case EXTERNAL_METHOD.identityImport:
          result = authorization.import()
          break
        case EXTERNAL_METHOD.identityPaste:
          result = authorization.paste()
          break
        case EXTERNAL_METHOD.identityLoginGet:
          result = authorization.get(String(a.loginId))
          break
        case EXTERNAL_METHOD.identityLoginCancel:
          result = authorization.cancel(String(a.loginId))
          break
        case EXTERNAL_METHOD.identityLoginConfirm:
          result = authorization.confirm(String(a.loginId), Number(a.expectedRevision))
          break
        case EXTERNAL_METHOD.identityRotate:
        case EXTERNAL_METHOD.identityRevoke: {
          const bot = identities.get(String(a.identityId))
          const value = bot?.credentials.find((one) => one.credentialRef === a.credentialRef)
          if (!bot || !value) throw missing()
          if (value.generation !== a.expectedGeneration) throw conflict()
          bot.credentials = bot.credentials.map((one) =>
            one === value
              ? {
                  ...one,
                  generation: one.generation + 1,
                  state: method === EXTERNAL_METHOD.identityRevoke ? 'revoked' : 'active',
                }
              : one,
          )
          bot.revision++
          changed()
          result = { identity: bot }
          break
        }
        case EXTERNAL_METHOD.inboxList: {
          const p = args as ExternalWireRequests[typeof EXTERNAL_METHOD.inboxList]['params']
          const matched = events.filter(
            (evt) =>
              (!p.beforeSeq || evt.seq < p.beforeSeq) &&
              (!p.managerId || evt.managerId === p.managerId) &&
              (!p.sourceId || evt.sourceId === p.sourceId) &&
              (!p.status || evt.status === p.status) &&
              (!p.statuses || p.statuses.includes(evt.status)) &&
              (!p.reason || evt.reason === p.reason) &&
              (!p.repoId || p.repoId === evt.subject.repoId),
          )
          const limit = p.limit ?? 30
          result = {
            entries: matched.slice(0, limit),
            nextBeforeSeq: matched.length > limit ? matched[limit - 1]?.seq : null,
          }
          break
        }
        case EXTERNAL_METHOD.inboxGet: {
          const event = events.find((one) => one.eventKey === a.eventKey)
          const intake = intakes.get(String(a.intakeId ?? event?.intakeId)) ?? null
          result = {
            intake,
            events: intake
              ? events.filter((one) => one.intakeId === intake.intakeId)
              : event
                ? [event]
                : [],
          }
          break
        }
        case EXTERNAL_METHOD.inboxTriage: {
          const current = intakes.get(String(a.intakeId))
          if (!current) throw missing()
          if (current.revision !== a.expectedRevision) {
            result = { outcome: 'conflict', reason: 'intake_revision', intake: current }
            break
          }
          const next: ExternalIntake = {
            ...current,
            revision: current.revision + 1,
            ...(a.action === 'reassign'
              ? { managerId: String(a.managerId) }
              : { status: 'processed' }),
          }
          intakes.set(current.intakeId, next)
          events = events.map((evt) =>
            evt.intakeId !== current.intakeId
              ? evt
              : {
                  ...evt,
                  managerId: next.managerId ?? managerId,
                  status: next.status,
                  revision: evt.revision + 1,
                },
          )
          result = { outcome: 'applied', intake: next }
          break
        }
        case EXTERNAL_METHOD.outboxList: {
          const receiptUrl = `${repo.url}/issues/107#issuecomment-2`
          const entry = {
            seq: 1,
            operationId: 'sample-receipt',
            sourceId: 'github-demo',
            managerId,
            issueId: 'X-1',
            targetRef: subject(107),
            action: 'ack_comment_create',
            state: 'confirmed',
            revision: 1,
            attempts: 1,
            receipt: {
              objectId: '2',
              url: receiptUrl,
              at: now() - 840,
              botUserId: credential.botUserId,
              verifiedBy: 'response',
            },
          }
          const visible =
            (!a.managerId || a.managerId === managerId) &&
            (!a.issueId || a.issueId === entry.issueId) &&
            (!a.state || a.state === entry.state)
          result = { entries: visible ? [entry] : [], nextBeforeSeq: null }
          break
        }
        case DEVICE_AUTOSTART_METHOD.get:
          result = autostart
          break
        case DEVICE_AUTOSTART_METHOD.enable:
        case DEVICE_AUTOSTART_METHOD.disable: {
          if (a.expectedRevision !== autostart.revision) throw conflict()
          const on = method === DEVICE_AUTOSTART_METHOD.enable
          autostart = {
            ...autostart,
            revision: autostart.revision + 1,
            state: on ? 'enabled' : 'disabled',
            linger: a.allowLinger ? 'enabled' : autostart.linger,
            requiresLogin: !a.allowLinger,
            lastOperation: {
              action: on ? 'enable' : 'disable',
              operationId: String(a.operationId),
              state: 'completed',
            },
          }
          result = { state: 'completed', status: autostart }
          notify(DEVICE_AUTOSTART_CHANGED, {})
          break
        }
        default:
          throw missing()
      }
      return structured(result) as ExternalWireRequests[M]['result']
    }

    const device = createExternalDevice({
      online: () => online,
      now: clock.now,
      sourcesSupported: () => id === 'local' || id === 'build',
      autostartSupported: () => id === 'local' || id === 'build',
      request,
      fail: (error) =>
        error instanceof ChannelError ? error : new ChannelError('remote', String(error)),
    })
    return {
      device,
      update() {
        const value = isOnline(id)
        if (value !== online) {
          online = value
          device.connectionChanged()
        }
      },
    }
  }

  function of(id: string) {
    let entry = states.get(id)
    if (!entry) {
      entry = make(id)
      states.set(id, entry)
    }
    return entry.device
  }

  const owner = createExternalOwner({
    devices: () => devices().map((device) => ({ id: device.id, online: isOnline(device.id) })),
    get: async (id) =>
      ((await of(id).command('external.owner.get', {})) as { owner: ExternalOwner | null }).owner,
    set: async (id, input) =>
      ((await of(id).command('external.owner.set', input)) as { owner: ExternalOwner }).owner,
    main: async (request) => {
      if (request.kind === 'external.owner.get') return { ok: true, data: global }
      if (request.kind === 'external.owner.save') {
        if ((global?.revision ?? 0) !== request.expectedRevision)
          return { ok: false, reason: 'conflict' }
        global = { owner: request.owner, revision: request.expectedRevision + 1 }
        return { ok: true, data: null }
      }
      if (request.kind === 'external.owner.resolve') {
        const { input } = request
        if (input.method === 'localGh') return { ok: true, data: ownerIdentity }
        const login =
          input.method === 'profileUrl'
            ? githubProfileLogin(input.value.trim())
            : ownerIdentity.loginCache
        return {
          ok: true,
          data: {
            ...ownerIdentity,
            method: input.method,
            userId: input.method === 'userId' ? input.value.trim() : ownerIdentity.userId,
            loginCache: login,
            profileUrl: `https://github.com/${login}`,
          },
        }
      }
      return { ok: false, reason: 'unsupported' }
    },
  })

  return {
    of,
    update: (id: string) => states.get(id)?.update(),
    command(name: string, params: unknown) {
      if (isExternalCommand(name)) {
        const { deviceId, ...args } = params as { deviceId: string }
        return of(deviceId).command(name, args)
      }
      switch (name) {
        case 'external.identity.avatar':
          return Promise.resolve(null)
        case 'external.owner.resolve':
          return owner.resolve(params as Commands['external.owner.resolve']['params'])
        case 'external.owner.global.get':
          return owner.get()
        case 'external.owner.global.plan':
          return owner.plan((params as Commands['external.owner.global.plan']['params']).owner)
        case 'external.owner.global.set':
          return owner.set(params as Commands['external.owner.global.set']['params'])
        case 'external.inbox.more': {
          const { deviceId, filter } = params as Commands['external.inbox.more']['params']
          return of(deviceId).inboxMore(filter)
        }
        case 'external.outbox.more': {
          const { deviceId, filter } = params as Commands['external.outbox.more']['params']
          return of(deviceId).outboxMore(filter)
        }
        default:
          return undefined
      }
    },
  }
}
