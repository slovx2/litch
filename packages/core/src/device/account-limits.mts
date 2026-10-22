// 一台设备上各 harness 的账号额度（account/rateLimits/read、account/rateLimits/updated）在客户端这一头的样子。
// accountLimits 主题开着（用量环的弹层）才去读，之后跟着 updated 通知并进去。读过的留着：
// 下次打开先给上次的，隔了 REREAD_MS 以上再读一遍。对面不认识这个方法、读失败了都当没有额度，不报错。
import type {
  ClientRequestMethod,
  ClientRequests,
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from '../../../protocol/src/index.mjs'
import type { AccountLimitsOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'
import type { AccountLimitRow, AccountLimitsView } from '../model-limits.mjs'

export interface AccountLimitsHost {
  deviceId: string
  now(): number
  online(): boolean
  /** 对面是设备服务的聚合面：请求要带 harness，通知里带着 harness */
  aggregated(): boolean
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  log(line: string): void
}

export interface AccountLimits {
  /** 订阅一个 harness 的额度。先给快照，之后给增量；返回退订函数 */
  open(harness: string, sink: HostSink): () => void
  /** 连上并认出对面是谁了 */
  resync(): void
  /** 连接断了：在途的结果都不算数了 */
  offline(): void
  /** 是额度的通知就处理掉并返回 true */
  notification(method: string, params: unknown): boolean
}

/** 两次读之间至少隔多久：Claude Code 每读一次要起一个 CLI */
const REREAD_MS = 30_000
/** 读最多等多久：Claude Code 要起 CLI 去问，它自己 20 秒超时 */
const READ_TIMEOUT_MS = 25_000

/** 读到的额度：主额度和别的额度，按 limitId */
interface Known {
  main: RateLimitSnapshot | null
  others: Record<string, RateLimitSnapshot>
}

interface Entry {
  sinks: Set<HostSink>
  known: Known | null
  /** 上次开始读的时刻 */
  readAt: number | null
  reading: boolean
}

const windowOf = (window: RateLimitWindow) => ({
  usedPercent: window.usedPercent,
  windowMins: window.windowDurationMins ?? null,
  resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : null,
})

/** 一份额度的两个窗口，短的在前 */
const rowsOf = (snapshot: RateLimitSnapshot, name: string | null): AccountLimitRow[] => {
  const rows: AccountLimitRow[] = []
  const id = snapshot.limitId ?? ''
  if (snapshot.primary) rows.push({ id: `${id}:primary`, name, window: windowOf(snapshot.primary) })
  if (snapshot.secondary)
    rows.push({ id: `${id}:secondary`, name, window: windowOf(snapshot.secondary) })
  return rows.sort(
    (a, b) =>
      (a.window.windowMins ?? Number.MAX_SAFE_INTEGER) -
      (b.window.windowMins ?? Number.MAX_SAFE_INTEGER),
  )
}

export function projectLimits(known: Known | null): AccountLimitRow[] {
  if (!known) return []
  const rows = known.main ? rowsOf(known.main, null) : []
  for (const [id, snapshot] of Object.entries(known.others))
    rows.push(...rowsOf(snapshot, snapshot.limitName ?? id))
  return rows
}

/** 把稀疏的更新并进去：没给的窗口沿用原来的 */
const mergeSnapshot = (
  was: RateLimitSnapshot | null | undefined,
  next: RateLimitSnapshot,
): RateLimitSnapshot =>
  was
    ? {
        ...was,
        ...next,
        primary: next.primary ?? was.primary,
        secondary: next.secondary ?? was.secondary,
      }
    : next

const fromResponse = (response: GetAccountRateLimitsResponse): Known => {
  const main = response.rateLimits ?? null
  const others: Record<string, RateLimitSnapshot> = {}
  for (const [id, snapshot] of Object.entries(response.rateLimitsByLimitId ?? {}))
    if (snapshot && id !== (main?.limitId ?? null)) others[id] = snapshot
  return { main, others }
}

export function createAccountLimits(host: AccountLimitsHost): AccountLimits {
  const entries = new Map<string, Entry>()
  /** 每次连上、断开换一个代号：回来的结果不是这一轮的就作废 */
  let epoch = 0

  const entryOf = (harness: string): Entry => {
    let entry = entries.get(harness)
    if (!entry) {
      entry = { sinks: new Set(), known: null, readAt: null, reading: false }
      entries.set(harness, entry)
    }
    return entry
  }

  const view = (harness: string, entry: Entry): AccountLimitsView => ({
    deviceId: host.deviceId,
    harness,
    rows: projectLimits(entry.known),
  })

  const emit = (harness: string, entry: Entry) => {
    const ops: AccountLimitsOp[] = [{ op: 'limits.set', view: view(harness, entry) }]
    for (const sink of entry.sinks) sink.delta(ops)
  }

  const read = (harness: string, entry: Entry) => {
    if (entry.reading || !host.online()) return
    if (entry.readAt !== null && host.now() - entry.readAt < REREAD_MS) return
    const mine = epoch
    entry.reading = true
    entry.readAt = host.now()
    host
      .request('account/rateLimits/read', host.aggregated() ? { harness } : {}, {
        timeoutMs: READ_TIMEOUT_MS,
      })
      .then(
        (response) => {
          if (mine !== epoch) return
          entry.known = fromResponse(response)
          emit(harness, entry)
        },
        // 不认识这个方法（Pi、OpenCode……）、超时：留着上次读到的，从没读到过就是没有额度
        (error: unknown) => host.log(`读 ${harness} 的账号额度失败：${String(error)}`),
      )
      .finally(() => {
        if (mine === epoch) entry.reading = false
      })
  }

  return {
    open(harness, sink) {
      const entry = entryOf(harness)
      entry.sinks.add(sink)
      sink.snapshot(view(harness, entry))
      read(harness, entry)
      return () => {
        entry.sinks.delete(sink)
      }
    },

    resync() {
      epoch++
      // 上次连接读到的先留着显示，开着的重新读一遍
      for (const [harness, entry] of entries) {
        entry.reading = false
        entry.readAt = null
        if (entry.sinks.size > 0) read(harness, entry)
      }
    },

    offline() {
      epoch++
      for (const entry of entries.values()) entry.reading = false
    },

    notification(method, params) {
      if (method !== 'account/rateLimits/updated') return false
      const fields = params as { rateLimits?: RateLimitSnapshot; harness?: unknown } | null
      const snapshot = fields?.rateLimits
      if (!snapshot || typeof snapshot !== 'object') return true
      const from = typeof fields.harness === 'string' ? fields.harness : null
      for (const [harness, entry] of entries) {
        // 聚合面上只并进发通知的那个 harness；单 harness 的连接只有一个
        if (host.aggregated() && from !== harness) continue
        // 还没读到过的不并：只有一份稀疏的更新，等读
        if (!entry.known) continue
        const id = snapshot.limitId
        if (id === null || id === (entry.known.main?.limitId ?? null))
          entry.known = { ...entry.known, main: mergeSnapshot(entry.known.main, snapshot) }
        else
          entry.known = {
            ...entry.known,
            others: {
              ...entry.known.others,
              [id]: mergeSnapshot(entry.known.others[id], snapshot),
            },
          }
        emit(harness, entry)
      }
      return true
    },
  }
}
