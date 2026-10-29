// litchManager 的设备入口：建会话、读看板、投递持久事件，以及只向声明过的连接广播。
import { randomUUID } from 'node:crypto'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import {
  managerEndText,
  managerOpenText,
  managerRulesText,
} from '../../protocol/src/client-tools-manager.mjs'
import { PRESENTATION_SPEC } from '../../protocol/src/client-tools-presentation.mjs'
import { ruledNamespaces } from '../../protocol/src/codex-developer-instructions.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  MANAGER_METHOD,
  MANAGER_NOTIFICATION,
  type Manager,
  type ManagerActivity,
  type ManagerBoard,
  type ManagerObjectId,
} from '../../protocol/src/manager.mjs'
import { formatSessionEvent, parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import type { DeviceToolCall } from './device-tools.mjs'
import { isDecision, ManagerBoardWriter } from './manager-board.mjs'
import { ManagerEndings } from './manager-ending.mjs'
import { ManagerLines } from './manager-lines.mjs'
import { managerTools } from './manager-rules.mjs'
import { ManagerStore, managerNow, openManagerDatabase } from './manager-store.mjs'
import {
  fields,
  keys,
  ManagerError,
  text,
  validateCreate,
  validatePatch,
  validateTool,
} from './manager-validate.mjs'
import type { SessionTree } from './session-tree.mjs'
import { DeviceError, isObject } from './wire.mjs'

export class DeviceManagers {
  readonly store: ManagerStore
  readonly lines: ManagerLines
  readonly endings: ManagerEndings
  readonly writer: ManagerBoardWriter
  private readonly draining = new Map<string, Promise<void>>()
  private readonly timer: NodeJS.Timeout
  private closed = false
  private readonly unlisten: () => void
  readonly tree: SessionTree
  readonly born: (harness: string, thread: Record<string, unknown>) => void
  constructor(
    tree: SessionTree,
    stateDir: string,
    born: (harness: string, thread: Record<string, unknown>) => void = () => {},
  ) {
    this.tree = tree
    this.born = born
    this.store = new ManagerStore(openManagerDatabase(stateDir))
    this.lines = new ManagerLines(this.store, tree)
    this.endings = new ManagerEndings(this.store, tree, (id) => this.changed(id))
    this.writer = new ManagerBoardWriter(
      this.store,
      (managerId, threadId) =>
        this.lines.mark(threadId)?.managerId === managerId &&
        this.lines.mark(threadId)?.role === 'line',
    )
    this.unlisten = tree.onTurnEnded((threadId) => {
      const manager = this.lines.managerFor(threadId)
      if (manager) {
        this.changed(manager.id)
        this.kick(manager.id)
      }
    })
    this.timer = setInterval(() => {
      for (const id of new Set([
        ...this.store.deliveries().map((event) => event.managerId),
        ...this.store
          .managers()
          .filter((manager) => manager.status === 'ending')
          .map((manager) => manager.id),
      ]))
        this.kick(id)
    }, 1000)
    this.timer.unref()
  }
  manager(id: string): Manager {
    const manager = this.store.manager(id)
    if (!manager) throw new ManagerError('unknownManager', 'This manager does not exist.')
    const board = this.board(id)
    return {
      ...manager,
      pendingDecisions: board.decisions.filter((decision) => decision.status === 'open').length,
      runningLines: board.lines.filter((line) => line.running).length,
      latestActivity: board.activities[0] ?? null,
      updatedAt: Math.max(manager.updatedAt, board.activities[0]?.at ?? 0),
    }
  }
  board(id: string): ManagerBoard {
    if (!this.store.manager(id))
      throw new ManagerError('unknownManager', 'This manager does not exist.')
    const objects = this.store.objects(id)
    const changes = this.store.changes(id)
    const lines = this.lines.lines(id)
    const activities: ManagerActivity[] = changes.map((change) => ({
      id: change.id,
      kind:
        change.objectId === 'manager'
          ? 'manager'
          : change.objectId === 'status'
            ? 'status'
            : change.objectId.startsWith('D-')
              ? 'decision'
              : 'item',
      at: change.at,
      text: change.why,
      objectId:
        change.objectId === 'manager' || change.objectId === 'status' ? null : change.objectId,
      threadId: null,
      changeId: change.id,
    }))
    for (const line of lines)
      if (line.report)
        activities.push({
          id: `report:${line.threadId}:${this.store.report(line.threadId)?.turnId}`,
          kind: 'report',
          at: line.report.at,
          text: line.report.text,
          objectId: null,
          threadId: line.threadId,
          changeId: null,
        })
    activities.sort((a, b) => b.at - a.at)
    return {
      managerId: id,
      situation: this.store.situation(id),
      decisions: objects.filter(isDecision),
      items: objects.filter((object) => !isDecision(object)),
      lines,
      activities,
      changes,
    }
  }
  changed(id: string): void {
    if (this.closed) return
    this.tree.host.announce(
      MANAGER_NOTIFICATION.changed,
      { manager: this.manager(id) },
      EXTENSION.manager,
    )
    this.tree.host.announce(MANAGER_NOTIFICATION.boardChanged, { managerId: id }, EXTENSION.manager)
  }
  decorate(thread: Record<string, unknown>): void {
    delete thread.litchManager
    if (typeof thread.id !== 'string') return
    const mark = this.lines.mark(thread.id)
    if (mark) thread.litchManager = mark
  }
  observe(method: string, params: Record<string, unknown>): void {
    if (this.closed) return
    if (
      ![
        'turn/started',
        'turn/completed',
        'thread/started',
        'thread/status/changed',
        'thread/name/updated',
        'thread/archived',
        'thread/unarchived',
      ].includes(method)
    )
      return
    this.lines.observe(method, params)
    const thread = isObject(params.thread) ? params.thread : null
    const threadId =
      typeof params.threadId === 'string'
        ? params.threadId
        : typeof thread?.id === 'string'
          ? thread.id
          : null
    if (!threadId) return
    const manager = this.lines.managerFor(threadId)
    if (!manager) return
    const name =
      typeof params.threadName === 'string'
        ? params.threadName
        : typeof thread?.name === 'string'
          ? thread.name
          : null
    if (manager.threadId === threadId && name !== null && name !== manager.name) {
      this.store.transaction(() => {
        const after = { ...manager, name, updatedAt: managerNow() }
        this.store.saveManager(after)
        this.store.record(manager.id, 'manager', 'device', manager, after, 'Thread renamed')
      })
    }
    this.changed(manager.id)
  }
  report(threadId: string, turnId: string, report: string, status: string): void {
    if (this.closed) return
    const mark = this.lines.mark(threadId)
    if (mark?.role !== 'line') return
    this.store.saveReport(threadId, { text: report, turnId, status, at: managerNow() })
    this.changed(mark.managerId)
  }
  async call(method: string, given: unknown, declared: boolean): Promise<unknown> {
    if (!declared)
      throw new DeviceError(
        'extensionRequired',
        `${method} requires litchManager. Declare it in capabilities.litchExtensions.`,
        { method, required: [EXTENSION.manager] },
      )
    const params = fields(given ?? {})
    if (method === MANAGER_METHOD.list) {
      keys(params, [])
      await Promise.all(this.store.managers().map((manager) => this.lines.refresh(manager.id)))
      return { managers: this.store.managers().map((manager) => this.manager(manager.id)) }
    }
    if (method === MANAGER_METHOD.create) return this.create(params)
    const id = text(params.managerId, 'managerId')
    this.manager(id)
    switch (method) {
      case MANAGER_METHOD.boardRead:
        keys(params, ['managerId'])
        await this.lines.refresh(id)
        return { board: this.board(id) }
      case MANAGER_METHOD.update: {
        this.writer.active(id)
        const { managerId: _id, ...givenPatch } = params
        const patch = validatePatch(givenPatch)
        if (
          patch.dispatch?.harness &&
          !this.tree.host.harnesses().some((source) => source.id === patch.dispatch?.harness)
        )
          throw new ManagerError('invalidManager', 'The default line harness is not configured.')
        const before = this.store.manager(id) as Manager
        const after = { ...before, ...patch, updatedAt: managerNow() }
        this.store.transaction(() => {
          this.store.saveManager(after)
          this.store.record(id, 'manager', 'user', before, after, 'Manager settings updated')
          if (before.scope !== after.scope || before.rules !== after.rules)
            this.store.enqueue(
              id,
              formatSessionEvent({
                kind: 'manager-rules',
                notes: [],
                manager: { managerId: id, text: managerRulesText(after.scope, after.rules) },
              }),
            )
        })
        this.rememberRules(after)
        this.kick(id)
        if (patch.name !== undefined) {
          const link = await this.tree.link(after.harness)
          await link
            .request('thread/name/set', { threadId: after.threadId, name: after.name })
            .catch((error) =>
              this.tree.host.log(`经理名称已保存，引擎名称同步失败：${String(error)}`),
            )
        }
        this.changed(id)
        return { manager: this.manager(id) }
      }
      case MANAGER_METHOD.end: {
        keys(params, ['managerId'])
        const before = this.store.manager(id) as Manager
        if (before.status === 'active') {
          this.store.transaction(() => {
            const after: Manager = {
              ...before,
              status: 'ending',
              endedAt: null,
              updatedAt: managerNow(),
            }
            this.store.saveManager(after)
            this.store.record(
              id,
              'manager',
              'user',
              before,
              after,
              'Manager finalization requested',
            )
            const message = formatSessionEvent({
              kind: 'manager-end',
              notes: [],
              manager: { managerId: id, text: managerEndText(before.template) },
            })
            const eventId = this.store.enqueue(id, message)
            this.store.beginEnding(id, eventId, message)
          })
          this.changed(id)
          this.kick(id)
        }
        return { manager: this.manager(id) }
      }
      case MANAGER_METHOD.answersSubmit: {
        keys(params, ['managerId', 'answers'])
        const result = this.writer.answers(id, params.answers)
        if (result.accepted.length) {
          this.changed(id)
          this.kick(id)
        }
        return result
      }
      case MANAGER_METHOD.decisionReopen: {
        keys(params, ['managerId', 'decisionId'])
        const decision = this.writer.reopen(
          id,
          text(params.decisionId, 'decisionId') as ManagerObjectId,
        )
        this.changed(id)
        return { decision }
      }
      default:
        throw new ManagerError('invalidManager', `Unknown manager method: ${method}.`)
    }
  }
  private async create(given: unknown): Promise<unknown> {
    const params = validateCreate(given)
    for (const harness of [params.harness, params.dispatch.harness].filter(Boolean))
      if (!this.tree.host.harnesses().some((source) => source.id === harness))
        throw new ManagerError('invalidManager', `Harness ${harness} is not configured.`)
    const { firstTask, ...settings } = params
    const manager: Manager = {
      ...settings,
      id: randomUUID(),
      threadId: '',
      status: 'active',
      createdAt: managerNow(),
      updatedAt: managerNow(),
      endedAt: null,
      pendingDecisions: 0,
      runningLines: 0,
      latestActivity: null,
    }
    const link = await this.tree.link(params.harness)
    const tools = [...managerTools(manager), ...(link.native ? [] : [PRESENTATION_SPEC])]
    const created = await link.request('thread/start', {
      cwd: params.cwd,
      ...(params.model ? { model: params.model } : {}),
      dynamicTools: tools,
    })
    const thread = isObject(created) && isObject(created.thread) ? created.thread : null
    if (typeof thread?.id !== 'string')
      throw new Error('The harness did not return a manager thread.')
    manager.threadId = thread.id
    this.tree.store.setTools(thread.id, tools)
    this.tree.host.index.see(
      { id: thread.id, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral },
      params.harness,
    )
    this.tree.noteSubscribed(params.harness, thread.id)
    this.store.transaction(() => {
      this.store.saveManager(manager)
      this.store.record(manager.id, 'manager', 'user', null, manager, 'Manager created')
      this.store.enqueue(
        manager.id,
        firstTask.trim()
          ? firstTask
          : formatSessionEvent({
              kind: 'manager-open',
              notes: [],
              manager: { managerId: manager.id, text: managerOpenText(manager.scope) },
            }),
      )
    })
    if (manager.name)
      await link
        .request('thread/name/set', { threadId: thread.id, name: manager.name })
        .catch((error) => this.tree.host.log(`经理起名失败：${String(error)}`))
    else if (link.native) this.born(manager.harness, thread)
    this.tree.host.threadStarted(params.harness, thread)
    this.changed(manager.id)
    this.kick(manager.id)
    return { manager: this.manager(manager.id), threadId: thread.id }
  }
  private rememberRules(manager: Manager): void {
    const tools = managerTools(manager)
    this.tree.store.setTools(manager.threadId, tools)
    const record = this.tree.store.instructions(manager.threadId)
    if (record)
      this.tree.store.setInstructions(manager.threadId, {
        ...record,
        namespaces: ruledNamespaces(tools),
      })
  }
  async tool(call: DeviceToolCall): Promise<ClientToolCallResponse> {
    try {
      const manager = this.store.forThread(call.threadId)
      if (!manager || manager.harness !== call.harness)
        throw new ManagerError(
          'invalidManager',
          'litch_manager is available only in its owning manager session.',
        )
      let result: unknown
      if (call.tool === 'summary') {
        validateTool(call.tool, call.arguments)
        await this.lines.refresh(manager.id)
        const board = this.board(manager.id)
        result = {
          situation: board.situation,
          decisions: board.decisions.filter((decision) => decision.status === 'open'),
          items: board.items.filter((item) => !['done', 'deferred'].includes(item.status)),
          lines: board.lines.filter((line) => line.running),
        }
      } else {
        if (
          manager.status === 'ending' &&
          call.tool !== 'get' &&
          !(await this.endings.canWrite(manager, call.turnId))
        )
          throw new ManagerError(
            'managerEnded',
            'Only the manager-end finalization turn can write while this manager is ending.',
          )
        result = this.writer.tool(manager.id, call.tool, call.arguments, call.turnId)
        if (call.tool !== 'get') this.changed(manager.id)
      }
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
    } catch (error) {
      return clientToolFailure(
        error instanceof ManagerError ? 'invalid' : 'failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  kick(id: string): void {
    if (this.closed || this.draining.has(id)) return
    const pending = this.drain(id)
      .catch((error) => this.tree.host.log(`经理事件留待重试：${String(error)}`))
      .finally(() => {
        this.draining.delete(id)
      })
    this.draining.set(id, pending)
  }
  private async drain(id: string): Promise<void> {
    const manager = this.store.manager(id)
    if (!manager) return
    if (manager.status === 'ending') await this.endings.recover(id)
    for (const event of this.store.deliveries(id)) {
      if (this.closed) return
      const parsed = parseSessionEvent(event.text)
      // 结束回合单独开，避免结束请求把当前回合冒充成收尾回合。
      if (parsed.event?.kind === 'manager-end' && this.tree.isActive(manager.threadId)) return
      const sent = await this.tree.deliverManagerEvent(
        manager.threadId,
        event.text,
        event.id,
        manager.effort,
        parsed.event?.kind === 'manager-end'
          ? { startOnly: true, onStarted: (turnId) => this.endings.started(id, turnId) }
          : {},
      )
      if (this.closed || !sent) return
      this.store.delivered(event.id)
      if (parsed.event?.kind === 'manager-end') await this.endings.recover(id)
    }
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    this.unlisten()
    await Promise.allSettled(this.draining.values())
    this.store.close()
  }
}
