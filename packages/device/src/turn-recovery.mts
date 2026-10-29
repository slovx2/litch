import type { RecoveryNotice, SystemWake, TurnRecovery } from '../../protocol/src/turn-recovery.mjs'
import { isObject } from './wire.mjs'

interface ObservedTurn {
  harness: string
  threadId: string
  turnId: string
  startedAt: number
  progressAt: number
  revision: number
  wakeAt: number | null
  tools: Set<string>
  waiting: boolean
  notice: TurnRecovery | null
  dismissed: boolean
}
interface RecoveryHost {
  now?(): number
  check(harness: string, threadId: string): Promise<unknown>
  announce(notice: RecoveryNotice): void
  trace?(event: string, fields: Record<string, unknown>): void
}
const textItems = new Set(['agentMessage', 'reasoning', 'userMessage', 'plan'])

/** 每个回合自己的进展时钟。轮询、重试通知、连接心跳不会替模型进展续期。 */
export class TurnRecoveryObserver {
  private readonly turns = new Map<string, ObservedTurn>()
  private wake: SystemWake | null = null
  private timer: NodeJS.Timeout | null = null
  private checking = false
  private closed = false
  private readonly host: RecoveryHost
  constructor(host: RecoveryHost) {
    this.host = host
  }
  private now(): number {
    return this.host.now?.() ?? Date.now()
  }
  private key(harness: string, threadId: string): string {
    return JSON.stringify([harness, threadId])
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 5000)
    this.timer.unref()
  }
  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.turns.clear()
  }
  list(): RecoveryNotice[] {
    return [...this.turns.values()].filter((t) => t.notice).map((t) => this.envelope(t))
  }
  private envelope(t: ObservedTurn): RecoveryNotice {
    return { harness: t.harness, threadId: t.threadId, turnId: t.turnId, recovery: t.notice }
  }
  private set(t: ObservedTurn, notice: TurnRecovery | null): void {
    if (JSON.stringify(t.notice) === JSON.stringify(notice)) return
    t.notice = notice
    this.host.announce(this.envelope(t))
    this.host.trace?.('turn_recovery', {
      harness: t.harness,
      threadId: t.threadId,
      turnId: t.turnId,
      reason: notice?.reason ?? 'cleared',
    })
  }
  private drop(key: string, t: ObservedTurn): void {
    if (this.turns.get(key) !== t) return
    this.set(t, null)
    this.turns.delete(key)
  }
  eligible(harness: string, threadId: string, turnId: string): boolean {
    const t = this.turns.get(this.key(harness, threadId))
    return !!t && t.turnId === turnId && !!t.notice && !t.waiting && t.tools.size === 0
  }
  dismiss(harness: string, threadId: string, turnId: string): void {
    const t = this.turns.get(this.key(harness, threadId))
    if (!t || t.turnId !== turnId) return
    t.dismissed = true
    this.set(t, null)
  }
  resumed(wake: SystemWake | undefined): void {
    if (!wake?.supported) return
    const old = this.wake
    this.wake = wake
    if (!old || old.generation !== wake.generation || old.sequence === wake.sequence) return
    for (const t of this.turns.values()) {
      if (t.startedAt >= wake.resumedAt || t.progressAt >= wake.resumedAt) continue
      t.wakeAt = wake.resumedAt
      t.revision++
      t.dismissed = false
      this.set(t, null)
    }
  }
  private adopt(
    harness: string,
    threadId: string,
    turn: Record<string, unknown>,
  ): ObservedTurn | null {
    if (typeof turn.id !== 'string') return null
    const key = this.key(harness, threadId)
    const old = this.turns.get(key)
    if (old?.turnId === turn.id) return old
    if (old) this.drop(key, old)
    const now = this.now()
    const raw = typeof turn.startedAt === 'number' ? turn.startedAt : now
    const t: ObservedTurn = {
      harness,
      threadId,
      turnId: turn.id,
      startedAt: raw < 100_000_000_000 ? raw * 1000 : raw,
      progressAt: now,
      revision: 0,
      wakeAt: null,
      tools: new Set(),
      waiting: false,
      notice: null,
      dismissed: false,
    }
    this.turns.set(key, t)
    return t
  }
  /** 只补首次看到的活跃回合；反复读同一快照不是新进展。 */
  snapshot(harness: string, thread: unknown): void {
    if (!isObject(thread) || typeof thread.id !== 'string' || !Array.isArray(thread.turns)) return
    const turn = thread.turns.findLast((t) => isObject(t) && t.status === 'inProgress')
    if (!isObject(turn)) {
      const old = this.turns.get(this.key(harness, thread.id))
      if (old && isObject(thread.status) && thread.status.type === 'idle')
        this.drop(this.key(harness, thread.id), old)
      return
    }
    const known = this.turns.get(this.key(harness, thread.id))?.turnId === turn.id
    const t = this.adopt(harness, thread.id, turn)
    if (!t || known) return
    for (const item of Array.isArray(turn.items) ? turn.items : [])
      if (
        isObject(item) &&
        typeof item.id === 'string' &&
        !textItems.has(String(item.type)) &&
        item.status === 'inProgress'
      )
        t.tools.add(item.id)
    t.waiting = this.waiting(thread.status)
  }
  private waiting(status: unknown): boolean {
    return (
      isObject(status) &&
      Array.isArray(status.activeFlags) &&
      status.activeFlags.some(
        (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
      )
    )
  }
  observe(harness: string, method: string, params: Record<string, unknown>): void {
    if (method === 'thread/snapshot' || method === 'thread/started') {
      this.snapshot(harness, params.thread)
      return
    }
    if (typeof params.threadId !== 'string') return
    const key = this.key(harness, params.threadId)
    if (method === 'turn/started' && isObject(params.turn)) {
      this.adopt(harness, params.threadId, params.turn)
      return
    }
    const t = this.turns.get(key)
    if (!t) return
    if (typeof params.turnId === 'string' && params.turnId !== t.turnId) return
    if (method === 'turn/completed' && isObject(params.turn) && params.turn.id === t.turnId) {
      this.drop(key, t)
      return
    }
    if (method === 'thread/closed' || method === 'thread/deleted') {
      this.drop(key, t)
      return
    }
    if (method === 'thread/status/changed') {
      if (isObject(params.status) && ['idle', 'notLoaded'].includes(String(params.status.type))) {
        this.drop(key, t)
        return
      }
      const waiting = this.waiting(params.status)
      if (waiting !== t.waiting) t.revision++
      t.waiting = waiting
      if (t.waiting) this.set(t, null)
      return
    }
    if (method.endsWith('/requestApproval') || method === 'item/tool/requestUserInput') {
      t.waiting = true
      this.set(t, null)
      return
    }
    if (method === 'serverRequest/resolved') {
      t.waiting = false
      t.progressAt = this.now()
      t.revision++
      t.wakeAt = null
      return
    }
    const item = isObject(params.item) ? params.item : null
    const progress =
      method === 'item/started' ||
      method === 'item/completed' ||
      (method.startsWith('item/') && /delta$/i.test(method))
    if (!progress) return
    if (item && typeof item.id === 'string' && !textItems.has(String(item.type))) {
      if (method === 'item/started') t.tools.add(item.id)
      if (method === 'item/completed') t.tools.delete(item.id)
    }
    t.progressAt = this.now()
    t.revision++
    t.wakeAt = null
    t.dismissed = false
    this.set(t, null)
  }
  async tick(): Promise<void> {
    if (this.checking || this.closed) return
    this.checking = true
    try {
      const due = [...this.turns.values()].filter(
        (t) =>
          !t.notice &&
          !t.dismissed &&
          !t.waiting &&
          !t.tools.size &&
          this.now() - (t.wakeAt ?? t.progressAt) >= (t.wakeAt === null ? 300000 : 30000),
      )
      // 有工作才探测，最多四条并发；状态应答不能重置模型进展计时。
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(4, due.length) }, async () => {
          while (next < due.length) {
            const t = due[next++]
            if (!t) continue
            const revision = t.revision
            let reason: TurnRecovery['reason'] = t.wakeAt === null ? 'idle' : 'wake'
            try {
              const result = await this.host.check(t.harness, t.threadId)
              if (
                this.closed ||
                this.turns.get(this.key(t.harness, t.threadId)) !== t ||
                revision !== t.revision
              )
                continue
              if (isObject(result) && isObject(result.thread)) {
                const status = result.thread.status
                if (isObject(status) && ['idle', 'notLoaded'].includes(String(status.type))) {
                  this.drop(this.key(t.harness, t.threadId), t)
                  continue
                }
                if (this.waiting(status)) {
                  t.waiting = true
                  continue
                }
              }
            } catch {
              reason = 'unresponsive'
            }
            if (
              this.closed ||
              this.turns.get(this.key(t.harness, t.threadId)) !== t ||
              revision !== t.revision ||
              t.waiting ||
              t.tools.size ||
              t.dismissed
            )
              continue
            this.set(t, { reason, observedAt: this.now(), lastProgressAt: t.progressAt })
          }
        }),
      )
    } finally {
      this.checking = false
    }
  }
}
