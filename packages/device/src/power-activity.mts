// 每条工作证据分别计时；心跳和别的会话的进展不能替失联的旧工作续期。
import { createHash, randomUUID } from 'node:crypto'
import { type PowerHarness, probePower } from './power-probe.mjs'
import { isObject } from './wire.mjs'

export type { PowerHarness } from './power-probe.mjs'
export interface PowerActivityReport {
  generation: string
  sequence: number
  complete: boolean
  sources: { id: string; working: number; observedAgoMs: number; unknown: boolean }[]
}
export interface PowerActivityHost {
  harnesses(): PowerHarness[]
  report(report: PowerActivityReport): Promise<unknown>
  background?(): { harness: string; threadId: string }[]
  tasks?(): number
  now?(): number
  version?: string
  probeMs?: number
  heartbeatMs?: number
  timeoutMs?: number
  log?(line: string): void
}
type Kind = 'turn' | 'background' | 'pending' | 'probe' | 'tasks'
interface Evidence {
  harness: string
  kind: Kind
  thread: string
  turn: string | null
  working: number
  observed: number
  unknown: boolean
  revision: number
}

export class PowerActivity {
  private readonly generation = randomUUID()
  private readonly sources = new Map<string, Evidence>()
  private readonly ended = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private readonly backgrounds = new Set<string>()
  private sequence = 0
  private revision = 0
  private pending = 0
  private running = false
  private closed = false
  private heartbeat: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private probing: Promise<void> | null = null
  private readonly recoveries = new Set<string>()
  private readonly recovered = new Set<string>()
  private sending: Promise<void> | null = null
  private dirty = false
  private lastTasks = 0
  private complete = false
  private readonly host: PowerActivityHost

  constructor(host: PowerActivityHost) {
    this.host = host
  }
  private now(): number {
    return this.host.now?.() ?? performance.now()
  }
  private key(harness: string, kind: Kind, thread: string): string {
    return createHash('sha256')
      .update(JSON.stringify([harness, kind, thread]))
      .digest('hex')
  }
  private put(
    harness: string,
    kind: Kind,
    thread: string,
    working: number,
    turn: string | null = null,
  ): void {
    this.sources.set(this.key(harness, kind, thread), {
      harness,
      kind,
      thread,
      working,
      turn,
      observed: this.now(),
      unknown: false,
      revision: ++this.revision,
    })
  }

