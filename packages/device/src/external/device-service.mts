// 设备状态锁内共用同一个经理库、GitHub 授权与投递账本。
import { randomUUID } from 'node:crypto'
import {
  EXTERNAL_NOTIFICATION,
  type ExternalInboxEvent,
  type ExternalManagerRecovery,
  type ExternalNotifications,
  type ExternalSource,
  type ExternalTriageParams,
} from '../../../protocol/src/external-sources.mjs'
import type { Manager } from '../../../protocol/src/manager.mjs'
import { ExternalStore } from '../external-store.mjs'
import type { DeviceManagers } from '../manager.mjs'
import { managerNow } from '../manager-store.mjs'
import { UpstreamRpcError } from '../wire.mjs'
import { DeviceAgentLaunch } from './device-agent-launch.mjs'
import { ExternalDeviceConfiguration, externalInput } from './device-configuration.mjs'
import { callExternalGithubTool } from './device-manager-tools.mjs'
import { DeviceGithubPoll } from './device-poll.mjs'
import { ExternalDispatch, type ExternalSendResult } from './dispatch.mjs'
import { ExternalFeedback, type FeedbackWaitReason } from './feedback.mjs'
import { ManagedGithubCli } from './github/gh-install.mjs'
import { type GithubSender, githubWriterForLoopbackTest } from './github/write-api.mjs'
import { ExternalIntakeService } from './intake.mjs'
import { ExternalManagerTools, isExternalManagerCall } from './manager-tools.mjs'
import {
  type ExternalManagerTurn,
  type ExternalMandateHost,
  ExternalMandateService,
} from './mandate.mjs'
import { ExternalLinkService } from './mandate-link.mjs'
import { ExternalGithubOutbox } from './outbox.mjs'
import { ExternalGithubRead } from './outbox-read.mjs'
import { ExternalGithubSecrets } from './secrets.mjs'
import { GithubGhAuthorizationService } from './secrets-gh-authorization.mjs'

export interface DeviceExternalOptions {
  stateDirectory: string
  deviceSocket?: string
  managers: DeviceManagers
  announce<K extends keyof ExternalNotifications>(method: K, params: ExternalNotifications[K]): void
  log(message: string): void
  /** 只能由进程内验收夹具提供；生产入口没有 API 地址覆盖。 */
  fixture?: { github: string; now?: () => number }
}

export class DeviceExternalService {
  readonly store: ExternalStore
  readonly secrets: ExternalGithubSecrets
  readonly configuration: ExternalDeviceConfiguration
  readonly authorization: GithubGhAuthorizationService
  readonly poll: DeviceGithubPoll
  readonly outbox: ExternalGithubOutbox
  readonly agent: DeviceAgentLaunch | null
  readonly dispatch: ExternalDispatch
  readonly sendFixture: GithubSender | undefined
  readonly now: () => number
  private readonly feedback: ExternalFeedback
  private readonly intake: ExternalIntakeService
  private readonly mandates: ExternalMandateService
  private readonly adminMandates: ExternalMandateService
  private readonly tools: ExternalManagerTools
  private readonly links: ExternalLinkService
  private readonly managedCli: ManagedGithubCli
  private readonly admin = new Map<string, ExternalManagerTurn>()
  private readonly running = new Map<string, Promise<unknown>>()
  private readonly stopSecrets: () => void
  private readonly sourceRevision = new Map<string, number>()
  private readonly readinessCache = new Map<string, string>()
  private readonly missingReplies = new Map<
    string,
    ReturnType<ExternalStore['resultReplies']['missingForSource']>
  >()
  private readonly refreshAttempt = new Map<string, string>()
  private readonly dirty = new Map<string, string>()
  private readonly outboxRevision = new Map<string, number>()
  private readonly reconcilingAt = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private closed = false
  private knownConfiguration = -1

