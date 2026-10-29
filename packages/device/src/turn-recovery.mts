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
  checkedAt: number
  fullFingerprint: string | null
  statusFingerprint: string | null
  recheckStep: number
}
interface RecoveryHost {
  now?(): number
  check(harness: string, threadId: string, includeTurns: boolean): Promise<unknown>
  announce(notice: RecoveryNotice): void
  trace?(event: string, fields: Record<string, unknown>): void
}
const textItems = new Set(['agentMessage', 'reasoning', 'userMessage', 'plan'])
const terminalTools = new Set(['completed', 'failed', 'declined', 'interrupted'])
const RECHECK_MS = [60000, 120000, 300000, 600000] as const
type ItemIndex = Map<string, { status: unknown; type: unknown; textLength: number }>

function itemIndex(items: unknown): ItemIndex {
  const result: ItemIndex = new Map()
  for (const item of Array.isArray(items) ? items : [])
    if (isObject(item) && typeof item.id === 'string') result.set(item.id, itemState(item))
  return result
}
function fingerprint(items: ItemIndex): string {
  const last = [...items.entries()].at(-1)
  return JSON.stringify([items.size, last?.[0], last?.[1].status, last?.[1].textLength])
}
function statusFingerprint(status: unknown): string | null {
  if (!isObject(status) || typeof status.type !== 'string') return null
  return JSON.stringify([
    status.type,
    Array.isArray(status.activeFlags) ? [...status.activeFlags].sort() : [],
  ])
}
function itemState(item: Record<string, unknown>): {
  status: unknown
  type: unknown
  textLength: number
} {
  const textSize = (value: unknown): number => (typeof value === 'string' ? value.length : 0)
  const partsSize = (value: unknown): number =>
    Array.isArray(value)
      ? value.reduce((size, part) => size + textSize(isObject(part) ? part.text : part), 0)
      : 0
  return {
    status: item.status,
    type: item.type,
    textLength: textSize(item.text) + partsSize(item.summary) + partsSize(item.content),
  }
}

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
    t.checkedAt = this.now()
    t.recheckStep = 0
    this.set(t, null)
  }
  resumed(wake: SystemWake | undefined): void {
    if (!wake?.supported) return
    const old = this.wake
    this.wake = wake
    if (!old || old.generation !== wake.generation || old.sequence === wake.sequence) return
    for (const t of this.turns.values()) {
      if (t.startedAt >= wake.resumedAt || t.progressAt >= wake.resumedAt) continue
      t.wakeAt = Math.max(this.now(), wake.resumedAt)
      t.revision++
      t.dismissed = false
      t.recheckStep = 0
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
      checkedAt: now,
      fullFingerprint: null,
      statusFingerprint: null,
      recheckStep: 0,
    }
    this.turns.set(key, t)
    return t
  }
  private progress(t: ObservedTurn): void {
    t.progressAt = this.now()
    t.revision++
    t.wakeAt = null
    t.dismissed = false
    t.recheckStep = 0
    this.set(t, null)
  }
  private setWaiting(t: ObservedTurn, waiting: boolean): void {
    if (waiting === t.waiting) return
    t.waiting = waiting
    if (!waiting) this.progress(t)
    else {
      t.revision++
      this.set(t, null)
    }
  }
  /** 同一回合也比对条目指纹；完整快照能补回客户端离线时漏掉的进展与工具终态。 */
  snapshot(harness: string, thread: unknown, complete = true): void {
    if (!isObject(thread) || typeof thread.id !== 'string') return
    const key = this.key(harness, thread.id)
    const old = this.turns.get(key)
    if (isObject(thread.status) && ['idle', 'notLoaded'].includes(String(thread.status.type))) {
      if (old) this.drop(key, old)
      return
    }
    if (!Array.isArray(thread.turns)) return
    const turn = thread.turns.at(-1)
    if (!isObject(turn) || turn.status !== 'inProgress') return
    const t = this.adopt(harness, thread.id, turn)
    if (!t) return
    t.statusFingerprint = statusFingerprint(thread.status)
    if (Array.isArray(turn.items)) {
      const items = itemIndex(turn.items)
      const nextFingerprint = fingerprint(items)
      // 通知中的在写条目可能尚未落入完整读取。只比较同源快照；首次读取只建立基线。
      const changed =
        complete && t.fullFingerprint !== null && nextFingerprint !== t.fullFingerprint
      if (complete) t.fullFingerprint = nextFingerprint
      let finishedTool = false
      // 完整读取可能还没有正在写的工具。缺席不是结束，只采纳明确的进行中/终态证据。
      for (const [id, item] of items) {
        if (textItems.has(String(item.type))) continue
        if (item.status === 'inProgress') t.tools.add(id)
        else if (terminalTools.has(String(item.status)) && t.tools.delete(id)) finishedTool = true
      }
      if (changed || finishedTool) this.progress(t)
      if (t.tools.size) this.set(t, null)
    }
    this.setWaiting(t, this.waiting(thread.status))
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
      this.snapshot(harness, params.thread, method === 'thread/snapshot')
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
      t.statusFingerprint = statusFingerprint(params.status)
      this.setWaiting(t, this.waiting(params.status))
      return
    }
    if (method.endsWith('/requestApproval') || method === 'item/tool/requestUserInput') {
      this.setWaiting(t, true)
      return
    }
    if (method === 'serverRequest/resolved') {
      t.waiting = false
      this.progress(t)
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
    this.progress(t)
  }
  async tick(): Promise<void> {
    if (this.checking || this.closed) return
    this.checking = true
    try {
      const due = [...this.turns.values()].filter((t) =>
        t.notice || t.dismissed || t.waiting || t.tools.size
          ? this.now() - Math.max(t.checkedAt, t.progressAt) >=
            (RECHECK_MS[t.recheckStep] ?? 600000)
          : this.now() - (t.wakeAt ?? t.progressAt) >= (t.wakeAt === null ? 300000 : 30000),
      )
      // 有工作才探测，最多四条并发；状态应答不能重置模型进展计时。
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(4, due.length) }, async () => {
          while (next < due.length) {
            const t = due[next++]
            if (!t) continue
            const recheck = !!(t.notice || t.dismissed || t.waiting || t.tools.size)
            t.checkedAt = this.now()
            const revision = t.revision
            const current = () =>
              !this.closed &&
              this.turns.get(this.key(t.harness, t.threadId)) === t &&
              revision === t.revision
            let reason: TurnRecovery['reason'] = t.wakeAt === null ? 'idle' : 'wake'
            try {
              const result = await this.host.check(t.harness, t.threadId, false)
              if (!current()) continue
              let statusChanged = false
              if (isObject(result) && isObject(result.thread)) {
                const status = result.thread.status
                if (isObject(status) && ['idle', 'notLoaded'].includes(String(status.type))) {
                  this.drop(this.key(t.harness, t.threadId), t)
                  continue
                }
                const nextStatus = statusFingerprint(status)
                statusChanged =
                  (t.statusFingerprint !== null &&
                    nextStatus !== null &&
                    t.statusFingerprint !== nextStatus) ||
                  this.waiting(status) !== t.waiting
                if (nextStatus !== null) t.statusFingerprint = nextStatus
              }
              // 工具结束通知也可能漏收：只有仍登记着工具且已退避到十分钟时做低频完整核对。
              const reconcileTools = t.tools.size > 0 && t.recheckStep === RECHECK_MS.length - 1
              if (recheck && !statusChanged && !reconcileTools) {
                t.recheckStep = Math.min(t.recheckStep + 1, RECHECK_MS.length - 1)
                continue
              }
              // 完整读取限于即将提醒、状态改变、或工具终态的十分钟兜底核对。
              const full = await this.host.check(t.harness, t.threadId, true)
              if (!current()) continue
              if (isObject(full) && isObject(full.thread))
                this.snapshot(t.harness, { ...full.thread, id: t.threadId })
              // 快照发现了漏掉的进展、解除等待或换回合，本次不提醒。
              if (!current()) continue
            } catch {
              reason = 'unresponsive'
            }
            if (recheck) t.recheckStep = Math.min(t.recheckStep + 1, RECHECK_MS.length - 1)
            if (
              this.closed ||
              this.turns.get(this.key(t.harness, t.threadId)) !== t ||
              revision !== t.revision ||
              t.waiting ||
              t.tools.size ||
              t.dismissed
            )
              continue
            if (t.notice) continue
            this.set(t, { reason, observedAt: this.now(), lastProgressAt: t.progressAt })
          }
        }),
      )
    } finally {
      this.checking = false
    }
  }
}
