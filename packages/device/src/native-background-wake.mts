// 只观察明确登记的原生终端；不运行 shell、不接管 Codex 的审批或沙箱。
import { randomUUID } from 'node:crypto'
import type { LitchBackground } from '../../protocol/src/background-tasks.mjs'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import {
  NATIVE_BACKGROUND_OPTION,
  NATIVE_BACKGROUND_TOOLS,
  NATIVE_BACKGROUND_NAMESPACE as NS,
} from '../../protocol/src/native-background-wake.mjs'
import type { DeviceToolCall } from './device-tools.mjs'
import type { EngineLink } from './engine-link.mjs'
import type { NativeBackgroundStore, NativeBackgroundTask } from './native-background-store.mjs'
import type { SessionStore } from './session-store.mjs'
import { isObject } from './wire.mjs'

interface Command {
  itemId: string
  turnId: string
  processId: string
  command: string
  startedAt: number
  output: string
  truncated: boolean
  endedAt?: number
  exitCode: number | null
  stopped: boolean
}
export interface NativeBackgroundHost {
  store: NativeBackgroundStore
  sessions: Pick<SessionStore, 'option' | 'setOption' | 'tools' | 'setTools'>
  link(harness: string): Promise<EngineLink>
  watch(harness: string, threadId: string): Promise<unknown>
  canContinue(threadId: string): boolean
  changed(threadId: string): void
  log(message: string): void
  settleMs?: number
  startIntervalMs?: number
}

export function outputTail(text: string, max = 64_000): string {
  return Buffer.from(text).subarray(-max).toString('utf8').replace(/^�+/, '')
}

export class NativeBackgroundWake {
  private readonly commands = new Map<string, Map<string, Command>>()
  private readonly live = new Map<string, NativeBackgroundTask>()
  private readonly active = new Map<string, string>()
  private readonly stopped = new Set<string>()
  private readonly terminalStops = new Map<string, Set<string>>()
  private readonly epochs = new Map<string, number>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly sending = new Map<string, string>()
  private readonly checking = new Set<string>()
  private readonly completedTurns = new Set<string>()
  private readonly lastStarted = new Map<string, number>()
  private closed = false
  private readonly host: NativeBackgroundHost
  constructor(host: NativeBackgroundHost) {
    this.host = host
    host.store.recover()
  }

  enabled(harness: string): boolean {
    return this.host.sessions.option(harness, NATIVE_BACKGROUND_OPTION) !== false
  }
  setEnabled(harness: string, value: boolean | null): void {
    this.host.sessions.setOption(harness, NATIVE_BACKGROUND_OPTION, value)
    if (!this.enabled(harness))
      for (const task of this.live.values()) if (task.harness === harness) this.cancel(task)
  }

  prepare(
    harness: string,
    method: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    if (method !== 'thread/start' || params.ephemeral === true || !this.enabled(harness))
      return params
    const tools = Array.isArray(params.dynamicTools) ? params.dynamicTools : []
    return {
      ...params,
      dynamicTools: [
        ...tools.filter((t) => !isObject(t) || t.name !== NS),
        NATIVE_BACKGROUND_TOOLS,
      ],
    }
  }
  born(method: string, params: Record<string, unknown>, result: unknown): void {
    if (method === 'thread/delete' && typeof params.threadId === 'string') {
      this.forget(params.threadId)
      return
    }
    if (
      !['thread/start', 'thread/fork'].includes(method) ||
      !isObject(result) ||
      !isObject(result.thread) ||
      typeof result.thread.id !== 'string'
    )
      return
    const tools =
      method === 'thread/start'
        ? params.dynamicTools
        : this.host.sessions.tools(String(params.threadId))
    if (Array.isArray(tools)) this.host.sessions.setTools(result.thread.id, tools)
  }
  installed(threadId: string): boolean {
    return this.host.sessions.tools(threadId)?.some((t) => isObject(t) && t.name === NS) === true
  }

  // 每个原生线程所有经设备提交的 turn/start 共用短锁，覆盖发送到应答的窗口。
  async acquire(threadId: string): Promise<() => void> {
    const before = this.queues.get(threadId) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((done) => {
      release = done
    })
    const queued = before.then(() => held)
    this.queues.set(threadId, queued)
    await before
    let done = false
    return () => {
      if (done) return
      done = true
      release()
      if (this.queues.get(threadId) === queued) this.queues.delete(threadId)
      this.schedule(threadId)
    }
  }