  readonly options: DeviceExternalOptions
  constructor(options: DeviceExternalOptions) {
    this.options = options
    const { managers, stateDirectory, fixture, announce } = options
    this.managedCli = new ManagedGithubCli(stateDirectory, options.log)
    this.now = fixture?.now ?? managerNow
    this.store = new ExternalStore(managers.store)
    this.sendFixture = fixture && githubWriterForLoopbackTest(fixture.github)
    const shared = { ...(this.sendFixture ? { send: this.sendFixture } : {}), now: this.now }
    this.secrets = new ExternalGithubSecrets(this.store, stateDirectory, shared)
    this.secrets.sweep()
    this.configuration = new ExternalDeviceConfiguration(this.store, this.secrets)
    this.agent = options.deviceSocket
      ? new DeviceAgentLaunch({
          deviceSocket: options.deviceSocket,
          stateDirectory,
          managedCli: this.managedCli,
          managers,
          store: this.store,
          secrets: this.secrets,
          configuration: this.configuration,
        })
      : null
    const { snapshot: configuration, assignmentForManager } = this.configuration
    this.authorization = GithubGhAuthorizationService.create({
      secrets: this.secrets,
      stateDirectory,
      managedCli: this.managedCli,
      now: this.now,
      changed: (params) => announce(EXTERNAL_NOTIFICATION.identityLoginChanged, params),
    })
    this.stopSecrets = this.secrets.onChanged(() => this.configurationChanged())
    this.poll = new DeviceGithubPoll({
      store: this.store,
      secrets: this.secrets,
      now: this.now,
      ...(fixture ? { loopbackFixture: fixture.github } : {}),
      changed: () => this.configurationChanged(false),
    })
    this.outbox = new ExternalGithubOutbox({
      store: this.store,
      secrets: this.secrets,
      stateDirectory,
      assignmentForManager,
      ...shared,
      statusGateConfirmed: (source) => source.writePolicy.statusGateConfirmed === true,
    })
    this.feedback = new ExternalFeedback(this.store, {
      configuration,
      enqueue: (intent) => this.outbox.enqueueFeedback(intent),
      language: () =>
        /^(?:zh|zh[-_])/i.test(process.env.CHA_LANG ?? process.env.LANG ?? '') ? 'zh-CN' : 'en',
    })
    this.dispatch = new ExternalDispatch(this.store, {
      configuration,
      feedback: this.feedback,
      now: this.now,
      feedbackWaitReason: (manager, sourceId) => this.deliveryWaitReason(manager, sourceId),
      canDeliver: (manager, sourceId) => this.canDeliver(manager, sourceId),
      prepareDelivery: (manager, sourceId) => this.refreshForDelivery(manager, sourceId),
      send: async ({ manager, prepare, beforeSend }) => {
        let turnId: string | undefined
        try {
          await managers.tree.deliverManagerEvent(manager.threadId, '', '', {
            prepare,
            external: { beforeSend },
            onStarted: (id) => {
              turnId = id
            },
          })
        } catch (error) {
          if (error instanceof UpstreamRpcError && [-32601, -32602].includes(error.code))
            return { outcome: 'not_sent' }
        }
        return turnId
          ? { outcome: 'confirmed', turnId }
          : ({ outcome: 'unknown' } satisfies ExternalSendResult)
      },
    })
    const host: ExternalMandateHost = {
      configuration,
      now: this.now,
      ...this.poll.verification,
      isCurrentTurn: ({ threadId, turnId }) =>
        managers.tree.isCurrentExternalTurn(threadId, turnId),
      prepareReply: async ({ turn, intake, request, text }) =>
        this.outbox.prepareTriageReply(
          { ...turn, kind: 'manager' },
          intake.intakeId,
          request.idempotencyKey,
          text,
        ),
      onIssueCreated: (...args) => managers.issues.onExternalCreated(...args),
      onIssueChanged: (...args) => managers.issues.onExternalChanged(...args),
    }
    this.mandates = new ExternalMandateService(this.store, host)
    this.adminMandates = new ExternalMandateService(this.store, {
      ...host,
      isCurrentTurn: (turn) =>
        this.admin.get(turn.turnId) === turn &&
        !managers.resets.held(turn.threadId) &&
        !managers.resets.refusal(turn.threadId),
    })
    this.links = new ExternalLinkService(this.store, this.mandates, {
      configuration,
      now: this.now,
      inspectSubject: this.poll.verification.inspectSubject,
      onIssueChanged: (managerId, issueId) =>
        managers.issues.onExternalChanged(managerId, issueId, false),
      resolveAgentPr: ({ source, repo, proof }) => {
        if (!source.unattended?.autoLinkAgentPr || !proof.head || !proof.base || !proof.actorUserId)
          return null
        const operation = this.outbox.pendingDraft(
          {
            sourceId: source.sourceId,
            repoId: repo.repoId,
            head: proof.head.ref,
            base: proof.base,
            botUserId: proof.actorUserId,
          },
          true,
        )
        const row = operation ? this.store.queue.outboxRecord(operation) : null
        if (!row?.issueId) return null
        return {
          managerId: row.managerId,
          issueId: row.issueId,
          association: proof.agentOperationIds?.includes(row.operationId) ? 'marker' : 'head',
        }
      },
    })
    this.tools = new ExternalManagerTools(this.store, this.mandates, managers.writer, this.links)
    this.intake = new ExternalIntakeService(
      this.store,
      this.poll.verification.lookupGithubRole,
      this.dispatch.queue,
      this.poll.verification.recheckEvent,
      configuration,
      { service: this.feedback, waitReason: this.dispatch.feedbackReason },
    )
  }

