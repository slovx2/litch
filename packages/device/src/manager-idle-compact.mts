import type { Manager } from '../../protocol/src/manager.mjs'
import {
  DEFAULT_MANAGER_IDLE_COMPACT,
  IDLE_COMPACT_READ,
  type IdleCompactSnapshot,
} from '../../protocol/src/manager-idle-compact.mjs'
import { type EngineLink, watchTurn } from './engine-link.mjs'
import type { DeviceManagers } from './manager.mjs'
import type { LineageRow } from './session-store.mjs'
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

/**
 * 有带条件压缩入口（litch/thread/idleCompact/read、thread/compact/start 带快照）的引擎。
 * Codex 的压缩不能按快照核对、也不交回回合号；OpenCode、DSH、ACP 没有这套入口。
 */
const IDLE_COMPACT_HARNESSES = new Set(['claude-code', 'pi'])

/** 同时进行的子会话压缩上限：每个都要载入一个会话并请模型写摘要，经理本身不受此限。 */
const LINE_RUNNING_LIMIT = 2

interface Target {
  threadId: string
  harness: string
  /** 本机没见过活动时的计时起点，Unix 毫秒。 */
  since: number
  line: boolean
}

/**
 * Claude Code 经理及其各层 Claude Code、Pi 子会话的空闲压缩。子会话沿用所属经理的开关和阈值，
 * 所属关系按会话树的祖先判断（ManagerLines.managerFor）。
 */
export class ManagerIdleCompact {
  private readonly owner: DeviceManagers
  private readonly now: () => number
  private readonly nextProbe = new Map<string, number>()
  private readonly nextLog = new Map<string, number>()
  private readonly activityAt = new Map<string, number>()
  /** 已对本段空闲试过的子会话：本机见到新的回合活动前不再探测引擎，免得每条闲置工作线反复读。 */
  private readonly settled = new Set<string>()
  private readonly running = new Set<string>()
  private closed = false

  constructor(owner: DeviceManagers, now: () => number = Date.now) {
    this.owner = owner
    this.now = now
  }

  activity(harness: string, threadId: string, seconds: unknown): void {
    if (
      this.closed ||
      !IDLE_COMPACT_HARNESSES.has(harness) ||
      !this.owner.lines.managerFor(threadId)
    )
      return
    const now = this.now()
    const at =
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? Math.min(now, seconds * 1000)
        : now
    this.activityAt.set(threadId, Math.max(this.activityAt.get(threadId) ?? 0, at))
    this.settled.delete(threadId)
  }

  /** 经理一级的条件：经理本身和它的子会话共用。 */
  private enabledFor(manager: Manager): boolean {
    return (
      !this.closed &&
      manager.harness === 'claude-code' &&
      manager.status === 'active' &&
      (manager.idleCompact ?? DEFAULT_MANAGER_IDLE_COMPACT).enabled &&
      (this.owner.external?.store.config.assignment(manager.id).repoIds.length ?? 0) > 0
    )
  }

  private candidate(manager: Manager, threadId: string): boolean {
    const { external, store, tree, lines } = this.owner
    if (!this.enabledFor(manager) || !tree.canIdleCompact(threadId)) return false
    if (threadId === manager.threadId)
      return !external?.store.queue.hasPendingDelivery(manager.id) && !store.hasDelivery(manager.id)
    return (
      IDLE_COMPACT_HARNESSES.has(tree.store.parentOf(threadId)?.harness ?? '') &&
      lines.managerFor(threadId)?.id === manager.id
    )
  }

  /** 经理本身在前，其后是各层没脱离、引擎支持的子会话（广度优先）。 */
  private targets(manager: Manager, byParent: Map<string, LineageRow[]>): Target[] {
    const found: Target[] = [
      {
        threadId: manager.threadId,
        harness: manager.harness,
        since: manager.createdAt * 1000,
        line: false,
      },
    ]
    const queue = [manager.threadId]
    const seen = new Set(queue)
    while (queue.length) {
      for (const row of byParent.get(queue.shift() as string) ?? []) {
        if (seen.has(row.threadId)) continue
        seen.add(row.threadId)
        queue.push(row.threadId)
        if (IDLE_COMPACT_HARNESSES.has(row.harness))
          found.push({
            threadId: row.threadId,
            harness: row.harness,
            since: row.createdAt * 1000,
            line: true,
          })
      }
    }
    return found
  }