  input(method: string, params: Record<string, unknown>, user: boolean): void {
    const id = typeof params.threadId === 'string' ? params.threadId : null
    if (!id) return
    if (['turn/interrupt', 'thread/archive', 'thread/delete'].includes(method)) this.block(id)
    else if (
      method === 'thread/backgroundTerminals/clean' ||
      method === 'thread/backgroundTerminals/terminate'
    ) {
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
      const stopped = this.terminalStops.get(id) ?? new Set<string>()
      stopped.add(method.endsWith('/clean') ? '*' : String(params.processId))
      this.terminalStops.set(id, stopped)
      for (const task of this.live.values())
        if (
          task.threadId === id &&
          (method.endsWith('/clean') || task.processId === String(params.processId))
        )
          this.cancel(task)
    } else if (user && (method === 'turn/start' || method === 'turn/steer')) {
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
      // 明确发送才解除停止；待发消息未到此处，不会自动清掉停止标记。
      this.stopped.delete(id)
      this.terminalStops.delete(id)
      for (const task of this.live.values())
        if (task.threadId === id && task.state === 'paused') {
          task.state = task.endedAt === undefined ? 'watching' : 'pending'
          this.save(task)
        }
    }
  }
  block(threadId: string): void {
    this.stopped.add(threadId)
    this.epochs.set(threadId, (this.epochs.get(threadId) ?? 0) + 1)
    for (const task of this.live.values())
      if (task.threadId === threadId && ['watching', 'pending'].includes(task.state)) {
        task.state = 'paused'
        this.save(task)
      }
  }
  accepted(threadId: string, result: unknown, user = false): void {
    if (!isObject(result)) return
    const turn = isObject(result.turn) ? result.turn : null
    const id =
      typeof turn?.id === 'string'
        ? turn.id
        : typeof result.turnId === 'string'
          ? result.turnId
          : null
    if (!id) return
    if (turn?.status === 'inProgress' && !this.completedTurns.has(id)) this.active.set(threadId, id)
    if (user) this.host.store.userTurn(threadId, id)
  }