  start(): void {
    this.dispatch.recover()
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref()
    this.tick()
  }

  configurationChanged(resetPoll = true): void {
    if (this.closed) return
    const revision = this.store.config.revision()
    if (revision === this.knownConfiguration) return
    this.knownConfiguration = revision
    if (resetPoll) this.poll.reset()
    this.agent?.refresh()
    this.options.announce(EXTERNAL_NOTIFICATION.configurationChanged, { revision })
  }

  changed(source: ExternalSource, managerId?: string): void {
    if (this.closed) return
    const revision = (this.sourceRevision.get(source.sourceId) ?? source.revision) + 1
    this.sourceRevision.set(source.sourceId, revision)
    this.options.announce(EXTERNAL_NOTIFICATION.sourcesChanged, {
      sourceId: source.sourceId,
      revision,
    })
    const pending = this.store.inboxPending(source.sourceId, managerId)
    this.options.announce(EXTERNAL_NOTIFICATION.inboxChanged, {
      sourceId: source.sourceId,
      revision,
      pending,
      ...(managerId ? { managerId } : {}),
    })
  }

  /** 就绪卡和队列投影共用当前经理、能力版本和恢复方式。 */
  managerBlock(
    manager: Manager | null,
  ): { reason: string; recovery?: ExternalManagerRecovery } | null {
    if (!manager) return { reason: 'manager_inactive' }
    const ready = this.options.managers.externalReady(manager)
    if (ready.ready) return null
    return {
      reason: ready.reason,
      ...(ready.action
        ? {
            recovery: { managerId: manager.id, threadId: manager.threadId, action: ready.action },
          }
        : {}),
    }
  }

  managerChanged(id: string): void {
    const manager = this.store.manager.manager(id)
    const block = this.managerBlock(manager)
    if (!block?.recovery) this.refreshAttempt.delete(id)
    const state = JSON.stringify(block)
    if (this.readinessCache.get(id) === state) return
    this.readinessCache.set(id, state)
    const repos = this.store.config.assignment(id).repoIds
    for (const source of this.store.config.sources())
      if (source.repos.some(({ repoId }) => repos.includes(repoId))) this.changed(source, id)
  }

  project(event: ExternalInboxEvent): ExternalInboxEvent {
    const group = this.store.queue.deliveryGroupForEvent(event)
    const missingResultReply =
      event.managerId && event.issueId
        ? this.store.resultReplies.missing(event.managerId, event.issueId)
        : null
    if (missingResultReply) event = { ...event, missingResultReply }
    if (!group) return event
    const manager = this.store.manager.manager(group.managerId)
    const waiting = group.state === 'queued' ? this.sourceWaitReason(group.sourceId) : null
    const block = group.state === 'queued' && waiting === null ? this.managerBlock(manager) : null
    const reason =
      group.reason || block?.reason || (waiting === 'paused' ? 'source_paused' : waiting)
    return {
      ...event,
      delivery: {
        state: group.state,
        ...(reason ? { reason } : {}),
        ...(block?.recovery ? { recovery: block.recovery } : {}),
      },
    }
  }

  private sourceWaitReason(sourceId: string): 'paused' | 'identity_unavailable' | null {
    const source = this.store.config.source(sourceId)
    if (this.closed || !source?.enabled || source.unattended?.autoNotify !== true) return 'paused'
    const current = this.store.config.credential(source.credentialRef)
    return current?.state === 'active' &&
      (current.expiresAt === undefined || current.expiresAt > this.now())
      ? null
      : 'identity_unavailable'
  }

