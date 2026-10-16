import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'

const identityKeys =
  /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_|CLOUD_ML_)/
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
export function rateLimitCredentialScope(cwd: string): string | null {
  if (
    existsSync('/Library/Application Support/ClaudeCode/managed-settings.json') ||
    existsSync('/etc/claude-code/managed-settings.json')
  )
    return null
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (identityKeys.test(key) && value !== undefined) env[key] = value
  const directories: string[] = []
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    directories.unshift(directory)
    if (directory === dirname(directory)) break
  }
  const paths = [
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    ...directories.flatMap((directory) => [
      join(directory, '.claude', 'settings.json'),
      join(directory, '.claude', 'settings.local.json'),
    ]),
  ]
  const constraints: Record<string, unknown> = {}
  try {
    for (const path of paths) {
      if (!existsSync(path)) continue
      const settings: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
      const record = settings as Record<string, unknown>
      if (dynamicSettings.some((key) => record[key])) return null
      for (const key of ['forceLoginMethod', 'forceLoginOrgUUID'])
        if (record[key] !== undefined) constraints[key] = record[key]
      if (record.env !== undefined) {
        if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) return null
        for (const [key, value] of Object.entries(record.env))
          if (identityKeys.test(key)) {
            if (typeof value !== 'string') return null
            env[key] = value
          }
      }
    }
  } catch {
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
        env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
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

export class AccountRateLimits {
  private scope: string | null = null
  // SDK 的原始比例和状态单独保存，不从 token 数或费用估算配额。
  private observed = new Map<string, SDKRateLimitInfo>()

  private synchronize(): string | null {
    const scope = rateLimitCredentialScope(process.cwd())
    if (scope !== this.scope) {
      this.scope = scope
      this.observed.clear()
    }
    return scope
  }

  record(scope: string | null, info: NativeRateLimitInfo): RateLimitSnapshot[] {
    const current = this.synchronize()
    if (!scope || scope !== current) return []
    const before = this.read().rateLimitsByLimitId
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
          this.observed.set(type, { ...window, status: info.status })
    if (
      info.rateLimitType &&
      limitTypes.has(info.rateLimitType) &&
      validUtilization(info.utilization)
    )
      this.observed.set(info.rateLimitType, { ...info })
    const after = this.read()
    return Object.entries(after.rateLimitsByLimitId)
      .filter(([id, snapshot]) => JSON.stringify(before[id]) !== JSON.stringify(snapshot))
      .map(([, snapshot]) => snapshot)
  }

  read(): {
    rateLimits: RateLimitSnapshot
    rateLimitsByLimitId: Record<string, RateLimitSnapshot>
  } {
    this.synchronize()
    const rateLimits = emptySnapshot()
    const rateLimitsByLimitId: Record<string, RateLimitSnapshot> = { 'claude-code': rateLimits }
    for (const [type, info] of this.observed) {
      if (
        typeof info.utilization !== 'number' ||
        !Number.isFinite(info.utilization) ||
        info.utilization < 0
      )
        continue
      // 固定 0.157.1 JSON schema 要求 int32；四舍五入，不把超过 100% 的真实值钳为 100。
      const usedPercent = Math.round(info.utilization * 100)
      if (usedPercent > 2147483647) continue
      const window: RateLimitWindow = {
        usedPercent,
        windowDurationMins:
          type === 'five_hour' ? 300 : type.startsWith('seven_day') ? 10080 : null,
        resetsAt:
          Number.isSafeInteger(info.resetsAt) && (info.resetsAt ?? -1) >= 0 ? info.resetsAt! : null,
      }
      if (type === 'five_hour') rateLimits.primary = window
      else if (type === 'seven_day') rateLimits.secondary = window
      else {
        const snapshot = emptySnapshot(`claude-code:${type}`, `Claude Code ${type}`)
        snapshot.primary = window
        rateLimitsByLimitId[snapshot.limitId] = snapshot
      }
    }
    return { rateLimits, rateLimitsByLimitId }
  }
}