  observe(_harness: string, method: string, params: Record<string, unknown>): void {
    const id = typeof params.threadId === 'string' ? params.threadId : null
    if (!id) return
    const turn = isObject(params.turn) ? params.turn : null
    if (method === 'turn/started' && typeof turn?.id === 'string') {
      if (!this.completedTurns.has(turn.id)) {
        if (
          this.active.get(id) !== turn.id &&
          !this.queues.has(id) &&
          !this.sending.has(id) &&
          this.working(id)
        )
          this.block(id)
        this.active.set(id, turn.id)
      }
    }
    if (method === 'turn/completed' && typeof turn?.id === 'string') {
      this.completedTurns.add(turn.id)
      if (this.completedTurns.size > 2048)
        this.completedTurns.delete(this.completedTurns.values().next().value as string)
      if (this.active.get(id) === turn.id) this.active.delete(id)
      if (turn.status === 'interrupted' || turn.status === 'failed') this.block(id)
      this.schedule(id)
    }
    if (
      method === 'thread/closed' ||
      (method === 'thread/status/changed' &&
        isObject(params.status) &&
        params.status.type === 'notLoaded')
    )
      this.lost(id)
    if (method === 'thread/deleted') this.forget(id)
    if (!this.installed(id)) return
    const item = isObject(params.item) ? params.item : null
    if (
      item?.type === 'functionCallOutput' &&
      item.namespace === NS &&
      item.name === 'completed' &&
      typeof params.turnId === 'string'
    ) {
      const batch = this.sending.get(id)
      if (batch && typeof item.output === 'string' && item.output.includes(batch))
        this.host.store.rememberTurn(id, params.turnId, batch)
    }
    if (
      item?.type === 'commandExecution' &&
      typeof item.id === 'string' &&
      typeof params.turnId === 'string'
    ) {
      const commands = this.commands.get(id) ?? new Map<string, Command>()
      const command = commands.get(item.id) ?? {
        itemId: item.id,
        turnId: params.turnId,
        processId: '',
        command: '',
        startedAt: Date.now(),
        output: '',
        truncated: false,
        exitCode: null,
        stopped: false,
      }
      command.processId = typeof item.processId === 'string' ? item.processId : command.processId
      command.command = typeof item.command === 'string' ? item.command : command.command
      if (method === 'item/completed' && command.endedAt === undefined) {
        command.endedAt = Date.now()
        command.exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
        command.stopped = item.status === 'declined' || command.exitCode === null
        if (typeof item.aggregatedOutput === 'string') {
          command.output = outputTail(item.aggregatedOutput)
          command.truncated ||= Buffer.byteLength(item.aggregatedOutput) > 64_000
        }
      }
      commands.set(item.id, command)
      this.commands.set(id, commands)
      // 只保留近期已结束命令，运行中的不淘汰。
      if (commands.size > 256)
        for (const [key, value] of commands)
          if (
            value.endedAt !== undefined &&
            ![...this.live.values()].some((t) => t.threadId === id && t.itemId === key)
          ) {
            commands.delete(key)
            if (commands.size <= 256) break
          }
      for (const task of this.live.values())
        if (
          task.threadId === id &&
          task.itemId === item.id &&
          task.endedAt === undefined &&
          command.endedAt !== undefined
        ) {
          Object.assign(task, {
            output: command.output,
            truncated: command.truncated,
            exitCode: command.exitCode,
            endedAt: command.endedAt,
          })
          if (command.stopped) task.state = 'cancelled'
          else if (task.state === 'watching')
            task.state = this.stopped.has(id) ? 'paused' : 'pending'
          this.save(task)
          this.schedule(id)
        }
    }
    if (
      method === 'item/commandExecution/outputDelta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string'
    ) {
      const command = this.commands.get(id)?.get(params.itemId)
      if (command) {
        const output = command.output + params.delta
        command.truncated ||= Buffer.byteLength(output) > 64_000
        command.output = outputTail(output)
      }
    }
  }

  async tool(call: DeviceToolCall): Promise<ClientToolCallResponse> {
    try {
      if (!this.installed(call.threadId))
        throw new Error(
          'Background continuation is not installed in this session. Create a new Litch Codex session.',
        )
      const args = isObject(call.arguments) ? call.arguments : {}
      let result: unknown
      if (call.tool === 'watch') result = await this.watch(call, args)
      else {
        const task = this.host.store.list(call.threadId).find((t) => t.id === args.task_id)
        if (!task || task.harness !== call.harness)
          throw new Error('No such background task in this session.')
        if (call.tool === 'cancel') {
          this.cancel(task)
          result = { task_id: task.id, state: task.state }
        } else if (call.tool === 'read') {
          const live = this.live.get(task.id)
          if (live?.endedAt !== undefined && ['pending', 'paused'].includes(live.state)) {
            live.state = 'delivered'
            this.save(live)
            task.state = live.state
          }
          const command = this.commands.get(call.threadId)?.get(task.itemId)
          const original = command?.output ?? task.output
          const output = outputTail(
            original,
            typeof args.max_bytes === 'number' && Number.isFinite(args.max_bytes)
              ? Math.max(1, Math.min(64_000, Math.floor(args.max_bytes)))
              : 8000,
          )
          result = {
            ...task,
            output,
            truncated: task.truncated || command?.truncated === true || output !== original,
            // 原生完成事件自身也可能已截断，设备不能保证保存了完整日志。
            outputMayBeTruncated: true,
          }
        } else throw new Error('Unknown background continuation tool.')
      }
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
    } catch (error) {
      return clientToolFailure('failed', error instanceof Error ? error.message : String(error))
    }
  }