  private deliveryWaitReason(manager: Manager, sourceId: string): FeedbackWaitReason | null {
    const pause = this.sourceWaitReason(sourceId)
    if (pause) return pause
    const ready = this.options.managers.externalReady(manager)
    if (!ready.ready) return ready.reason
    return this.options.managers.tree.canDeliverExternal(manager.threadId) ? null : 'manager_busy'
  }

  canDeliver(manager: Manager, sourceId: string): boolean {
    return this.deliveryWaitReason(manager, sourceId) === null
  }

  private refreshForDelivery(manager: Manager, sourceId: string): void {
    if (this.sourceWaitReason(sourceId)) return
    this.prepareManagerTools(manager)
  }

  /** 结果回帖提醒也沿用外部投递的升级门禁，不把新工具参数交给旧经理。 */
  prepareManagerTools(manager: Manager): boolean {
    const { managers } = this.options
    const ready = managers.externalReady(manager)
    if (ready.ready) return true
    if (ready.action !== 'refresh' || !managers.tree.canDeliverExternal(manager.threadId))
      return false
    const saved = managers.store.reset(manager.id)
    // 同一线程的自动刷新只尝试一次；用户取消或失败后留手动入口。
    if (saved && ['failed', 'summaryFailed'].includes(saved.phase)) return false
    if (this.refreshAttempt.get(manager.id) === manager.threadId) return false
    this.refreshAttempt.set(manager.id, manager.threadId)
    managers.resets.request(manager.id, false)
    return false
  }

  async adminTriage(request: ExternalTriageParams) {
    const intake = this.store.intake(request.intakeId)
    const source = intake && this.store.config.source(intake.sourceId)
    const repo = source?.repos.find(({ repoId }) => intake?.subject.repoId === repoId)
    if (!intake || !source || !repo) externalInput('external_intake_not_found')
    if (request.action === 'reassign') {
      await this.configuration.checkRoot(repo)
      if (!this.store.config.assignment(request.managerId).repoIds.includes(repo.repoId))
        externalInput('external_manager_repository_not_assigned')
      return this.store.reassignIntake({ ...request, actorId: 'device-admin', at: this.now() })
    }
    const manager = intake.managerId && this.store.manager.manager(intake.managerId)
    if (!manager) externalInput('external_intake_not_assigned')
    const turn = {
      managerId: manager.id,
      threadId: manager.threadId,
      harness: manager.harness,
      turnId: randomUUID(),
    }
    this.admin.set(turn.turnId, turn)
    try {
      return await this.adminMandates.decide(turn, request)
    } finally {
      this.admin.delete(turn.turnId)
      this.changed(source, manager.id)
    }
  }

  handles(tool: string, input: unknown): boolean {
    return (
      tool === 'external_read' || tool === 'external_write' || isExternalManagerCall(tool, input)
    )
  }

  async managerTool(turn: ExternalManagerTurn, tool: string, input: unknown) {
    this.mandates.requireManager(turn)
    if (tool !== 'external_read' && tool !== 'external_write')
      return this.tools.call(turn, tool, input)
    const result = await callExternalGithubTool(
      new ExternalGithubRead({
        store: this.store,
        secrets: this.secrets,
        ghPath: this.managedCli,
        checkTurn: () => this.mandates.requireManager(turn),
        isWorklineCurrent: () => false,
      }),
      this.outbox,
      { kind: 'manager', ...turn },
      tool,
      input,
    )
    this.mandates.requireManager(turn)
    return result
  }

  private launch(key: string, run: () => Promise<unknown>): void {
    if (this.closed || this.running.has(key)) return
    const step = run()
      .catch(() => this.options.log(`外部来源操作未完成（${key.split(':')[0]}）`))
      .finally(() => this.running.delete(key))
    this.running.set(key, step)
  }

