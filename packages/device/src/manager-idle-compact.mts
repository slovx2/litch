import type { Manager } from '../../protocol/src/manager.mjs'
import {
  DEFAULT_MANAGER_IDLE_COMPACT,
  IDLE_COMPACT_READ,
  type IdleCompactSnapshot,
  idleCompactSupports,
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

// 引擎支持范围见 idleCompactSupports：Codex 的压缩不能按快照核对、也不交回回合号；
// OpenCode 的压缩是不等结果的 summarize 请求，服务还开放给别的客户端；DSH、ACP 没有压缩入口。

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
 * 经理（harness 支持时）及其各层 Claude Code、Pi 子会话的空闲压缩。子会话沿用所属经理的开关和阈值，
 * 所属关系按会话树的祖先判断（ManagerLines.managerFor）。
 */
export class ManagerIdleCompact {
  private readonly owner: DeviceManagers
  private readonly now: () => number
  private readonly nextProbe = new Map<string, number>()
  private readonly nextLog = new Map<string, number>()
  private readonly skipped = new Map<string, string>()
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
    if (this.closed || !idleCompactSupports(harness) || !this.owner.lines.managerFor(threadId))
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
  private managerBlock(manager: Manager): string | null {
    if (this.closed) return 'closed'
    if (manager.status !== 'active') return 'managerInactive'
    if (!(manager.idleCompact ?? DEFAULT_MANAGER_IDLE_COMPACT).enabled) return 'disabled'
    return null
  }

  private candidateBlock(manager: Manager, threadId: string): string | null {
    const { external, store, tree, lines } = this.owner
    const block = this.managerBlock(manager) ?? tree.idleCompactBlock(threadId)
    if (block) return block
    if (threadId === manager.threadId) {
      if (!idleCompactSupports(manager.harness)) return 'unsupportedHarness'
      if (external?.store.queue.hasPendingDelivery(manager.id)) return 'externalDeliveryPending'
      if (store.hasDelivery(manager.id)) return 'managerDeliveryPending'
    } else {
      if (lines.managerFor(threadId)?.id !== manager.id) return 'managerChanged'
      if (!idleCompactSupports(tree.store.parentOf(threadId)?.harness ?? ''))
        return 'unsupportedHarness'
    }
    return null
  }

  private skip(managerId: string, threadId: string, reason: string): undefined {
    if (this.skipped.get(threadId) !== reason) {
      this.skipped.set(threadId, reason)
      this.owner.tree.host.log(
        `manager.idleCompact.skipped ${JSON.stringify({ managerId, threadId, reason })}`,
      )
    }
    return undefined
  }

  /** 经理本身在前，其后是各层没脱离、引擎支持的子会话（广度优先）。 */
  private targets(manager: Manager, byParent: Map<string, LineageRow[]>): Target[] {
    // 经理所用 harness 不支持时（如 Codex 经理），只压它的子会话。
    const found: Target[] = idleCompactSupports(manager.harness)
      ? [
          {
            threadId: manager.threadId,
            harness: manager.harness,
            since: manager.createdAt * 1000,
            line: false,
          },
        ]
      : []
    const queue = [manager.threadId]
    const seen = new Set(queue)
    while (queue.length) {
      for (const row of byParent.get(queue.shift() as string) ?? []) {
        if (seen.has(row.threadId)) continue
        seen.add(row.threadId)
        queue.push(row.threadId)
        if (idleCompactSupports(row.harness))
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

  /** 沿用经理投递的定时器；空闲未到期或已知受阻的会话不查询引擎。 */
  tick(only?: string): void {
    if (this.closed) return
    const one = only ? this.owner.store.manager(only) : null
    const managers = (only ? (one ? [one] : []) : this.owner.store.managers()).filter((manager) => {
      const block = this.managerBlock(manager)
      if (!block) return true
      this.skip(manager.id, manager.threadId, block)
      return false
    })
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
        const block =
          now - localAt < idleMinutes * 60_000
            ? 'recentActivity'
            : (this.candidateBlock(manager, threadId) ??
              (line && this.running.size >= LINE_RUNNING_LIMIT ? 'lineLimit' : null))
        if (block) {
          this.skip(manager.id, threadId, block)
          continue
        }
        this.nextProbe.set(threadId, now + PROBE_MS)
        const began = this.owner.tree.runIdleCompact(threadId, (started) =>
          this.run(manager.id, threadId, harness, line, now, started).finally(() =>
            this.running.delete(threadId),
          ),
        )
        if (!began) this.skip(manager.id, threadId, 'serialQueueBusy')
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
    const skip = (reason: string) => this.skip(id, threadId, reason)
    const ready = (sample: IdleCompactSnapshot) => {
      const current = store.manager(id)
      if (!current) return skip('managerChanged')
      const block = this.candidateBlock(current, threadId)
      if (block) return skip(block)
      if (!sample.idle) return skip('engineBusy')
      const settings = current.idleCompact ?? DEFAULT_MANAGER_IDLE_COMPACT
      const state = store.idleCompact(threadId)
      const engineAt = sample.lastTurnActivityAt
      if (!sample.lastTurnId || typeof engineAt !== 'number' || !Number.isFinite(engineAt))
        return skip('lastTurnUnknown')
      const at = Math.max(engineAt, this.activityAt.get(threadId) ?? 0)
      const key = JSON.stringify([sample.lastTurnId, engineAt])
      const before = usage(sample)
      // 空闲着的子会话这几项不会自己变：已试过、用量未知或未过阈值，等本机见到新活动或改设置再探测。
      if (line && (state.attempted === key || before === null || before <= settings.contextPercent))
        this.settled.add(threadId)
      if (this.now() - at < settings.idleMinutes * 60_000) return skip('recentActivity')
      if (state.attempted === key) return skip('alreadyAttempted')
      if (before === null) return skip('usageUnknown')
      if (before <= settings.contextPercent) return skip('belowThreshold')
      return { state, key, before, at }
    }
    let link: EngineLink | undefined
    let committing = false
    let invalidated = false
    let dispatchedAt = 0
    try {
      const engine = await tree.link(harness)
      link = engine
      const read = () =>
        engine.request(
          IDLE_COMPACT_READ,
          { threadId },
          { timeoutMs: PREFLIGHT_MS },
        ) as Promise<IdleCompactSnapshot>
      const snapshot = await read()
      if (!isObject(snapshot)) return skip('snapshotUnavailable')
      if (!ready(snapshot)) return
      // 子会话还有没答的提问（收尾时的 ask 等）也算在等用户，不压缩。
      if (line && (await tree.awaitingAnswer(threadId))) return skip('awaitingAnswer')
      if (this.now() - probedAt > PREFLIGHT_MS) return skip('preflightExpired')
      // 在同一串行锁内先投能立即投的回报。暂时唤醒不了的仍留队；新来的交给正常回报检查。
      const reports = tree.wakeNoteVersion(threadId)
      if (reports && (await tree.wakeBeforeIdleCompact(threadId))) return skip('reportDelivered')
      if (tree.wakeNoteVersion(threadId) !== reports) return skip('reportsChanged')
      if (this.now() - probedAt > PREFLIGHT_MS) return skip('preflightExpired')
      await tree.watch(harness, threadId)
      // 恢复、调度或订阅的等待期间可能收到新输入，因此在启动前再查一次。
      const current = await read()
      if (!isObject(current)) return skip('snapshotUnavailable')
      const plan = ready(current)
      if (!plan) return
      if (tree.wakeNoteVersion(threadId) !== reports) return skip('reportsChanged')
      const watch = watchTurn(link, threadId)
      try {
        const response = await link.request(
          'thread/compact/start',
          { threadId, litchIdleCompact: current },
          {
            beforeSend: () => {
              const latest = ready(current)
              const reason =
                tree.wakeNoteVersion(threadId) !== reports
                  ? 'reportsChanged'
                  : this.now() - probedAt > PREFLIGHT_MS
                    ? 'preflightExpired'
                    : latest && latest.key !== plan.key
                      ? 'workChanged'
                      : null
              if (!latest || reason) {
                if (reason) skip(reason)
                invalidated = true
                throw new Error('压缩前状态已改变或检查已过期')
              }
              // 先记本轮尝试。连接断开、应答不明或设备重启也不会在同一轮反复压。
              store.saveIdleCompact(threadId, { ...latest.state, attempted: latest.key })
              this.skipped.delete(threadId)
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
      if (this.closed || invalidated) return
      // 旧引擎不支持探测，视作用量未知。其它失败留下线索，不循环尝试。
      if (error instanceof UpstreamRpcError && error.code === -32601 && !committing) {
        this.nextProbe.set(threadId, this.now() + RETRY_MS)
        skip('engineUnsupported')
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
    this.skipped.clear()
    this.activityAt.clear()
  }
}
