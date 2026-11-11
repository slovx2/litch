import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import {
  ATTACHMENT_STATUS_METHOD,
  ATTACHMENT_WATCH_METHOD,
} from '../../protocol/src/file-attachments.mjs'
import type { Manager, ManagerResetState } from '../../protocol/src/manager.mjs'
import type { DeviceManagers } from './manager.mjs'
import {
  MANAGER_HANDOVER_PROMPT,
  MANAGER_SUMMARY_PROMPT,
  managerBundle,
  managerFingerprint,
} from './manager-rules.mjs'
import type { ResetRecord } from './manager-store.mjs'
import { managerNow } from './manager-store.mjs'
import { ManagerError } from './manager-validate.mjs'
import { childPermissions } from './session-permissions.mjs'
import { parentSettings } from './session-start.mjs'
import { lastAnswer } from './session-tree.mjs'
import { isObject } from './wire.mjs'

/** 只有用户 RPC 能排入重置。提交意图先耐久保存，跨库的路由更新随后幂等重放。 */
export class ManagerResets {
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private closed = false
  readonly owner: DeviceManagers
  constructor(owner: DeviceManagers) {
    this.owner = owner
    for (const manager of owner.store.managers()) {
      const record = owner.store.reset(manager.id)
      if (record?.committed) this.finish(record)
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
      mode: manager.harness === 'claude-code' ? 'refresh' : 'replace',
      current,
      applied,
      outdated: current !== applied,
      phase: record?.phase ?? 'idle',
      ...(record?.error ? { error: record.error } : {}),
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
    this.owner.store.saveReset({
      managerId: id,
      oldThreadId: record.oldThreadId,
      applied: record.applied,
      phase: 'idle',
    })
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
  request(id: string, boardOnly: boolean): void {
    const manager = this.owner.store.manager(id)
    if (!manager || manager.status !== 'active')
      throw new ManagerError('managerEnded', 'Only an active manager can be reset.')
    if (this.held(manager.threadId)) return
    const previous = this.owner.store.reset(id)
    if (boardOnly && previous?.phase !== 'summaryFailed')
      throw new ManagerError(
        'invalidManager',
        'Board-only takeover is available only after summary failure.',
      )
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    this.owner.store.saveReset({
      managerId: id,
      oldThreadId: manager.threadId,
      applied: previous?.applied ?? null,
      phase: 'waiting',
      ...(boardOnly ? { summaryTurnId: 'board-only' } : {}),
    })
    this.owner.changed(id)
    this.tick(id)
  }
  tick(id: string): void {
    if (this.closed || this.jobs.has(id)) return
    const record = this.owner.store.reset(id)
    if (!record || !['waiting', 'summarizing', 'applying'].includes(record.phase)) return
    const revision = this.revisions.get(id)
    const cancelled = () => this.closed || this.revisions.get(id) !== revision
    const job = this.run(record, cancelled)
      .catch((error: unknown) => {
        if (cancelled()) return
        const latest = this.owner.store.reset(id)
        // 提交后只向前恢复，绝不能再启第二个候选经理。
        if (record.phase === 'applying' && record.oldTools) return
        if (latest?.committed) {
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
      })
      .finally(() => this.jobs.delete(id))
    this.jobs.set(id, job)
  }
  private async safe(manager: Manager): Promise<boolean> {
    const tree = this.owner.tree
    // Claude 只替换下轮加载的工具，不换线程；后台任务、旁问和目标不需要停下。
    if (manager.harness === 'claude-code') return this.turnSettled(manager)
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
      for (const child of this.owner.tree.store.childrenOf(after.threadId))
        this.owner.tree.lineageChanged(child.threadId)
      this.owner.changed(after.id)
      this.owner.kick(after.id)
      this.owner.tree.suggestions.changed()
      return
    }
    const manager = this.owner.store.manager(record.managerId)
    if (!manager || manager.status !== 'active') throw new Error('Manager is no longer active.')
    const tree = this.owner.tree
    await this.owner.settleDeliveries(manager.id)
    await tree.settleManagerQueue(manager.threadId)
    if (cancelled() || !(await this.safe(manager)) || cancelled()) return
    const link = await tree.link(manager.harness)
    if (cancelled()) return
    const bundle = managerBundle(manager, link.native, tree.host.taskCards(manager.harness))
    const names = new Set(bundle.map((spec) => spec.name))
    const known = new Set<string>(Object.values(CLIENT_TOOL_NAMESPACE))
    // 重置与恢复按同一份设备设置补齐或移除常驻工具；回滚仍原样恢复旧定义。
    const tools = tree.host.refreshClientTools(manager.harness, [
      ...(tree.store.tools(manager.threadId) ?? []).filter(
        (spec) => isObject(spec) && known.has(String(spec.name)) && !names.has(String(spec.name)),
      ),
      ...bundle,
    ])
    const fingerprint = managerFingerprint(bundle)
    if (manager.harness === 'claude-code') {
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
      record.phase = 'summarizing'
      this.owner.store.saveReset(record)
      this.owner.changed(manager.id)
      const result = await link.request('turn/start', {
        threadId: manager.threadId,
        input: [{ type: 'text', text: MANAGER_SUMMARY_PROMPT, text_elements: [] }],
        ...(manager.effort ? { effort: manager.effort } : {}),
      })
      if (typeof result?.turn?.id !== 'string')
        throw new Error('The handover summary did not start.')
      record.summaryTurnId = result.turn.id
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
    const { config } = await parentSettings(tree, manager.threadId, manager.harness)
    const permissions = childPermissions(config, {}, link)
    const model = typeof config?.model === 'string' ? config.model : manager.model
    const effort =
      typeof config?.reasoningEffort === 'string' ? config.reasoningEffort : manager.effort
    const created = await link.request('thread/start', {
      cwd: manager.cwd,
      dynamicTools: tools,
      ...(model ? { model } : {}),
      ...permissions,
      ...(typeof config?.modelProvider === 'string' ? { modelProvider: config.modelProvider } : {}),
      ...(typeof config?.serviceTier === 'string' ? { serviceTier: config.serviceTier } : {}),
    })
    if (typeof created?.thread?.id !== 'string')
      throw new Error('The harness did not return a new manager thread.')
    const newId = created.thread.id as string
    await link.request('thread/name/set', { threadId: newId, name: manager.name })
    if (this.closed || !(await this.safe(manager)))
      throw new Error('Manager became busy before reset commit.')
    if (JSON.stringify(this.owner.store.manager(manager.id)) !== JSON.stringify(manager))
      throw new Error('Manager settings changed before reset commit; retry.')
    const after = {
      ...manager,
      model,
      effort,
      permission: permissions.permissions,
      threadId: newId,
      updatedAt: managerNow(),
    }
    tree.host.index.see(created.thread, manager.harness)
    tree.noteSubscribed(manager.harness, newId)
    record.applied = fingerprint
    record.committed = {
      manager: after,
      input: `${MANAGER_HANDOVER_PROMPT}\n\n${summary || 'No handover summary; use the manager board.'}`,
    }
    // 唯一提交点。此前任何失败都不改变经理绑定、看板、工作线与队列。
    this.owner.store.saveReset(record)
    this.finish(record)
    void this.owner.questions.retire(manager.id)
    for (const child of tree.store.childrenOf(newId)) tree.lineageChanged(child.threadId)
    tree.host.threadStarted(manager.harness, created.thread)
    this.owner.changed(manager.id)
    this.owner.kick(manager.id)
    tree.suggestions.changed()
  }
  private finish(record: ResetRecord): void {
    const after = record.committed?.manager
    if (!after) return
    this.owner.tree.store.rebindManager(record.oldThreadId, after.threadId)
    this.owner.store.finishRebind(record)
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.jobs.values())
  }
}