  private tick(): void {
    this.agent?.sweep()
    const sources = this.store.config.sources()
    if (sources.length === 0) return
    this.store.resultReplies.queueReminders()
    for (const id of this.store.resultReplies.pendingManagerIds()) this.options.managers.kick(id)
    for (const source of sources) {
      const before = this.missingReplies.get(source.sourceId) ?? []
      const current = this.store.resultReplies.missingForSource(source.sourceId)
      if (JSON.stringify(before) === JSON.stringify(current)) continue
      this.missingReplies.set(source.sourceId, current)
      this.changed(source)
      for (const id of new Set([...before, ...current].map(({ managerId }) => managerId)))
        this.options.managers.changed(id)
    }
    // 入口独立于仓库页和旧窗口。静态凭据的 HTTP 队列仍串行遵守 GitHub 限流。
    let runningNotifications = [...this.running.keys()].filter((key) =>
      key.startsWith('notifications:'),
    ).length
    for (const source of sources) {
      if (runningNotifications >= 8) break
      if (
        !this.running.has(`notifications:${source.sourceId}`) &&
        this.poll.notificationsDue(source)
      ) {
        runningNotifications++
        this.launch(`notifications:${source.sourceId}`, async () => {
          await this.poll.collectNotifications(source)
          this.changed(this.store.config.source(source.sourceId) ?? source)
        })
      }
    }
    for (const source of sources) {
      if (!source.enabled) continue
      if (
        this.poll.due(source) &&
        [...this.running.keys()].filter((key) => key.startsWith('poll:')).length < 4
      )
        this.launch(`poll:${source.sourceId}`, async () => {
          await this.poll.collect(source)
          this.changed(this.store.config.source(source.sourceId) ?? source)
        })
      this.launch(`intake:${source.sourceId}`, async () => {
        for (const { repoId } of source.repos) {
          const scope = { sourceId: source.sourceId, repoId }
          await this.intake.consumeGithub(
            this.poll.poll.evidence,
            scope,
            this.now(),
            this.poll.verification,
            source.unattended?.autoLinkAgentPr
              ? (id, event) => this.links.observeAgentPr(id, event)
              : undefined,
            async (source, repo, { targetEvidence: { subject } }) => {
              if (
                !this.store.externalWritesForRepo(source.sourceId, repo.repoId, 'draft_pr', [
                  'sending',
                  'unknown',
                ]).length
              )
                return false
              const proof = await this.poll.verification.inspectSubject({
                source,
                repo,
                ...subject,
              })
              return (
                !!proof?.actorUserId &&
                proof.head?.repoId === repo.repoId &&
                !!proof.base &&
                !!this.outbox.pendingDraft({
                  sourceId: source.sourceId,
                  repoId: repo.repoId,
                  head: proof.head.ref,
                  base: proof.base,
                  botUserId: proof.actorUserId,
                })
              )
            },
          )
          await this.intake.processReceived(source.sourceId, this.now())
          await this.feedback.flush(scope)
        }
        this.announceChanges(source)
      })
    }
    for (const manager of this.store.manager.managers()) {
      this.launch(`deliver:${manager.id}`, async () => {
        const [group] = this.store.queue.deliveryGroups(manager.id, 'unknown')
        if (!group) this.reconcilingAt.delete(manager.id)
        if (
          group?.deliveryId &&
          group.target &&
          Date.now() >= (this.reconcilingAt.get(manager.id) ?? 0)
        ) {
          this.reconcilingAt.set(manager.id, Date.now() + 5000)
          const text = this.store.manager
            .deliveries(manager.id)
            .find(({ id }) => id === group.deliveryId)?.text
          if (text) {
            const turnId = await this.options.managers.tree.externalDeliveryTurn(
              group.target.threadId,
              `external-${group.groupId}`,
              text,
            )
            if (turnId) this.dispatch.confirmDelivery(group.groupId, turnId, this.now())
          }
        }
        if (manager.status === 'active') await this.dispatch.drain(manager.id)
      })
    }
    this.launch('outbox', async () => {
      await this.outbox.tick()
      for (const row of this.store.queue.outboxChanges()) {
        const key = `${row.sourceId}:${row.managerId}`
        if (this.outboxRevision.get(key) === row.revision) continue
        this.outboxRevision.set(key, row.revision)
        this.options.announce(EXTERNAL_NOTIFICATION.outboxChanged, row)
      }
    })
  }

  private announceChanges(source: ExternalSource): void {
    const fingerprint = this.store.inboxFingerprint(source.sourceId)
    const old = this.dirty.get(source.sourceId)
    if (old !== fingerprint) {
      this.dirty.set(source.sourceId, fingerprint)
      this.changed(source)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.managedCli.abort()
    this.poll.close()
    clearInterval(this.timer)
    this.stopSecrets()
    const noAgentUsers = (await this.agent?.close()) ?? true
    await this.authorization.close()
    await Promise.allSettled([...this.running.values()])
    await this.managedCli.retire(noAgentUsers)
  }
}