  /** 不为每秒一轮的经理投递定时器另开连接；活跃、未分配和未到期的会话不查询引擎。 */
  tick(only?: string): void {
    if (this.closed || !this.owner.external) return
    const one = only ? this.owner.store.manager(only) : null
    const managers = (only ? (one ? [one] : []) : this.owner.store.managers()).filter((manager) =>
      this.enabledFor(manager),
    )
    if (!managers.length) return
    const byParent = new Map<string, LineageRow[]>()
    for (const row of this.owner.tree.store.children()) {
      const list = byParent.get(row.parentThreadId)
      if (list) list.push(row)
      else byParent.set(row.parentThreadId, [row])
    }
    for (const manager of managers) {
      const { idleMinutes } = manager.idleCompact ?? DEFAULT_MANAGER_IDLE_COMPACT
      for (const { threadId, harness, since, line } of this.targets(manager, byParent)) {
        if (only) {
          this.nextProbe.delete(threadId)
          this.settled.delete(threadId)
        }
        const now = this.now()
        if ((this.nextProbe.get(threadId) ?? 0) > now || this.settled.has(threadId)) continue
        const localAt = Math.max(since, this.activityAt.get(threadId) ?? 0)
        if (now - localAt < idleMinutes * 60_000 || !this.candidate(manager, threadId)) continue
        if (line && this.running.size >= LINE_RUNNING_LIMIT) continue
        this.nextProbe.set(threadId, now + PROBE_MS)
        const began = this.owner.tree.runIdleCompact(threadId, (started) =>
          this.run(manager.id, threadId, harness, line, now, started).finally(() =>
            this.running.delete(threadId),
          ),
        )
        if (began && line) this.running.add(threadId)
      }
    }
  }

  private async run(
    id: string,
    threadId: string,
    harness: string,
    line: boolean,
    probedAt: number,
    started: (turnId: string) => void,
  ): Promise<void> {
    const { store, tree } = this.owner
    const ready = (sample: IdleCompactSnapshot) => {
      const current = store.manager(id)
      if (!current || !sample.idle || !this.candidate(current, threadId)) return null
      const settings = current.idleCompact ?? DEFAULT_MANAGER_IDLE_COMPACT
      const state = store.idleCompact(threadId)
      const engineAt = sample.lastTurnActivityAt
      if (!sample.lastTurnId || typeof engineAt !== 'number' || !Number.isFinite(engineAt))
        return null
      const at = Math.max(engineAt, this.activityAt.get(threadId) ?? 0)
      const key = JSON.stringify([sample.lastTurnId, engineAt])
      const before = usage(sample)
      // 空闲着的子会话这几项不会自己变：已试过、用量未知或未过阈值，等本机见到新活动或改设置再探测。
      if (line && (state.attempted === key || before === null || before <= settings.contextPercent))
        this.settled.add(threadId)
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
      link = await tree.link(harness)
      const read = () =>
        link!.request(
          IDLE_COMPACT_READ,
          { threadId },
          { timeoutMs: PREFLIGHT_MS },
        ) as Promise<IdleCompactSnapshot>
      const snapshot = await read()
      if (!isObject(snapshot) || !ready(snapshot)) return
      // 子会话还有没答的提问（收尾时的 ask 等）也算在等用户，不压缩。
      if (line && (await tree.awaitingAnswer(threadId))) return
      if (this.now() - probedAt > PREFLIGHT_MS) return
      await tree.watch(harness, threadId)
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
            ...(line ? { line: true, harness } : {}),
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
      if (link) tree.releaseLater(harness, threadId)
    }
  }

  close(): void {
    this.closed = true
    this.settled.clear()
    this.running.clear()
    this.nextProbe.clear()
    this.nextLog.clear()
    this.activityAt.clear()
  }
}
