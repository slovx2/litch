import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { cliCommand, resolveHostCli } from '../../shared/src/host-cli.mjs'
import { subscriptionEnv } from './backend-loader.mjs'

interface Window {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}
export interface QuotaSnapshot {
  limitId: string
  limitName: string | null
  primary: Window | null
  secondary: null
  credits: null
  planType: null
  rateLimitReachedType: null
}
export interface QuotaResponse {
  rateLimits: QuotaSnapshot
  rateLimitsByLimitId: Record<string, QuotaSnapshot>
}
const blank = (id = 'agy', name: string | null = null): QuotaSnapshot => ({
  limitId: id,
  limitName: name,
  primary: null,
  secondary: null,
  credits: null,
  planType: null,
  rateLimitReachedType: null,
})
export const emptyQuota = (): QuotaResponse => ({
  rateLimits: blank(),
  rateLimitsByLimitId: {},
})
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** 官方只读 /usage 的结构化结果；response 是展示文本，usage 是 token，均不作为额度来源。 */
export function parseQuota(value: unknown): QuotaResponse {
  const result = emptyQuota()
  const root = record(value)
  const command = record(root?.command)
  const groups = record(command?.data)?.groups
  if (root?.status !== 'SUCCESS' || command?.name !== 'usage' || !Array.isArray(groups))
    return result
  for (const entry of groups) {
    const group = record(entry)
    if (typeof group?.name !== 'string' || !Array.isArray(group.buckets)) continue
    const snapshots: QuotaSnapshot[] = []
    for (const entry of group.buckets) {
      const bucket = record(entry)
      const remaining = bucket?.remaining_fraction
      if (
        !bucket ||
        bucket.disabled === true ||
        typeof bucket.id !== 'string' ||
        !bucket.id ||
        typeof remaining !== 'number' ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1
      )
        continue
      const minutes = bucket.window === '5h' ? 300 : bucket.window === 'weekly' ? 10080 : null
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN
      const name =
        minutes === null && typeof bucket.name === 'string'
          ? `${group.name} · ${bucket.name}`
          : group.name
      snapshots.push({
        ...blank(`agy:${bucket.id}`, name),
        primary: {
          usedPercent: Math.round((1 - remaining) * 100),
          windowDurationMins: minutes,
          resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null,
        },
      })
    }
    snapshots.sort(
      (a, b) =>
        (a.primary?.windowDurationMins ?? Infinity) - (b.primary?.windowDurationMins ?? Infinity),
    )
    for (const snapshot of snapshots) result.rateLimitsByLimitId[snapshot.limitId] = snapshot
  }
  return result
}

/** 由 CLI 自己使用登录态；不接触账号文件，不输出 stdout/stderr 或原始错误。 */
export function queryQuota(
  home: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<unknown> {
  // 自定义 ACP 参数可能指向另一账号目录或独立 ACP 程序，不能擅自查默认 CLI 的额度。
  if (env.CHA_AGY_ARGS !== undefined && env.CHA_AGY_ARGS.trim() !== 'acp')
    return Promise.resolve(null)
  const command = env.CHA_AGY_CLI?.trim() || 'agy'
  const cli = resolveHostCli(command, command, '', env, !!env.CHA_AGY_CLI?.trim())
  const [file, ...args] = cliCommand(cli, ['-p', '/usage', '--output-format', 'json'])
  if (!file) return Promise.resolve(null)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: home,
        env: subscriptionEnv(env),
        signal,
        timeout: 20_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) return resolve(null)
        try {
          resolve(JSON.parse(stdout))
        } catch {
          resolve(null)
        }
      },
    ).stdin?.end()
  })
}

/** 按需读、30 秒缓存与并发合并；只在曾经读到额度后响应回合结束，不设轮询。 */
export class AccountQuota {
  private value = emptyQuota()
  private readAt = -Infinity
  private inFlight: Promise<QuotaResponse> | undefined
  private controller = new AbortController()
  private epoch = 0
  private closed = false
  private readonly query: (signal: AbortSignal) => Promise<unknown>
  private readonly publish: (snapshot: QuotaSnapshot) => void
  private readonly now: () => number
  constructor(
    query: (signal: AbortSignal) => Promise<unknown>,
    publish: (snapshot: QuotaSnapshot) => void,
    now: () => number = Date.now,
  ) {
    this.query = query
    this.publish = publish
    this.now = now
  }

  read(): Promise<QuotaResponse> {
    if (this.closed) return Promise.resolve(emptyQuota())
    if (this.inFlight) return this.inFlight
    if (this.now() - this.readAt < 30_000) return Promise.resolve(this.value)
    this.readAt = this.now()
    const epoch = this.epoch
    const signal = this.controller.signal
    const asking = Promise.resolve()
      .then(() => (signal.aborted ? null : this.query(signal)))
      .then(parseQuota, () => emptyQuota())
      .then((value) => {
        if (epoch !== this.epoch || this.closed) return emptyQuota()
        this.replace(value)
        return value
      })
      .finally(() => {
        if (this.inFlight === asking) this.inFlight = undefined
      })
    this.inFlight = asking
    return asking
  }

  afterTurn(): void {
    if (Object.keys(this.value.rateLimitsByLimitId).length) void this.read()
  }

  private replace(value: QuotaResponse): void {
    const previous = this.value.rateLimitsByLimitId
    this.value = value
    for (const snapshot of Object.values(value.rateLimitsByLimitId)) this.publish(snapshot)
    // 两个窗口显式 null 表示这项额度不再可用，不能继续显示上一个账号或查询失败前的值。
    for (const id of Object.keys(previous))
      if (!value.rateLimitsByLimitId[id]) this.publish(blank(id))
  }

  invalidate(): void {
    this.epoch++
    this.controller.abort()
    this.controller = new AbortController()
    this.inFlight = undefined
    this.readAt = -Infinity
    this.replace(emptyQuota())
  }

  close(): void {
    this.closed = true
    this.invalidate()
  }
}
