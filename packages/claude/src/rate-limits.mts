import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import {
  credentialSettingsLayers,
  ignoresProjectSignIn,
  isClaudeSignInKey,
} from './claude-credential-settings.mjs'
import { contextLaunch, type ProviderLaunch } from './claude-provider.mjs'
import { hostClaudeRelease } from './host-claude.mjs'

// CLI 的 get_usage 控制请求（/usage 背后的数据）。用钥匙串或凭据文件登录的订阅账号才有额度，
// 用 API key、第三方 provider、只带推理权限的令牌时 rate_limits_available 是 false
export type NativeAccountUsage = Pick<
  SDKControlGetUsageResponse,
  'rate_limits_available' | 'rate_limits'
>

const identityKeys =
  /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_(?:TOKEN|REFRESH_TOKEN|SCOPES|CLIENT_ID)$|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_|CLOUD_ML_)/
const dynamicSettings = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']
const limitTypes = new Set([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
])

// 固定 CLI 2.1.282 的真实 allowed 事件把比例放在此字段；SDK 0.3.282 原样透传但类型声明未收录。
export type NativeRateLimitInfo = SDKRateLimitInfo & {
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>
}

// 只接受能识别变化的显式凭据。动态 helper、系统托管配置和 keychain 不冒充稳定账户。
// 指纹只保留在内存中，凭据和配置正文不能进入协议、日志或持久化。
export function rateLimitCredentialScope(
  cwd: string,
  launch?: Pick<ProviderLaunch, 'env' | 'flagSettings'>,
): string | null {
  if (
    existsSync('/Library/Application Support/ClaudeCode/managed-settings.json') ||
    existsSync('/etc/claude-code/managed-settings.json')
  )
    return null
  const env: Record<string, string> = {}
  const constraints: Record<string, unknown> = {}
  const helpers: Record<string, unknown> = {}
  try {
    const actual = launch ?? contextLaunch(null, null)
    for (const [key, value] of Object.entries(actual.env))
      if (identityKeys.test(key) && value !== undefined) env[key] = value
    const layers = credentialSettingsLayers(cwd, actual.env)
    if (actual.flagSettings)
      layers.push({ path: '--settings', project: false, settings: actual.flagSettings })
    let ignoreProjectSignIn: boolean | undefined
    for (const { settings: record, project } of layers) {
      for (const key of dynamicSettings) if (record[key] !== undefined) helpers[key] = record[key]
      for (const key of ['forceLoginMethod', 'forceLoginOrgUUID'])
        if (record[key] !== undefined) constraints[key] = record[key]
      if (record.env !== undefined) {
        if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) return null
        for (const [key, value] of Object.entries(record.env)) {
          if (project && isClaudeSignInKey(key)) {
            ignoreProjectSignIn ??= ignoresProjectSignIn(hostClaudeRelease(actual.env))
            if (ignoreProjectSignIn) continue
          }
          if (identityKeys.test(key)) {
            if (typeof value !== 'string') return null
            env[key] = value
          }
        }
      }
    }
    if (dynamicSettings.some((key) => helpers[key])) return null
  } catch {
    // 配置或 CLI 版本不可确认时，不猜测账号归属。
    return null
  }
  if (
    Object.entries(env).some(
      ([key, value]) => key.startsWith('CLAUDE_CODE_USE_') && value && value !== '0',
    )
  )
    return null
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN && !env.CLAUDE_CODE_OAUTH_TOKEN)
    return null
  return createHash('sha256')
    .update(
      JSON.stringify({
        env: Object.fromEntries(
          Object.entries(env)
            // 账号启动参数用空串清除网关变量；清除后与未配置属于同一身份。
            .filter(([, value]) => value !== '')
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
        constraints,
      }),
    )
    .digest('hex')
}

interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

interface RateLimitSnapshot {
  limitId: string
  limitName: string
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
  credits: null
  planType: null
  rateLimitReachedType: null
}

function emptySnapshot(limitId = 'claude-code', limitName = 'Claude Code'): RateLimitSnapshot {
  return {
    limitId,
    limitName,
    primary: null,
    secondary: null,
    credits: null,
    planType: null,
    rateLimitReachedType: null,
  }
}

function validUtilization(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    Math.round(value * 100) <= 2147483647
  )
}

/** 一个窗口的观测。比例是 0–1 的小数，重置时间是秒级时间戳；at 越大越新 */
interface Observation {
  utilization: number
  resetsAt: number | null
  at: number
  /** 按模型分的窗口给人看的名字 */
  name?: string
}

