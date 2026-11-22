import type { Manager } from '../../protocol/src/manager.mjs'
import {
  DEFAULT_MANAGER_IDLE_COMPACT,
  IDLE_COMPACT_READ,
  type IdleCompactSnapshot,
} from '../../protocol/src/manager-idle-compact.mjs'
import { type EngineLink, watchTurn } from './engine-link.mjs'
import type { DeviceManagers } from './manager.mjs'
import { isObject, UpstreamRpcError } from './wire.mjs'

const PROBE_MS = 30_000
const PREFLIGHT_MS = 10_000
const RETRY_MS = 5 * 60_000
const COMPACT_TIMEOUT_MS = 10 * 60_000

function usage(sample: IdleCompactSnapshot): number | null {
  const { usedTokens, windowTokens } = sample
  return typeof usedTokens === 'number' &&
    Number.isFinite(usedTokens) &&
    usedTokens >= 0 &&
    typeof windowTokens === 'number' &&
    Number.isFinite(windowTokens) &&
    windowTokens > 0
    ? (100 * usedTokens) / windowTokens
    : null
}

export class ManagerIdleCompact {
  private readonly owner: DeviceManagers
  private readonly now: () => number
  private readonly nextProbe = new Map<string, number>()
  private readonly nextLog = new Map<string, number>()
  private readonly activityAt = new Map<string, number>()
  private closed = false

  constructor(owner: DeviceManagers, now: () => number = Date.now) {
    this.owner = owner
    this.now = now
  }

  activity(harness: string, threadId: string, seconds: unknown): void {
    if (this.closed || harness !== 'claude-code' || !this.owner.store.forThread(threadId)) return
    const now = this.now()
    const at =
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? Math.min(now, seconds * 1000)
        : now
    this.activityAt.set(threadId, Math.max(this.activityAt.get(threadId) ?? 0, at))
  }

  private candidate(manager: Manager): boolean {
    const { external, store, tree } = this.owner
    return (
      !this.closed &&
      manager.harness === 'claude-code' &&
      manager.status === 'active' &&
      (manager.idleCompact ?? DEFAULT_MANAGER_IDLE_COMPACT).enabled &&
      (external?.store.config.assignment(manager.id).repoIds.length ?? 0) > 0 &&
      !external?.store.queue.hasPendingDelivery(manager.id) &&
      !store.hasDelivery(manager.id) &&
      tree.canIdleCompact(manager.threadId)
    )
  }

  /** 不为每秒一轮的经理投递定时器另开连接；活跃、未分配和未到期的经理不查询引擎。 */
  tick(only?: string): void {
    if (this.closed || !this.owner.external) return
    const one = only ? this.owner.store.manager(only) : null
    const managers = only ? (one ? [one] : []) : this.owner.store.managers()
    for (const manager of managers) {
      const { id, threadId } = manager
      if (only) this.nextProbe.delete(threadId)
      const now = this.now()
      if ((this.nextProbe.get(threadId) ?? 0) > now || !this.candidate(manager)) continue
      const { idleMinutes } = manager.idleCompact ?? DEFAULT_MANAGER_IDLE_COMPACT
      const localAt = Math.max(manager.createdAt * 1000, this.activityAt.get(threadId) ?? 0)
      if (now - localAt < idleMinutes * 60_000) continue
      this.nextProbe.set(threadId, now + PROBE_MS)
      this.owner.tree.runIdleCompact(threadId, (started) => this.run(id, threadId, now, started))
    }
  }