  start(): void {
    if (this.running || this.closed) return
    this.running = true
    for (const harness of this.host.harnesses()) this.recoveries.add(harness.id)
    this.changed()
    void this.reconcile()
    this.heartbeat = setInterval(() => {
      this.refreshTasks()
      this.flush()
    }, this.host.heartbeatMs ?? 15_000)
    this.poll = setInterval(() => {
      void this.reconcile()
    }, this.host.probeMs ?? 30_000)
    this.heartbeat.unref()
    this.poll.unref()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.running = false
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.poll) clearInterval(this.poll)
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.sources.clear()
    this.ended.clear()
    this.backgrounds.clear()
    this.recoveries.clear()
    this.recovered.clear()
  }

  /** 请求发出前保护启动空窗；收到应答（无论成功失败）后释放，正式回合由事件/核对接替。 */
  begin(harness: string): () => void {
    if (this.closed) return () => {}
    const token = String(++this.pending)
    this.put(harness, 'pending', token, 1)
    this.flush()
    let released = false
    return () => {
      if (released || this.closed) return
      released = true
      this.put(harness, 'pending', token, 0)
      this.flush()
    }
  }

  notification(harness: string, method: string, params: Record<string, unknown>): void {
    if (this.closed || typeof params.threadId !== 'string') return
    const thread = params.threadId
    const turn = isObject(params.turn) ? params.turn : null
    if (
      (method === 'turn/started' || method === 'turn/completed') &&
      typeof turn?.id === 'string'
    ) {
      const key = JSON.stringify([harness, thread, turn.id])
      if (this.ended.has(key)) return
      if (method === 'turn/completed') {
        if (this.ended.size >= 4096) this.ended.clear()
        this.ended.add(key)
        const current = this.sources.get(this.key(harness, 'turn', thread))
        if (current?.turn && current.turn !== turn.id) return
        this.put(harness, 'turn', thread, 0, turn.id)
      } else {
        const current = this.sources.get(this.key(harness, 'turn', thread))
        if (current?.working && current.turn === turn.id) return
        this.put(harness, 'turn', thread, 1, turn.id)
      }
    } else if (method === 'thread/status/changed' && isObject(params.status)) {
      if (params.status.type === 'active') {
        // 状态通知没有回合号，不能抹掉 started 给出的身份，否则迟到的旧 completed 会清掉新回合。
        const current = this.sources.get(this.key(harness, 'turn', thread))
        this.put(harness, 'turn', thread, 1, current?.working ? current.turn : null)
      } else if (params.status.type === 'idle' || params.status.type === 'notLoaded') {
        this.put(harness, 'turn', thread, 0)
        if (params.status.type === 'notLoaded') this.put(harness, 'background', thread, 0)
      }
    } else if (method === 'thread/closed') {
      this.put(harness, 'turn', thread, 0)
      this.put(harness, 'background', thread, 0)
    } else if (method === 'litch/thread/background/changed' && Array.isArray(params.tasks)) {
      this.put(
        harness,
        'background',
        thread,
        params.tasks.some((task: unknown) => isObject(task) && task.status === 'running') ? 1 : 0,
      )
    } else return
    this.flush()
  }

  /** 只在集合真正改变时产生新证据；普通心跳不能把缓存中的任务当成刚核对过。 */
  changed(): void {
    if (this.closed) return
    const current = new Set<string>()
    for (const { harness, threadId } of this.host.background?.() ?? []) {
      const key = this.key(harness, 'background', threadId)
      current.add(key)
      if (!this.backgrounds.has(key)) this.put(harness, 'background', threadId, 1)
    }
    for (const key of this.backgrounds) {
      const old = this.sources.get(key)
      if (!current.has(key) && old) this.put(old.harness, 'background', old.thread, 0)
    }
    this.backgrounds.clear()
    for (const key of current) this.backgrounds.add(key)
    const tasks = this.host.tasks?.() ?? 0
    if (tasks !== this.lastTasks) {
      this.lastTasks = tasks
      this.put('$tasks', 'tasks', '', tasks)
    }
    this.flush()
  }

  snapshot(): PowerActivityReport {
    const now = this.now()
    return {
      generation: this.generation,
      sequence: ++this.sequence,
      complete: this.complete,
      sources: [...this.sources]
        .filter(([, value]) => !this.complete || value.working > 0 || value.unknown)
        .map(([id, value]) => ({
          id,
          working: value.working,
          observedAgoMs: Math.ceil(Math.max(0, now - value.observed)),
          unknown: value.unknown,
        })),
    }
  }

  private flush(): void {
    if (!this.running || this.closed) return
    this.dirty = true
    if (this.sending) return
    this.sending = (async () => {
      while (this.dirty && !this.closed) {
        this.dirty = false
        try {
          await this.host.report(this.snapshot())
        } catch (error) {
          this.host.log?.(`电源活动摘要发送失败：${String(error)}`)
        }
      }
    })().finally(() => {
      this.sending = null
    })
  }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.probing) return this.probing
    this.probing = (async () => {
      do {
        this.refreshTasks()
        const recoveries = new Set(this.recoveries)
        this.recoveries.clear()
        const harnesses = this.host.harnesses()
        const checked = await Promise.all(
          harnesses.map(async (harness) => {
            const recovering = recoveries.has(harness.id)
            // 上一轮还在途时又发生重连：旧轮成功不能覆盖新轮尚未确认的恢复状态。
            if (recovering) this.recovered.delete(harness.id)
            const okay = await this.check(harness, recovering ? 'recover' : 'known')
            if (!harness.running || (recovering && okay)) this.recovered.add(harness.id)
            return okay
          }),
        )
        this.complete =
          this.recoveries.size === 0 &&
          checked.every(Boolean) &&
          harnesses.every((harness) => this.recovered.has(harness.id))
        this.flush()
      } while (!this.closed && this.recoveries.size > 0)
    })().finally(() => {
      this.probing = null
    })
    return this.probing
  }

  /** 只由真实上游/EngineLink重连调用；探测自己的短连接不触发恢复。 */
  reconnected(harness: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.recoveries.add(harness)
    this.recovered.delete(harness)
    this.complete = false
    return this.reconcile()
  }

  /** 首轮恢复失败后，真实连接首次可达时再恢复；成功后普通短连接不重复枚举。 */
  needsRecovery(harness: string): boolean {
    return !this.recovered.has(harness)
  }

  private refreshTasks(): void {
    // 定时执行器就在这个进程里，这个数是当前执行状态，不是引擎通知缓存。
    if (this.host.tasks) {
      this.lastTasks = this.host.tasks()
      this.put('$tasks', 'tasks', '', this.lastTasks)
    }
  }

  private async check(harness: PowerHarness, mode: 'recover' | 'known'): Promise<boolean> {
    const revision = this.revision
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      const result = harness.running
        ? await probePower(harness, {
            signal: controller.signal,
            timeoutMs: this.host.timeoutMs ?? 10_000,
            version: this.host.version ?? '0',
            mode,
            knownThreads: [
              ...new Set(
                [...this.sources.values()]
                  .filter(
                    (value) =>
                      value.harness === harness.id &&
                      value.working > 0 &&
                      (value.kind === 'turn' || value.kind === 'background'),
                  )
                  .map((value) => value.thread),
              ),
            ],
          })
        : {
            active: new Set<string>(),
            background: new Map<string, boolean | null>(),
            complete: true,
            unread: new Set<string>(),
          }
      if (this.closed) return false
      const apply = (kind: Kind, thread: string, working: number) => {
        const old = this.sources.get(this.key(harness.id, kind, thread))
        if (!old && working === 0) return
        if (old && old.revision > revision) return
        if (old?.working === 0 && working === 0 && !old.unknown) return
        this.put(harness.id, kind, thread, working, old?.turn ?? null)
      }
      for (const [key, old] of this.sources) {
        if (old.harness !== harness.id || old.revision > revision || old.kind === 'pending')
          continue
        if (
          result.unread.has(old.thread) ||
          (!result.complete && !result.background.has(old.thread))
        ) {
          if (old.working) old.unknown = true
          continue
        }
        if (old.kind === 'turn' && !result.active.has(old.thread)) apply('turn', old.thread, 0)
        if (old.kind === 'background' && !result.background.has(old.thread))
          apply('background', old.thread, 0)
        if (old.kind === 'probe') this.sources.delete(key)
      }
      for (const thread of result.active) apply('turn', thread, 1)
      if (!result.complete || result.unread.size > 0) {
        const marker = this.key(harness.id, 'probe', '')
        if (!this.sources.has(marker)) this.put(harness.id, 'probe', '', 0)
        const value = this.sources.get(marker)
        if (value) value.unknown = true
      }
      for (const [thread, active] of result.background) {
        if (active !== null) apply('background', thread, active ? 1 : 0)
        else {
          const key = this.key(harness.id, 'background', thread)
          const old = this.sources.get(key)
          if (old?.working && old.revision <= revision) old.unknown = true
          else if (!old?.working) {
            // 无已知工作的未知项只需一条诊断来源，不能随历史会话数膨胀。
            const marker = this.key(harness.id, 'probe', '')
            if (!this.sources.has(marker)) this.put(harness.id, 'probe', '', 0)
            const value = this.sources.get(marker)
            if (value) value.unknown = true
          }
        }
      }
      // 已确认结束的旧来源可移除；完整报告中不出现同样表示该来源已结束。
      for (const [key, value] of this.sources)
        if (!value.working && !value.unknown && this.now() - value.observed > 90_000)
          this.sources.delete(key)
      return (
        result.complete &&
        result.unread.size === 0 &&
        ![...result.background.values()].includes(null)
      )
    } catch (error) {
      if (this.closed) return false
      for (const value of this.sources.values())
        if (value.harness === harness.id && value.working > 0 && value.revision <= revision)
          value.unknown = true
      const marker = this.key(harness.id, 'probe', '')
      if (!this.sources.has(marker)) this.put(harness.id, 'probe', '', 0)
      const value = this.sources.get(marker)
      if (value) value.unknown = true
      this.host.log?.(`核对 ${harness.id} 的电源活动失败：${String(error)}`)
      return false
    } finally {
      this.controllers.delete(controller)
    }
  }
}