/** get_usage 里取哪几个固定窗口（seven_day_oauth_apps、extra_usage 不是用量窗口，不取） */
const fetchedTypes = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const
const windowNames: Record<string, string> = { seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet' }

type UsageWindow = { utilization: number | null; resets_at: string | null } | null | undefined

export class AccountRateLimits {
  private scope: string | null = null
  // SDK 的原始比例单独保存，不从 token 数或费用估算配额。
  // observed 是回合里 CLI 报的（rate_limit_event），只认显式凭据，凭据一变就清空；
  // fetched 是 get_usage 读到的整份，每读一次整个换掉。两边都有的窗口取新的那份
  private observed = new Map<string, Observation>()
  private fetched = new Map<string, Observation>()
  private tick = 0

  private synchronize(): string | null {
    const scope = rateLimitCredentialScope(process.cwd())
    if (scope !== this.scope) {
      this.scope = scope
      this.observed.clear()
    }
    return scope
  }

  /** 和 before 比，变了的快照 */
  private changes(before: Record<string, RateLimitSnapshot>): RateLimitSnapshot[] {
    return Object.entries(this.read().rateLimitsByLimitId)
      .filter(([id, snapshot]) => JSON.stringify(before[id]) !== JSON.stringify(snapshot))
      .map(([, snapshot]) => snapshot)
  }

  record(scope: string | null, info: NativeRateLimitInfo): RateLimitSnapshot[] {
    const current = this.synchronize()
    if (!scope || scope !== current) return []
    const before = this.read().rateLimitsByLimitId
    const at = ++this.tick
    if (
      info.unifiedWindows &&
      typeof info.unifiedWindows === 'object' &&
      !Array.isArray(info.unifiedWindows)
    )
      for (const [type, window] of Object.entries(info.unifiedWindows))
        if (
          limitTypes.has(type) &&
          window &&
          typeof window === 'object' &&
          !Array.isArray(window) &&
          validUtilization(window.utilization)
        )
          this.observed.set(type, {
            utilization: window.utilization,
            resetsAt: window.resetsAt ?? null,
            at,
          })
    if (
      info.rateLimitType &&
      limitTypes.has(info.rateLimitType) &&
      validUtilization(info.utilization)
    )
      this.observed.set(info.rateLimitType, {
        utilization: info.utilization,
        resetsAt: info.resetsAt ?? null,
        at,
      })
    return this.changes(before)
  }

  /** 换上 get_usage 读到的一整份。账号没有额度（API key 等）时清掉上次读到的 */
  replace(usage: NativeAccountUsage): RateLimitSnapshot[] {
    this.synchronize()
    const before = this.read().rateLimitsByLimitId
    this.fetched.clear()
    const limits = usage.rate_limits_available ? usage.rate_limits : null
    const at = ++this.tick
    const put = (type: string, window: UsageWindow, name?: string) => {
      // get_usage 给的是 0–100 的百分数，重置时间是 ISO 字符串
      if (!window || typeof window.utilization !== 'number') return
      const utilization = window.utilization / 100
      if (!validUtilization(utilization)) return
      const resets = window.resets_at ? Date.parse(window.resets_at) : Number.NaN
      this.fetched.set(type, {
        utilization,
        resetsAt: Number.isFinite(resets) ? Math.floor(resets / 1000) : null,
        at,
        ...(name ? { name } : {}),
      })
    }
    if (limits) {
      for (const type of fetchedTypes) put(type, limits[type])
      for (const model of Array.isArray(limits.model_scoped) ? limits.model_scoped : [])
        if (typeof model?.display_name === 'string' && model.display_name)
          put(`model:${model.display_name}`, model, model.display_name)
    }
    return this.changes(before)
  }

  read(): {
    rateLimits: RateLimitSnapshot
    rateLimitsByLimitId: Record<string, RateLimitSnapshot>
  } {
    this.synchronize()
    const rateLimits = emptySnapshot()
    const rateLimitsByLimitId: Record<string, RateLimitSnapshot> = { 'claude-code': rateLimits }
    const merged = new Map(this.fetched)
    for (const [type, entry] of this.observed)
      if ((merged.get(type)?.at ?? -1) < entry.at) merged.set(type, entry)
    for (const [type, info] of merged) {
      // 固定协议快照的 JSON schema 要求 int32；四舍五入，不把超过 100% 的真实值钳为 100。
      const usedPercent = Math.round(info.utilization * 100)
      const window: RateLimitWindow = {
        usedPercent,
        windowDurationMins:
          type === 'five_hour'
            ? 300
            : type.startsWith('seven_day') || type.startsWith('model:')
              ? 10080
              : null,
        resetsAt:
          Number.isSafeInteger(info.resetsAt) && (info.resetsAt ?? -1) >= 0 ? info.resetsAt : null,
      }
      if (type === 'five_hour') rateLimits.primary = window
      else if (type === 'seven_day') rateLimits.secondary = window
      else {
        const snapshot = emptySnapshot(
          `claude-code:${type}`,
          info.name ?? windowNames[type] ?? `Claude Code ${type}`,
        )
        snapshot.primary = window
        rateLimitsByLimitId[snapshot.limitId] = snapshot
      }
    }
    return { rateLimits, rateLimitsByLimitId }
  }
}
