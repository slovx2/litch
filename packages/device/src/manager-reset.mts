import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import {
  ATTACHMENT_STATUS_METHOD,
  ATTACHMENT_WATCH_METHOD,
} from '../../protocol/src/file-attachments.mjs'
import type {
  Manager,
  ManagerResetPreview,
  ManagerResetState,
} from '../../protocol/src/manager.mjs'
import { questionsOfHistory } from '../../protocol/src/pending-history.mjs'
import type { DeviceManagers } from './manager.mjs'
import {
  type ManagerResetPlan,
  managerResetPlan,
  managerResetScheduleIssues,
  resetTarget,
} from './manager-create-validation.mjs'
import {
  MANAGER_HANDOVER_PROMPT,
  MANAGER_SUMMARY_PROMPT,
  managerBundle,
  managerFingerprint,
  managerHandoverIndex,
} from './manager-rules.mjs'
import type { ResetRecord } from './manager-store.mjs'
import { managerNow } from './manager-store.mjs'
import { ManagerError, text } from './manager-validate.mjs'
import { childPermissions } from './session-permissions.mjs'
import { parentSettings } from './session-start.mjs'
import { lastAnswer } from './session-tree.mjs'
import { isObject } from './wire.mjs'

/** 只有用户 RPC 能排入重置。提交意图先耐久保存，跨库的路由更新随后幂等重放。 */
export class ManagerResets {
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private readonly summaryInputs = new WeakSet<object>()
  private readonly settingsReads = new WeakSet<object>()
  private closed = false
  readonly owner: DeviceManagers
  constructor(owner: DeviceManagers) {
    this.owner = owner
    for (const manager of owner.store.managers()) {
      const record = owner.store.reset(manager.id)
      if (record?.committed) {
        try {
          this.finish(record)
        } catch (error) {
          owner.tree.host.log(`经理换绑等待向前恢复：${String(error)}`)
        }
      }
    }
  }
  state(manager: Manager): ManagerResetState {
    const record = this.owner.store.reset(manager.id)
    const current = managerFingerprint(
      managerBundle(
        manager,
        manager.harness === 'codex',
        this.owner.tree.host.taskCards(manager.harness),
      ),
    )
    const applied = record?.applied ?? null
    return {
      mode: record?.plan?.mode ?? (manager.harness === 'claude-code' ? 'refresh' : 'replace'),
      current,
      applied,
      outdated: current !== applied,
      phase: record?.phase ?? 'idle',
      ...(record?.error ? { error: record.error } : {}),
      ...(record?.operation
        ? {
            operation: {
              ...record.operation,
              committed: !!record.committed || record.operation.committed,
            },
          }
        : {}),
    }
  }
  held(threadId: string): boolean {
    const manager = this.owner.store.forThread(threadId)
    return (
      !!manager &&
      ['waiting', 'summarizing', 'applying'].includes(
        this.owner.store.reset(manager.id)?.phase ?? '',
      )
    )
  }
  /** 接班输入确认之前，子线回报不得抢先开启新经理首轮；失败时由界面显示错误。 */
  handoverPending(threadId: string): boolean {
    const manager = this.owner.store.forThread(threadId)
    const record = manager ? this.owner.store.reset(manager.id) : null
    return record?.operation?.committed === true && record.operation.handover === 'pending'
  }
  /** 等待阶段用户输入优先；使已经在读引擎状态的旧任务失效，不能随后覆盖取消。 */
  cancel(id: string): void {
    const record = this.owner.store.reset(id)
    if (!record || !['waiting', 'summarizing', 'applying'].includes(record.phase)) return
    if (record.phase !== 'waiting')
      throw new ManagerError(
        'managerResetBusy',
        'Manager reset has started and cannot be cancelled.',
      )
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    this.owner.store.saveReset({ ...record, phase: 'idle' })
    this.owner.changed(id)
    this.owner.kick(id)
    this.owner.tree.check(record.oldThreadId)
  }
  /** 所有引擎的等待阶段都可取消；摘要和提交开始后仍保留写入边界。 */
  beforeInput(threadId: string): void {
    const manager = this.owner.store.forThread(threadId)
    if (manager && this.owner.store.reset(manager.id)?.phase === 'waiting') this.cancel(manager.id)
  }
  busyError(): ManagerError {
    return new ManagerError(
      'managerResetBusy',
      'Manager reset is applying; try again when it finishes.',
    )
  }
  checkRequest(threadId: string, method: string): void {
    if (['turn/start', 'turn/steer', 'thread/queue/add', 'thread/queue/start'].includes(method))
      this.beforeInput(threadId)
    if (!this.held(threadId)) return
    // 订阅和附件观察不冻结；否则重连会把临时等待固化为只读视图。
    if (
      [
        'thread/read',
        'thread/turns/list',
        'thread/unsubscribe',
        'thread/resume',
        'thread/goal/get',
        'thread/queue/list',
        'turn/interrupt',
        ATTACHMENT_WATCH_METHOD,
        ATTACHMENT_STATUS_METHOD,
      ].includes(method)
    )
      return
    throw this.busyError()
  }
  refusal(threadId: string): string | null {
    const current = this.owner.store.historical(threadId)
    if (current)
      return `This manager conversation is read-only. The current manager session is ${current.threadId}.`
    for (const manager of this.owner.store.managers()) {
      const record = this.owner.store.reset(manager.id)
      if (record?.candidate?.thread.id === threadId && manager.threadId !== threadId)
        return 'This candidate manager conversation is read-only until handover is committed.'
    }
    return null
  }
  toolsAllowed(threadId: string, namespace: unknown, tool: unknown): boolean {
    if (this.refusal(threadId)) return false
    const manager = this.owner.store.forThread(threadId)
    const phase = manager && this.owner.store.reset(manager.id)?.phase
    if (phase !== 'summarizing' && phase !== 'applying') return true
    return (
      (namespace === 'litch_manager' && ['summary', 'get', 'post_get'].includes(String(tool))) ||
      (namespace === 'litch_sessions' && ['read', 'list', 'options'].includes(String(tool)))
    )
  }
  /** 内部自动入口与外部 RPC 共享冻结/历史边界，仅本操作的摘要输入可以穿过冻结。 */
  checkInternalInput(method: string, value: unknown): void {
    if (
      !isObject(value) ||
      typeof value.threadId !== 'string' ||
      ![
        'turn/start',
        'turn/steer',
        'thread/queue/add',
        'thread/queue/start',
        'thread/goal/set',
        'thread/resume',
      ].includes(method)
    )
      return
    const refusal = this.refusal(value.threadId)
    if (refusal) throw new ManagerError('managerReadOnly', refusal)
    if (method === 'thread/resume') return
    if (this.held(value.threadId) && !this.summaryInputs.has(value)) throw this.busyError()
  }
  readingSettings(value: unknown): boolean {
    return isObject(value) && this.settingsReads.has(value)
  }
  async readSettings(manager: Manager): Promise<Record<string, unknown>> {
    const link = await this.owner.tree.link(manager.harness)
    const params = { threadId: manager.threadId, excludeTurns: true }
    this.settingsReads.add(params)
    try {
      const result = await link.request('thread/resume', params)
      if (!isObject(result)) throw new Error('The source manager settings are unavailable.')
      this.owner.tree.noteSubscribed(manager.harness, manager.threadId)
      this.owner.tree.releaseLater(manager.harness, manager.threadId)
      return result
    } finally {
      this.settingsReads.delete(params)
    }
  }
  async preview(id: string, given?: unknown): Promise<ManagerResetPreview> {
    const manager = this.owner.store.manager(id)
    if (!manager) throw new ManagerError('unknownManager', 'This manager does not exist.')
    const plan = await managerResetPlan(
      this.owner.tree,
      manager,
      given === undefined ? undefined : resetTarget(given),
    )
    const {
      sourceConfig: _sourceConfig,
      managerSnapshot: _snapshot,
      targetConfig: _targetConfig,
      ...preview
    } = plan
    return preview
  }
  private requestHash(given: Record<string, unknown>, plan: ManagerResetPlan): string {
    const target = resetTarget(given.target)
    return managerFingerprint({
      target: {
        ...target,
        model: target.model ?? plan.target.model,
        effort: target.effort ?? plan.target.effort,
        dispatch: target.dispatch ?? plan.managerSnapshot.dispatch,
      },
      expectedThreadId: given.expectedThreadId,
      expectedSettingsHash: given.expectedSettingsHash,
    })
  }
  async requestTarget(given: Record<string, unknown>): Promise<ResetRecord | undefined> {
    const id = text(given.managerId, 'managerId')
    if (given.target === undefined) {
      if (
        ['requestId', 'expectedThreadId', 'expectedSettingsHash'].some(
          (key) => given[key] !== undefined,
        )
      )
        throw new ManagerError(
          'invalidManager',
          'Target settings are required with reset confirmation fields.',
        )
      this.request(id, given.boardOnly === true)
      return
    }
    const target = resetTarget(given.target)
    const requestId = text(given.requestId, 'requestId')
    text(given.expectedThreadId, 'expectedThreadId')
    text(given.expectedSettingsHash, 'expectedSettingsHash')
    const prior = () => {
      const previous = this.owner.store.resetRequest(id, requestId)
      if (!previous?.plan) return null
      if (previous.requestHash !== this.requestHash(given, previous.plan))
        throw new ManagerError(
          'managerResetConflict',
          'This requestId was already used with another reset plan.',
        )
      return previous
    }
    let previous = prior()
    if (previous) {
      if (given.boardOnly === true && previous.phase === 'summaryFailed') {
        const current = this.owner.store.reset(id)
        if (current?.operation?.requestId !== requestId) throw this.busyError()
        this.request(id, true, previous.plan, previous)
        return this.owner.store.reset(id) ?? undefined
      }
      return previous
    }
    if (given.boardOnly === true)
      throw new ManagerError(
        'invalidManager',
        'Board-only takeover must retry the original failed summary request.',
      )
    const manager = this.owner.store.manager(id)
    if (!manager) throw new ManagerError('unknownManager', 'This manager does not exist.')
    if (this.held(manager.threadId)) throw this.busyError()
    const plan = await managerResetPlan(this.owner.tree, manager, target)
    previous = prior()
    if (previous) return previous
    if (this.held(manager.threadId)) throw this.busyError()
    if (
      JSON.stringify(manager) !== JSON.stringify(this.owner.store.manager(id)) ||
      given.expectedThreadId !== manager.threadId ||
      given.expectedSettingsHash !== plan.expectedSettingsHash
    )
      throw new ManagerError(
        'managerResetConflict',
        'Manager settings changed; preview and confirm again.',
      )
    if (!plan.canSubmit)
      throw new ManagerError(
        'managerResetUnavailable',
        'The target cannot take over this manager.',
        { reasons: plan.reasons },
      )
    this.request(id, given.boardOnly === true, plan, {
      managerId: id,
      oldThreadId: manager.threadId,
      phase: 'waiting',
      applied: this.owner.store.reset(id)?.applied ?? null,
      plan,
      requestHash: this.requestHash(given, plan),
      operation: {
        requestId,
        source: { ...plan.source, threadId: manager.threadId },
        target: plan.target,
        expectedSettingsHash: plan.expectedSettingsHash,
        candidateThreadId: null,
        committed: false,
        handover: 'pending',
      },
    })
    return this.owner.store.reset(id) ?? undefined
  }
  request(id: string, boardOnly: boolean, plan?: ManagerResetPlan, intent?: ResetRecord): void {
    const manager = this.owner.store.manager(id)
    if (!manager || manager.status !== 'active')
      throw new ManagerError('managerEnded', 'Only an active manager can be reset.')
    if (this.held(manager.threadId)) return
    if ((plan?.mode ?? (manager.harness === 'claude-code' ? 'refresh' : 'replace')) === 'replace')
      this.checkSchedule(manager)
    const previous = this.owner.store.reset(id)
    if (!plan && previous?.operation && ['summaryFailed', 'failed'].includes(previous.phase))
      throw new ManagerError(
        'managerResetConflict',
        'Retry this reset with the original target and requestId, or cancel it first.',
      )
    if (boardOnly && previous?.phase !== 'summaryFailed')
      throw new ManagerError(
        'invalidManager',
        'Board-only takeover is available only after summary failure.',
      )
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    const { error: _error, ...cleanIntent } = intent ?? {}
    this.owner.store.saveReset({
      ...cleanIntent,
      managerId: id,
      oldThreadId: manager.threadId,
      applied: previous?.applied ?? null,
      phase: 'waiting',
      ...(plan ? { plan } : {}),
      ...(boardOnly ? { summaryStarting: false } : {}),
      ...(boardOnly ? { summaryTurnId: 'board-only' } : {}),
    })
    this.owner.changed(id)
    this.tick(id)
  }
  tick(id: string): void {
    if (this.closed || this.jobs.has(id)) return
    const record = this.owner.store.reset(id)
    if (record?.phase === 'ready' && (record.operation || record.cleanup?.length)) {
      const job = this.afterCommit(record)
        .catch((error) => this.owner.tree.host.log(`经理接班恢复待重试：${String(error)}`))
        .finally(() => this.jobs.delete(id))
      this.jobs.set(id, job)
      return
    }
    if (!record || !['waiting', 'summarizing', 'applying'].includes(record.phase)) return
    const revision = this.revisions.get(id)
    const cancelled = () => this.closed || this.revisions.get(id) !== revision
    const job = this.run(record, cancelled)
      .catch(async (error: unknown) => {
        if (cancelled()) return
        const latest = this.owner.store.reset(id)
        // 提交后只向前恢复，绝不能再启第二个候选经理。
        if (record.phase === 'applying' && record.oldTools) return
        if (latest?.committed) {
          this.owner.store.saveReset({ ...latest, error: String(error), phase: 'applying' })
          this.owner.changed(id)
          this.owner.tree.host.log(`经理换绑待恢复：${String(error)}`)
          return
        }
        const { committed: _uncommitted, ...failed } = record
        this.owner.store.saveReset({
          ...failed,
          applied: latest?.applied ?? null,
          phase: record.phase === 'summarizing' ? 'summaryFailed' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        this.owner.changed(id)
        this.owner.kick(id)
        if (record.candidate && record.plan) {
          try {
            const target = await this.owner.tree.link(record.plan.target.harness)
            await target.request('thread/unsubscribe', { threadId: record.candidate.thread.id })
          } catch (cleanupError) {
            this.owner.tree.host.log(`未提交候选退订待人工核对：${String(cleanupError)}`)
          }
        }
      })
      .finally(() => this.jobs.delete(id))
    this.jobs.set(id, job)
  }
  private async safe(manager: Manager, record?: ResetRecord): Promise<boolean> {
    const tree = this.owner.tree
    // Claude 只替换下轮加载的工具，不换线程；后台任务、旁问和目标不需要停下。
    if (
      (record?.plan?.mode ?? (manager.harness === 'claude-code' ? 'refresh' : 'replace')) ===
      'refresh'
    )
      return this.turnSettled(manager)
    this.checkSchedule(manager)
    const link = await tree.link(manager.harness)
    const features = isObject(link.runtime?.features) ? link.runtime.features : {}
    if (features.goals === true) {
      const result = await link.request('thread/goal/get', { threadId: manager.threadId })
      if (result.goal && !['complete', 'cleared', 'paused'].includes(result.goal.status))
        throw new Error('Pause or complete the manager goal before resetting its session.')
    }
    if (
      this.owner.questions.busy(manager.id) ||
      tree.pendingRequests(manager.threadId).length ||
      tree.host.toolsBusy?.(manager.threadId) ||
      tree.store.childStarts().some((child) => child.parentId === manager.threadId) ||
      tree.host.backgroundRunning(manager.threadId) > 0 ||
      tree.host.continuationPending?.(manager.threadId)
    )
      return false
    return this.turnSettled(manager)
  }
  private async turnSettled(manager: Manager): Promise<boolean> {
    const tree = this.owner.tree
    const { thread } = await tree.read(manager.threadId, true)
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    return (
      isObject(thread.status) &&
      thread.status.type !== 'active' &&
      !turns.some((turn) => isObject(turn) && turn.status === 'inProgress') &&
      !tree.isActive(manager.threadId)
    )
  }
  private async run(record: ResetRecord, cancelled: () => boolean): Promise<void> {
    if (record.committed) {
      this.finish(record)
      const after = record.committed.manager
      if (record.candidate)
        this.owner.tree.host.threadStarted(after.harness, record.candidate.thread)
      for (const child of this.owner.tree.store.childrenOf(after.threadId))
        this.owner.tree.lineageChanged(child.threadId)
      this.owner.changed(after.id)
      this.owner.kick(after.id)
      this.owner.tree.suggestions.changed()
      await this.afterCommit(this.owner.store.reset(record.managerId) ?? record)
      return
    }
    const manager = this.owner.store.manager(record.managerId)
    if (!manager || manager.status !== 'active') throw new Error('Manager is no longer active.')
    const tree = this.owner.tree
    await this.owner.settleDeliveries(manager.id)
    await tree.settleManagerQueue(manager.threadId)
    if (cancelled() || !(await this.safe(manager, record)) || cancelled()) return
    const link = await tree.link(manager.harness)
    if (cancelled()) return
    if (record.plan) await this.revalidate(manager, record)
    if (cancelled()) return
    const targetHarness = record.plan?.target.harness ?? manager.harness
    const targetLink = targetHarness === manager.harness ? link : await tree.link(targetHarness)
    if (cancelled()) return
    const targetManager = record.plan
      ? {
          ...manager,
          ...record.plan.target,
          dispatch: record.plan.target.dispatch ?? manager.dispatch,
        }
      : manager
    const bundle = managerBundle(
      targetManager,
      targetLink.native,
      tree.host.taskCards(targetHarness),
    )
    const names = new Set(bundle.map((spec) => spec.name))
    const known = new Set<string>(Object.values(CLIENT_TOOL_NAMESPACE))
    // 重置与恢复按同一份设备设置补齐或移除常驻工具；回滚仍原样恢复旧定义。
    const tools = tree.host.refreshClientTools(targetHarness, [
      ...(targetHarness === manager.harness
        ? (tree.store.tools(manager.threadId) ?? [])
        : []
      ).filter(
        (spec) => isObject(spec) && known.has(String(spec.name)) && !names.has(String(spec.name)),
      ),
      ...bundle,
    ])
    const fingerprint = managerFingerprint(bundle)
    if (
      (record.plan?.mode ?? (manager.harness === 'claude-code' ? 'refresh' : 'replace')) ===
      'refresh'
    ) {
      const oldTools = record.oldTools ?? tree.store.tools(manager.threadId)
      if (!oldTools) throw new Error('The installed manager tool snapshot is unavailable.')
      // 重启时看到 applying 表示此前尚未确认，先恢复旧定义，不能把写过文件当作成功。
      if (record.phase === 'applying') {
        await link.request('thread/resume', {
          threadId: manager.threadId,
          excludeTurns: true,
          dynamicTools: oldTools,
        })
        tree.store.setTools(manager.threadId, oldTools)
        record.phase = 'failed'
        throw new Error(
          'The interrupted refresh was restored; reset again to apply the new capabilities.',
        )
      }
      record.phase = 'applying'
      record.oldTools = oldTools
      this.owner.store.saveReset(record)
      this.owner.changed(manager.id)
      try {
        await link.request('thread/resume', {
          threadId: manager.threadId,
          excludeTurns: true,
          dynamicTools: tools,
        })
        tree.store.setTools(manager.threadId, tools)
        this.owner.store.transaction(() => {
          this.owner.store.saveReset({
            ...(record.operation
              ? {
                  ...record,
                  operation: { ...record.operation, committed: true, handover: 'accepted' },
                }
              : {}),
            managerId: manager.id,
            oldThreadId: manager.threadId,
            phase: 'ready',
            applied: fingerprint,
          })
          this.owner.store.record(
            manager.id,
            'manager',
            'device',
            null,
            { capabilityFingerprint: fingerprint },
            'Manager tools refreshed; applies on the next turn',
          )
        })
      } catch (error) {
        try {
          await link.request('thread/resume', {
            threadId: manager.threadId,
            excludeTurns: true,
            dynamicTools: oldTools,
          })
        } catch (restoreError) {
          this.owner.tree.host.log(
            `经理刷新旧定义恢复未确认，保留冻结并重试：${String(restoreError)}`,
          )
          return
        }
        tree.store.setTools(manager.threadId, oldTools)
        record.phase = 'failed'
        throw error
      }
      this.owner.changed(manager.id)
      this.owner.kick(manager.id)
      tree.check(manager.threadId)
      return
    }
    if (!record.summaryTurnId) {
      if (record.summaryStarting)
        throw new Error(
          'The interrupted summary request has an unknown result. Confirm board-only takeover or start a new reset.',
        )
      record.phase = 'summarizing'
      record.summaryStarting = true
      this.owner.store.saveReset(record)
      this.owner.changed(manager.id)
      const input = {
        threadId: manager.threadId,
        input: [{ type: 'text', text: MANAGER_SUMMARY_PROMPT, text_elements: [] }],
        ...((record.plan?.source.effort ?? manager.effort)
          ? { effort: record.plan?.source.effort ?? manager.effort }
          : {}),
        ...(record.plan?.source.model ? { model: record.plan.source.model } : {}),
      }
      this.summaryInputs.add(input)
      let result: any
      try {
        result = await link.request('turn/start', input)
      } finally {
        this.summaryInputs.delete(input)
      }
      if (typeof result?.turn?.id !== 'string')
        throw new Error('The handover summary did not start.')
      record.summaryTurnId = result.turn.id
      record.summaryStarting = false
      this.owner.store.saveReset(record)
      tree.turnEvent(manager.harness, 'turn/started', {
        threadId: manager.threadId,
        turn: result.turn,
      })
      return
    }
    let summary = ''
    if (record.summaryTurnId !== 'board-only') {
      const { thread } = await tree.read(manager.threadId, true)
      const turn = (Array.isArray(thread.turns) ? thread.turns : []).find(
        (one) => isObject(one) && one.id === record.summaryTurnId,
      )
      if (
        !isObject(turn) ||
        turn.status !== 'completed' ||
        !(summary = lastAnswer(turn) ?? '').trim()
      )
        throw new Error('Handover summary failed. Confirm board-only takeover to continue.')
    }
    record.phase = 'applying'
    this.owner.store.saveReset(record)
    const { config } = record.plan
      ? { config: record.plan.sourceConfig }
      : await parentSettings(tree, manager.threadId, manager.harness)
    const permissions = childPermissions(
      config,
      record.plan ? { permission: record.plan.target.permission } : {},
      targetLink,
    )
    if (record.plan && manager.harness !== targetHarness) delete permissions.approvalPolicy
    const model =
      record.plan?.target.model ??
      (typeof config?.model === 'string' ? config.model : manager.model)
    const effort = record.plan
      ? record.plan.target.effort
      : typeof config?.reasoningEffort === 'string'
        ? config.reasoningEffort
        : manager.effort
    if (!record.candidate && record.candidateStarting)
      throw new Error(
        'Candidate creation has an unknown result; this request will not create another thread.',
      )
    if (!record.candidate) {
      record.candidateStarting = true
      this.owner.store.saveReset(record)
      const created = await targetLink.request('thread/start', {
        cwd: manager.cwd,
        dynamicTools: tools,
        ...(model ? { model } : {}),
        ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
        ...permissions,
        ...(record.plan
          ? record.plan.targetConfig
          : {
              ...(typeof config?.modelProvider === 'string'
                ? { modelProvider: config.modelProvider }
                : {}),
              ...(typeof config?.serviceTier === 'string'
                ? { serviceTier: config.serviceTier }
                : {}),
            }),
      })
      if (typeof created?.thread?.id !== 'string')
        throw new Error('The harness did not return a new manager thread.')
      record.candidate = { thread: created.thread }
      record.candidateStarting = false
      if (record.operation) record.operation.candidateThreadId = created.thread.id
      // 候选身份先于命名、复核和提交持久化；重启复用它，不重复 start。
      this.owner.store.saveReset(record)
    }
    const thread = record.candidate.thread
    const newId = String(thread.id)
    await targetLink.request('thread/name/set', { threadId: newId, name: manager.name })
    const index = record.plan ? await this.index(record, manager, newId) : () => ''
    if (this.closed || !(await this.safe(manager, record)))
      throw new Error('Manager became busy before reset commit.')
    if (record.plan) await this.revalidate(manager, record)
    if (JSON.stringify(this.owner.store.manager(manager.id)) !== JSON.stringify(manager))
      throw new Error('Manager settings changed before reset commit; retry.')
    const after = {
      ...manager,
      ...(record.plan ? { harness: targetHarness, dispatch: targetManager.dispatch } : {}),
      model,
      effort,
      permission: permissions.permissions,
      threadId: newId,
      updatedAt: managerNow(),
    }
    tree.host.index.see({ ...thread, id: newId }, targetHarness)
    tree.noteSubscribed(targetHarness, newId)
    record.applied = fingerprint
    record.cleanup = this.owner.questions.retirement(manager.id, manager.harness)
    record.handoverEventId ??= `litch-manager-handover-${record.operation?.requestId ?? newId}`
    record.committed = {
      manager: after,
      input: `${MANAGER_HANDOVER_PROMPT}\n\n[litch-manager-handover:${record.handoverEventId}]\n${index()}\n\nPrevious manager summary (reference only):\n${summary || 'No handover summary; use the manager board.'}`,
    }
    this.checkSchedule(manager)
    // 唯一提交点。此前任何失败都不改变经理绑定、看板、工作线与队列。
    this.owner.store.saveReset(record)
    this.finish(record)
    for (const child of tree.store.childrenOf(newId)) tree.lineageChanged(child.threadId)
    tree.host.threadStarted(targetHarness, thread)
    this.owner.changed(manager.id)
    this.owner.kick(manager.id)
    tree.suggestions.changed()
    await this.afterCommit(this.owner.store.reset(manager.id) ?? record)
  }
  private finish(record: ResetRecord): void {
    const after = record.committed?.manager
    if (!after) return
    this.owner.tree.host.index.see(
      { ...record.candidate?.thread, id: after.threadId, updatedAt: after.updatedAt },
      after.harness,
    )
    this.owner.tree.store.rebindManager(record.oldThreadId, after.threadId)
    this.owner.store.finishRebind(record)
  }
  private async revalidate(manager: Manager, record: ResetRecord): Promise<void> {
    if (!record.plan) return
    const plan = await managerResetPlan(this.owner.tree, manager, record.plan.target)
    if (!plan.canSubmit || plan.expectedSettingsHash !== record.plan.expectedSettingsHash)
      throw new ManagerError(
        'managerResetConflict',
        'Source or target settings changed after confirmation; preview again.',
        { reasons: plan.reasons },
      )
  }
  private checkSchedule(manager: Manager): void {
    const reasons = managerResetScheduleIssues(this.owner.tree, manager.threadId)
    if (reasons.length)
      throw new ManagerError(
        'managerResetUnavailable',
        reasons.map((reason) => reason.message).join('\n'),
        { reasons },
      )
  }
  private async index(record: ResetRecord, manager: Manager, newId: string): Promise<() => string> {
    const tree = this.owner.tree
    await this.owner.lines.refresh(manager.id)
    const lines = this.owner.board(manager.id).lines
    const sampled = new Set(lines.slice(0, 16).map((line) => line.threadId))
    const questions: Record<string, unknown>[] = []
    const checked = new Set<string>()
    await Promise.all(
      lines.slice(0, 16).map(async (line) => {
        try {
          const { thread } = await tree.read(line.threadId, true)
          checked.add(line.threadId)
          for (const question of questionsOfHistory(
            thread,
            tree.store.ignoredQuestions(line.threadId),
            [],
            tree.store.questionSettlements(line.threadId),
          ))
            questions.push({
              threadId: line.threadId,
              questionId: question.sourceIds[0],
              title: question.title.slice(0, 40),
              status: '需读取该线核对',
            })
        } catch {
          questions.push({ threadId: line.threadId, status: '未知；需读取该线核对' })
        }
      }),
    )
    return () => {
      const board = this.owner.board(manager.id)
      const deliveries = this.owner.store.deliveries(manager.id)
      const head = (entry: { id: string; title: string; status?: unknown; revision?: number }) => ({
        id: entry.id,
        title: entry.title.slice(0, 40),
        status: entry.status,
        revision: entry.revision,
      })
      const posts = board.posts ?? []
      const ordinary = this.owner.store
        .issues(manager.id)
        .filter(isObject)
        .map(
          (issue): Record<string, unknown> => ({
            ...issue,
            unread:
              this.owner.store.issueUnread(manager.id, String(issue.id), 'manager') ||
              this.owner.store.issueUnread(manager.id, String(issue.id), 'user'),
          }),
        )
      const boardQuestions = posts.flatMap(
        (post) =>
          post.discussion?.messages
            .filter((entry) => entry.mode === 'manager' && entry.status === 'running')
            .map((entry) => ({ id: post.id, questionId: entry.id, revision: post.revision })) ?? [],
      )
      return managerHandoverIndex(
        {
          managerId: manager.id,
          requestId: record.operation?.requestId,
          source: record.operation?.source,
          target: { ...record.plan?.target, threadId: newId },
          generatedAt: managerNow(),
          boardVersion: board.changes[0]?.id ?? null,
          queue: {
            total: deliveries.length,
            firstEventId: deliveries[0]?.id ?? null,
            lastEventId: deliveries.at(-1)?.id ?? null,
          },
          history: {
            threadId: manager.threadId,
            harness: manager.harness,
            read: 'litch_sessions.read(thread_id)，只读历史仍需原 harness 可用',
          },
          note: '时间点索引；idle 不代表验收完成；先读最新看板和工作线。子线审批须重新 read 后取得当前请求身份；此索引不携带执行器 requestId。',
        },
        {
          lines: {
            entries: board.lines.map((line) => ({
              threadId: line.threadId,
              title: line.title.slice(0, 40),
              status: checked.has(line.threadId) ? line.status : '未知',
              acceptance: '需核对',
              checkedAt: this.owner.lines.checkedAt.get(line.threadId) ?? null,
              pendingRequests: tree.pendingRequests(line.threadId).length,
            })),
            read: 'litch_sessions.list/read；litch_manager.summary',
          },
          items: {
            entries: board.items.filter((entry) => entry.status !== 'done').map(head),
            read: 'litch_manager.summary/get(id)',
          },
          decisions: {
            entries: board.decisions.filter((entry) => entry.status === 'open').map(head),
            read: 'litch_manager.summary/get(id)',
          },
          requests: {
            entries: (board.requests ?? []).filter((entry) => entry.status === 'open').map(head),
            read: 'litch_manager.summary/get(id)',
          },
          answeredPending: {
            entries: [...board.decisions, ...(board.requests ?? [])]
              .filter(
                (entry) =>
                  ['answered', 'replied', 'delivered'].includes(entry.status) &&
                  deliveries.some((event) => event.text.includes(entry.id)),
              )
              .map(head),
            read: 'litch_manager.get(id)；随后队列仍按顺序投递，勿重复执行业务指令',
          },
          suggestions: {
            entries: posts
              .filter((entry) => entry.kind === 'suggestion' && entry.fields.status === 'pending')
              .map(head),
            read: 'litch_manager.summary/post_get(id)',
          },
          unread: {
            entries: [
              ...posts.filter((entry) => entry.kind === 'report' && entry.unread).map(head),
              ...ordinary
                .filter(
                  (entry) =>
                    entry.unread || (entry.status !== 'closed' && entry.status !== 'resolved'),
                )
                .map((entry) => ({
                  id: entry.id,
                  title: String(entry.title).slice(0, 40),
                  status: entry.status,
                  revision: entry.revision,
                  unread: entry.unread,
                })),
            ],
            read: 'litch_manager.summary/issue_get(id)/post_get(id)',
          },
          questions: {
            entries: [
              ...questions,
              ...boardQuestions,
              ...board.lines
                .filter((line) => !sampled.has(line.threadId))
                .map((line) => ({ threadId: line.threadId, status: '未展开；需读取该线核对' })),
            ],
            read: 'litch_sessions.read(thread_id)；litch_manager.post_get(id)',
          },
        },
      )
    }
  }
  private async afterCommit(record: ResetRecord): Promise<void> {
    for (const group of record.cleanup ?? []) {
      try {
        await this.owner.questions.retireOwned(group.harness, group.threadIds)
        const latest = this.owner.store.reset(record.managerId)
        if (!latest || latest.operation?.requestId !== record.operation?.requestId) return
        latest.cleanup = (latest.cleanup ?? []).filter((one) => one.harness !== group.harness)
        this.owner.store.saveReset(latest)
      } catch (error) {
        this.owner.tree.host.log(`旧经理旁问释放待重试（${group.harness}）：${String(error)}`)
      }
    }
    if (record.handoverTurnId && !record.handoverSettled && record.committed) {
      const result = await this.owner.tree
        .read(record.committed.manager.threadId, true)
        .catch((error) => {
          this.owner.tree.host.log(`接班回合状态暂不可核对：${String(error)}`)
          return null
        })
      if (!result) return
      const { thread } = result
      const turn = (Array.isArray(thread.turns) ? thread.turns : []).find(
        (one) => isObject(one) && one.id === record.handoverTurnId,
      )
      if (!isObject(turn) || !['completed', 'failed', 'interrupted'].includes(String(turn.status)))
        return
      const latest = this.owner.store.reset(record.managerId)
      if (!latest?.operation || latest.operation.requestId !== record.operation?.requestId) return
      latest.handoverSettled = true
      latest.operation.handover = turn.status === 'completed' ? 'accepted' : 'failed'
      if (turn.status !== 'completed')
        latest.error =
          'The manager binding changed, but the handover turn failed or was interrupted.'
      else delete latest.error
      this.owner.store.saveReset(latest)
      this.owner.changed(record.managerId)
    }
  }
  handoverStarted(managerId: string, eventId: string, turnId: string): void {
    const record = this.owner.store.reset(managerId)
    if (!record?.operation || record.handoverEventId !== eventId) return
    record.handoverTurnId = turnId
    this.owner.store.saveReset(record)
  }
  handoverFailed(managerId: string, eventId: string, error: unknown): void {
    const record = this.owner.store.reset(managerId)
    if (!record?.operation || record.handoverEventId !== eventId) return
    record.operation.handover = 'failed'
    record.error = `The manager binding changed, but handover delivery failed: ${String(error)}`
    this.owner.store.saveReset(record)
    this.owner.changed(managerId)
  }
  /** 应答可能丢失；先核对稳定输入身份，不能把超时等同于未执行。 */
  async reconcileHandover(manager: Manager, eventId: string, text: string): Promise<boolean> {
    const record = this.owner.store.reset(manager.id)
    if (!record?.operation || record.handoverEventId !== eventId) return false
    const { thread } = await this.owner.tree.read(manager.threadId, true)
    const turn = (Array.isArray(thread.turns) ? thread.turns : []).find(
      (one) =>
        isObject(one) &&
        Array.isArray(one.items) &&
        one.items.some(
          (item) =>
            isObject(item) &&
            item.type === 'userMessage' &&
            Array.isArray(item.content) &&
            item.content.some(
              (part) => isObject(part) && part.type === 'text' && part.text === text,
            ),
        ),
    )
    if (!isObject(turn) || typeof turn.id !== 'string') return false
    this.handoverStarted(manager.id, eventId, turn.id)
    return true
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.jobs.values())
  }
}