  private async watch(call: DeviceToolCall, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed || !this.enabled(call.harness))
      throw new Error('Background continuation is disabled in this device’s Codex settings.')
    if (typeof args.purpose !== 'string' || !args.purpose.trim() || args.purpose.length > 1000)
      throw new Error('purpose must describe the remaining work in 1–1000 characters.')
    if (!['string', 'number'].includes(typeof args.session_id))
      throw new Error('Provide the session_id returned by native exec_command.')
    const epoch = this.epochs.get(call.threadId) ?? 0
    await this.host.watch(call.harness, call.threadId)
    const link = await this.host.link(call.harness)
    if (!link.native) throw new Error('Only native Codex terminals can be registered.')
    const listed = await link.request('thread/backgroundTerminals/list', {
      threadId: call.threadId,
    })
    if (
      this.closed ||
      !this.enabled(call.harness) ||
      this.stopped.has(call.threadId) ||
      epoch !== (this.epochs.get(call.threadId) ?? 0)
    )
      throw new Error('Continuation was stopped while registration was pending.')
    const processId = String(args.session_id)
    if (
      this.terminalStops.get(call.threadId)?.has('*') ||
      this.terminalStops.get(call.threadId)?.has(processId)
    )
      throw new Error('This terminal was stopped; no continuation was registered.')
    const row = Array.isArray(listed?.data)
      ? listed.data.find((r: unknown) => isObject(r) && String(r.processId) === processId)
      : null
    // 列表只用于确认归属，原回合/条目必须来自这次运行里观察到的命令。
    const observed = [...(this.commands.get(call.threadId)?.values() ?? [])]
    const command =
      isObject(row) && typeof row.itemId === 'string'
        ? observed.find((c) => c.itemId === row.itemId)
        : observed.findLast((c) => c.processId === processId)
    if (!command || (!row && command.endedAt === undefined))
      throw new Error(
        'Cannot verify this native terminal. Keep waiting with the native shell tools; no continuation was registered.',
      )
    const existing = [...this.live.values()].find(
      (t) =>
        t.threadId === call.threadId && t.itemId === command.itemId && t.turnId === command.turnId,
    )
    if (existing)
      return {
        task_id: existing.id,
        state: existing.state,
        output: existing.endedAt === undefined ? undefined : existing.output,
      }
    const task: NativeBackgroundTask = {
      ...command,
      id: randomUUID(),
      harness: call.harness,
      threadId: call.threadId,
      processId,
      title:
        typeof args.title === 'string' && args.title.trim()
          ? args.title.trim().slice(0, 120)
          : command.command.slice(0, 120),
      purpose: args.purpose.trim(),
      state: command.endedAt === undefined ? 'watching' : 'delivered',
    }
    this.live.set(task.id, task)
    this.save(task)
    return {
      task_id: task.id,
      state: task.endedAt === undefined ? 'registered' : 'completed',
      ...(task.endedAt !== undefined
        ? { exit_code: task.exitCode, output: task.output, truncated: task.truncated }
        : {}),
    }
  }

  private save(task: NativeBackgroundTask): void {
    this.host.store.save(task)
    for (const id of this.host.store.prune(task.threadId)) this.live.delete(id)
    this.host.changed(task.threadId)
  }
  private cancel(task: NativeBackgroundTask): void {
    if (['delivered', 'cancelled', 'lost'].includes(task.state)) return
    task.state = 'cancelled'
    this.live.set(task.id, task)
    this.save(task)
  }
  private lost(threadId: string): void {
    this.block(threadId)
    this.commands.delete(threadId)
    this.active.delete(threadId)
    this.terminalStops.delete(threadId)
    for (const task of this.live.values())
      if (
        task.threadId === threadId &&
        ['watching', 'pending', 'paused', 'unknown'].includes(task.state)
      ) {
        task.state = task.endedAt === undefined ? 'lost' : 'cancelled'
        this.save(task)
      }
  }
  private forget(threadId: string): void {
    this.lost(threadId)
    this.host.store.forget(threadId)
    for (const [id, task] of this.live) if (task.threadId === threadId) this.live.delete(id)
    clearTimeout(this.timers.get(threadId))
    this.timers.delete(threadId)
    this.lastStarted.delete(threadId)
  }
  disconnected(harness: string): void {
    for (const task of this.live.values()) if (task.harness === harness) this.lost(task.threadId)
  }
  pending(threadId: string): boolean {
    const active = this.active.get(threadId)
    return (
      [...this.live.values()].some((t) => t.threadId === threadId && t.state === 'pending') ||
      this.sending.has(threadId) ||
      (!!active && this.host.store.isWake(threadId, active))
    )
  }
  working(threadId: string): number | undefined {
    if (!this.installed(threadId)) return undefined
    return (
      [...this.live.values()].filter((t) => t.threadId === threadId && t.state === 'watching')
        .length + Number(this.pending(threadId))
    )
  }
  decorateBackground(threadId: string, base: LitchBackground | null): LitchBackground | null {
    if (!this.installed(threadId)) return base
    const saved = this.host.store.list(threadId)
    const tasks = (base?.tasks ?? []).map((t) => ({ ...t }))
    for (const task of saved) {
      let entry = tasks.find((t) => t.itemId === task.itemId && t.turnId === task.turnId)
      if (!entry) {
        entry = {
          id: task.itemId,
          itemId: task.itemId,
          turnId: task.turnId,
          kind: 'shell',
          title: task.title,
          startedAt: task.startedAt,
          ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
          status:
            task.endedAt === undefined && task.state !== 'lost'
              ? 'running'
              : task.exitCode === 0
                ? 'completed'
                : task.exitCode === null
                  ? 'stopped'
                  : 'failed',
        }
        tasks.push(entry)
      }
      entry.litchWake = task.state
    }
    return tasks.length ? { tasks, wakesOnFinish: false } : base
  }
  decorate(threadId: string, value: Record<string, unknown>): boolean {
    let changed = false
    if (isObject(value.thread)) changed = this.decorate(String(value.thread.id), value.thread)
    const turns = Array.isArray(value.turns)
      ? value.turns
      : Array.isArray(value.data)
        ? value.data
        : isObject(value.turn)
          ? [value.turn]
          : typeof value.id === 'string'
            ? [value]
            : []
    for (const turn of turns)
      if (
        isObject(turn) &&
        typeof turn.id === 'string' &&
        this.host.store.isWake(threadId, turn.id)
      ) {
        turn.litchOrigin = 'backgroundTask'
        changed = true
      }
    return changed
  }
  schedule(threadId: string): void {
    if (
      this.closed ||
      this.timers.has(threadId) ||
      this.checking.has(threadId) ||
      !this.pending(threadId)
    )
      return
    const timer = setTimeout(
      () => {
        this.timers.delete(threadId)
        this.checking.add(threadId)
        void this.drain(threadId).then(
          (sent) => {
            this.checking.delete(threadId)
            if (sent && !this.active.has(threadId)) this.schedule(threadId)
          },
          (error) => {
            this.checking.delete(threadId)
            this.host.log(`后台结果未续跑：${String(error)}`)
          },
        )
      },
      Math.max(
        this.host.settleMs ?? 300,
        (this.lastStarted.get(threadId) ?? 0) + (this.host.startIntervalMs ?? 2000) - Date.now(),
      ),
    )
    timer.unref()
    this.timers.set(threadId, timer)
  }
  private async drain(threadId: string): Promise<boolean> {
    if (
      this.closed ||
      this.stopped.has(threadId) ||
      this.active.has(threadId) ||
      !this.host.canContinue(threadId)
    )
      return false
    const tasks = [...this.live.values()]
      .filter((t) => t.threadId === threadId && t.state === 'pending')
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .slice(0, 4)
    const first = tasks[0]
    if (!first || !this.enabled(first.harness)) return false
    const epoch = this.epochs.get(threadId) ?? 0
    const link = await this.host.link(first.harness)
    // request 包装统一取得短锁；拿到锁后再检查状态，而不是持锁再调用同一入口造成死锁。
    const batchId = randomUUID()
    const payload = {
      batchId,
      events: tasks.map((t) => ({
        taskId: t.id,
        originalTurnId: t.turnId,
        itemId: t.itemId,
        title: t.title,
        purpose: t.purpose,
        purposeTruncated: false,
        status: t.exitCode === 0 ? 'completed' : 'failed',
        exitCode: t.exitCode,
        signal: 'unknown',
        durationMs: (t.endedAt ?? t.startedAt) - t.startedAt,
        output: outputTail(t.output, Math.min(2000, Math.floor(12000 / tasks.length))),
        outputMayBeTruncated: true,
        truncated:
          t.truncated ||
          Buffer.byteLength(t.output) > Math.min(2000, Math.floor(12000 / tasks.length)),
      })),
    }
    // 限制序列化后的 UTF-8 字节；控制字符的 JSON 转义最多膨胀六倍。
    while (Buffer.byteLength(JSON.stringify(payload)) > 16_384) {
      const largest = payload.events
        .flatMap((event) => (['output', 'purpose'] as const).map((key) => ({ event, key })))
        .sort(
          (a, b) =>
            Buffer.byteLength(JSON.stringify(b.event[b.key])) -
            Buffer.byteLength(JSON.stringify(a.event[a.key])),
        )[0]
      if (!largest?.event[largest.key])
        throw new Error('Background completion identifiers exceed the delivery size limit.')
      const points = Array.from(largest.event[largest.key])
      const keep = Math.floor(points.length / 2)
      largest.event[largest.key] =
        largest.key === 'output'
          ? points.slice(points.length - keep).join('')
          : points.slice(0, keep).join('')
      if (largest.key === 'output') largest.event.truncated = true
      else largest.event.purposeTruncated = true
    }
    this.sending.set(threadId, batchId)
    try {
      await link.request('turn/start', {
        threadId,
        input: [],
        turnTrigger: 'litch.backgroundTask',
        toolOutput: {
          namespace: NS,
          name: 'completed',
          output: JSON.stringify(payload),
          retain: true,
        },
        __litchWakeEpoch: epoch,
      })
      return true
    } catch (error) {
      if (!(error instanceof WakeNotReady)) {
        for (const task of tasks) if (task.state === 'unknown') this.save(task)
        this.host.log(`后台结果 ${batchId} 投递未确认，不自动重试：${String(error)}`)
      }
      return false
    } finally {
      this.sending.delete(threadId)
      this.host.changed(threadId)
    }
  }

  async request(
    method: string,
    params: unknown,
    send: (params: unknown) => Promise<any>,
  ): Promise<any> {
    if (!isObject(params)) return send(params)
    this.input(method, params, false)
    if (method !== 'turn/start' || typeof params.threadId !== 'string') return send(params)
    const id = params.threadId
    const release = await this.acquire(id)
    const { __litchWakeEpoch: epoch, ...plain } = params
    const batchId = typeof epoch === 'number' ? this.sending.get(id) : undefined
    try {
      if (batchId) {
        const link = await this.host.link(this.liveTask(id)?.harness ?? 'codex')
        const read = await link.request('thread/read', { threadId: id, includeTurns: false })
        if (
          this.closed ||
          this.stopped.has(id) ||
          this.active.has(id) ||
          epoch !== (this.epochs.get(id) ?? 0) ||
          !this.host.canContinue(id) ||
          read?.thread?.status?.type !== 'idle'
        )
          throw new WakeNotReady()
        const output =
          isObject(plain.toolOutput) && typeof plain.toolOutput.output === 'string'
            ? JSON.parse(plain.toolOutput.output)
            : null
        // 等锁/查 idle 时模型可能已经读过结果，或用户取消/关闭；只发仍未消费的事件。
        const events = (output?.events ?? []).filter(
          (e: { taskId: string }) => this.live.get(e.taskId)?.state === 'pending',
        )
        if (!events.length || !this.enabled(this.liveTask(id)?.harness ?? 'codex'))
          throw new WakeNotReady()
        plain.toolOutput = {
          ...(plain.toolOutput as Record<string, unknown>),
          output: JSON.stringify({ ...output, events }),
        }
        const ids = new Set(events.map((e: { taskId: string }) => e.taskId))
        for (const task of this.live.values())
          if (task.threadId === id && task.state === 'pending' && ids.has(task.id)) {
            task.state = 'unknown'
            task.batchId = batchId
            this.save(task)
          }
        this.lastStarted.set(id, Date.now())
      }
      const result = await send(plain)
      this.accepted(id, result)
      if (batchId && typeof result?.turn?.id === 'string') {
        this.host.store.rememberTurn(id, result.turn.id, batchId)
        for (const task of this.live.values())
          if (task.threadId === id && task.batchId === batchId) {
            task.state = 'delivered'
            this.save(task)
          }
        this.decorate(id, result)
      }
      return result
    } finally {
      release()
    }
  }
  private liveTask(threadId: string): NativeBackgroundTask | undefined {
    return [...this.live.values()].find((t) => t.threadId === threadId)
  }
  close(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
class WakeNotReady extends Error {}