  private async run(
    id: string,
    threadId: string,
    probedAt: number,
    started: (turnId: string) => void,
  ): Promise<void> {
    const { store, tree } = this.owner
    const ready = (sample: IdleCompactSnapshot) => {
      const current = store.manager(id)
      if (!current || current.threadId !== threadId || !sample.idle || !this.candidate(current))
        return null
      const settings = current.idleCompact ?? DEFAULT_MANAGER_IDLE_COMPACT
      const state = store.idleCompact(threadId)
      const engineAt = sample.lastTurnActivityAt
      if (!sample.lastTurnId || typeof engineAt !== 'number' || !Number.isFinite(engineAt))
        return null
      const at = Math.max(engineAt, this.activityAt.get(threadId) ?? 0)
      const key = JSON.stringify([sample.lastTurnId, engineAt])
      const before = usage(sample)
      return this.now() - at >= settings.idleMinutes * 60_000 &&
        state.attempted !== key &&
        before !== null &&
        before > settings.contextPercent
        ? { state, key, before, at }
        : null
    }
    let link: EngineLink | undefined
    let committing = false
    let dispatchedAt = 0
    try {
      link = await tree.link('claude-code')
      const read = () =>
        link!.request(
          IDLE_COMPACT_READ,
          { threadId },
          { timeoutMs: PREFLIGHT_MS },
        ) as Promise<IdleCompactSnapshot>
      const snapshot = await read()
      if (!isObject(snapshot) || !ready(snapshot) || this.now() - probedAt > PREFLIGHT_MS) return
      await tree.watch('claude-code', threadId)
      // 恢复、调度或订阅的等待期间可能收到新输入，因此在启动前再查一次。
      const current = await read()
      const plan = ready(current)
      if (!plan) return
      const watch = watchTurn(link, threadId)
      try {
        const response = await link.request(
          'thread/compact/start',
          { threadId, litchIdleCompact: current },
          {
            beforeSend: () => {
              const latest = ready(current)
              if (!latest || latest.key !== plan.key || this.now() - probedAt > PREFLIGHT_MS)
                throw new Error('压缩前状态已改变或检查已过期')
              // 先记本轮尝试。连接断开、应答不明或设备重启也不会在同一轮反复压。
              store.saveIdleCompact(threadId, { ...latest.state, attempted: latest.key })
              committing = true
              dispatchedAt = this.now()
            },
          },
        )
        if (typeof response?.turnId !== 'string') throw new Error('引擎未返回压缩回合标识')
        started(response.turnId)
        tree.host.log(
          `manager.idleCompact.started ${JSON.stringify({
            managerId: id,
            threadId,
            at: dispatchedAt,
            idleMs: dispatchedAt - plan.at,
            before: plan.before,
          })}`,
        )
        const result = await watch.follow(response.turnId, { timeoutMs: COMPACT_TIMEOUT_MS })
        if (result.status !== 'completed') throw new Error(result.error ?? result.status)
        const afterUsage = await read().catch(() => null)
        if (this.closed) return
        const after =
          afterUsage && afterUsage.usageTurnId === response.turnId ? usage(afterUsage) : null
        const last = { at: this.now(), before: plan.before, after }
        store.saveIdleCompact(threadId, { ...store.idleCompact(threadId), last })
        tree.host.log(
          `manager.idleCompact.completed ${JSON.stringify({ managerId: id, threadId, ...last })}`,
        )
        this.owner.changed(id)
      } finally {
        watch.dispose()
      }
    } catch (error) {
      if (this.closed) return
      // 旧引擎不支持探测，视作用量未知。其它失败留下线索，不循环尝试。
      if (error instanceof UpstreamRpcError && error.code === -32601 && !committing) {
        this.nextProbe.set(threadId, this.now() + RETRY_MS)
      } else if (committing || (this.nextLog.get(threadId) ?? 0) <= this.now()) {
        this.nextLog.set(threadId, this.now() + RETRY_MS)
        tree.host.log(
          `manager.idleCompact.failed ${JSON.stringify({ managerId: id, threadId, error: String(error) })}`,
        )
      }
    } finally {
      if (link) tree.releaseLater('claude-code', threadId)
    }
  }

  close(): void {
    this.closed = true
    this.nextProbe.clear()
    this.nextLog.clear()
    this.activityAt.clear()
  }
}
