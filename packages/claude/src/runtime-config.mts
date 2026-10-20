import {
  providerLoopSelectionInputFromEnv,
  resolveProviderLoopSelection,
} from './provider-loop-selection.mjs'

export type RuntimeBackendType =
  | 'mock'
  | 'agent-sdk-sidecar'
  | 'agent-http'
  | 'agentapi'
  | 'claude-p'
  // codex-proxy = `codex exec --json` per turn. Selected per-thread when the
  // user picks a gpt-* model in the App's model dropdown.
  | 'codex-proxy'

export interface RuntimeConfig {
  type: RuntimeBackendType
  http: {
    baseUrl: string
    useSse: boolean
    pollIntervalMs: number
    timeoutMs: number
    sendInterruptRaw: boolean
    manageBridge: boolean
    modeCommand: string
  }
  claudeP: {
    command: string
    extraArgs: string[]
    timeoutMs: number
    skipPermissions: boolean
    resume: boolean
    stopTimeoutRetries: number
  }
  /** 原生运行时（Agent SDK）的几个开关。原生运行时每次起 CLI 时按同一个函数现读，这里读一遍是为了启动时就把非法值报出来 */
  native: {
    settingSources: ClaudeSettingSource[]
    plansLocation: ClaudePlansLocation
    threadIdHeader: boolean
    extendedCacheTtl: boolean
  }
}

export type ClaudeSettingSource = 'user' | 'project' | 'local'
const settingSourceNames: readonly ClaudeSettingSource[] = ['user', 'project', 'local']

/**
 * CHA_CLAUDE_SETTING_SOURCES：起 CLI 时读哪几层 Claude Code 自己的设置（SDK 的 settingSources），逗号分隔，
 * 取值 user、project、local。没设或为空时三层都读（Claude Code 自己的默认）；只给 user 时工作区里的
 * `.claude/settings*.json`、`CLAUDE.md`、`.mcp.json` 都不读。认不出的值直接报错，不默默退回默认
 */
export function claudeSettingSources(env: NodeJS.ProcessEnv = process.env): ClaudeSettingSource[] {
  const raw = env.CHA_CLAUDE_SETTING_SOURCES?.trim()
  if (!raw) return [...settingSourceNames]
  const sources: ClaudeSettingSource[] = []
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase() as ClaudeSettingSource
    if (!settingSourceNames.includes(name) || sources.includes(name))
      throw new Error(
        `CHA_CLAUDE_SETTING_SOURCES 无效：${raw}（只能是 user、project、local，用逗号隔开、不重复）`,
      )
    sources.push(name)
  }
  return sources
}

export type ClaudePlansLocation = 'workspace' | 'config'

/**
 * CHA_CLAUDE_PLANS_LOCATION：计划模式的计划文件放在哪。workspace（默认）是工作区里每个线程一个目录
 * （`<cwd>/.claude/plans/codex-harness-adapter/<线程号>/`）；config 是 Claude Code 自己的默认位置
 * （`<CLAUDE_CONFIG_DIR 或 ~/.claude>/plans/`），工作区里不留东西。CLI 的 plansDirectory 只认项目内的目录，
 * 给项目外的目录它会报错并退回自己的默认位置，所以没法指定任意目录
 */
export function claudePlansLocation(env: NodeJS.ProcessEnv = process.env): ClaudePlansLocation {
  const raw = env.CHA_CLAUDE_PLANS_LOCATION?.trim().toLowerCase()
  if (!raw || raw === 'workspace') return 'workspace'
  if (raw === 'config') return 'config'
  throw new Error(
    `CHA_CLAUDE_PLANS_LOCATION 无效：${env.CHA_CLAUDE_PLANS_LOCATION}（只能是 workspace 或 config）`,
  )
}

/**
 * CHA_CLAUDE_THREAD_ID_HEADER：设成 1 时起 CLI 前把 `thread-id: <线程号>` 合进 ANTHROPIC_CUSTOM_HEADERS，
 * CLI 发的每个模型请求都带上，给按线程计费的代理用（代理转发上游前要自己剥掉）。默认关，关着时一个多余的头都不加。
 * 不带回合号：CLI 进程跨回合保活，起进程时定下的头分不出回合
 */
export function claudeThreadIdHeader(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CHA_CLAUDE_THREAD_ID_HEADER?.trim().toLowerCase()
  if (!raw || raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true
  throw new Error(
    `CHA_CLAUDE_THREAD_ID_HEADER 无效：${env.CHA_CLAUDE_THREAD_ID_HEADER}（只能是 1 或 0）`,
  )
}

/**
 * 开关开着时给 CLI 的环境补的那一项：CLI 把 ANTHROPIC_CUSTOM_HEADERS 按行拆，每行 `名字: 值`。
 * 用户原有的自定义头原样保留，原有的 thread-id 行换成这个线程的；开关关着时是空对象
 */
export function claudeThreadIdHeaderEnv(
  childEnv: NodeJS.ProcessEnv,
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): { ANTHROPIC_CUSTOM_HEADERS?: string } {
  if (!claudeThreadIdHeader(env)) return {}
  const kept = (childEnv.ANTHROPIC_CUSTOM_HEADERS ?? '').split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false
    const colon = line.indexOf(':')
    return colon < 0 || line.slice(0, colon).trim().toLowerCase() !== 'thread-id'
  })
  return { ANTHROPIC_CUSTOM_HEADERS: [...kept, `thread-id: ${threadId}`].join('\n') }
}

/** 1 小时提示缓存的 beta 名 */
export const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

/**
 * CHA_CLAUDE_EXTENDED_CACHE_TTL：默认开，入口往 ANTHROPIC_BETAS 补上 1 小时缓存的 beta，CLI 发的 anthropic-beta 多这一项。
 * 设成 0 时不补，CLI 发的 beta 头和直接跑 CLI 时一样（用户自己在 ANTHROPIC_BETAS 里写的照旧）
 */
export function claudeExtendedCacheTtl(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CHA_CLAUDE_EXTENDED_CACHE_TTL?.trim().toLowerCase()
  if (!raw || raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false
  throw new Error(
    `CHA_CLAUDE_EXTENDED_CACHE_TTL 无效：${env.CHA_CLAUDE_EXTENDED_CACHE_TTL}（只能是 1 或 0）`,
  )
}

/** 开关开着时把 1 小时缓存的 beta 补进 ANTHROPIC_BETAS（已有的保留）；关着时不动 */
export function applyExtendedCacheTtlBeta(env: NodeJS.ProcessEnv = process.env): void {
  if (!claudeExtendedCacheTtl(env)) return
  const betas = env.ANTHROPIC_BETAS
  if (!betas) env.ANTHROPIC_BETAS = EXTENDED_CACHE_TTL_BETA
  else if (!betas.includes(EXTENDED_CACHE_TTL_BETA))
    env.ANTHROPIC_BETAS = `${betas},${EXTENDED_CACHE_TTL_BETA}`
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const explicit = normalizeRuntimeType(
    env.CHA_CLAUDE_RUNTIME_TYPE ?? env.CHA_CLAUDE_RUNTIME ?? env.CHA_CLAUDE_BACKEND,
  )
  const selection = resolveProviderLoopSelection(providerLoopSelectionInputFromEnv(env, explicit))
  const type = selection.runtimeType

  return {
    type,
    http: {
      baseUrl: normalizeBaseUrl(
        env.CHA_CLAUDE_HTTP_BASE_URL ??
          env.CHA_CLAUDE_AGENT_HTTP_URL ??
          env.CHA_CLAUDE_AGENTAPI_URL ??
          'http://127.0.0.1:3284',
      ),
      useSse: envFlag(env.CHA_CLAUDE_HTTP_USE_SSE, true),
      pollIntervalMs: numericEnv(env.CHA_CLAUDE_HTTP_POLL_MS, 500, 100, 60_000),
      timeoutMs: numericEnv(env.CHA_CLAUDE_HTTP_TIMEOUT_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
      sendInterruptRaw: envFlag(env.CHA_CLAUDE_HTTP_INTERRUPT_RAW, false),
      manageBridge: envFlag(env.CHA_CLAUDE_HTTP_MANAGE_BRIDGE, false),
      modeCommand: env.CHA_CLAUDE_MODE_COMMAND || 'codex-harness-adapter-mode',
    },
    claudeP: {
      command: env.CHA_CLAUDE_CLAUDE_P_COMMAND || env.CLAUDE_P || 'claude-p',
      extraArgs: stringList(env.CHA_CLAUDE_CLAUDE_P_ARGS),
      timeoutMs: numericEnv(
        env.CHA_CLAUDE_CLAUDE_P_TIMEOUT_MS,
        5 * 60_000,
        1_000,
        24 * 60 * 60_000,
      ),
      skipPermissions: envFlag(env.CHA_CLAUDE_CLAUDE_P_SKIP_PERMISSIONS, false),
      resume: envFlag(env.CHA_CLAUDE_CLAUDE_P_RESUME, false),
      stopTimeoutRetries: numericEnv(env.CHA_CLAUDE_CLAUDE_P_STOP_TIMEOUT_RETRIES, 1, 0, 5),
    },
    native: {
      settingSources: claudeSettingSources(env),
      plansLocation: claudePlansLocation(env),
      threadIdHeader: claudeThreadIdHeader(env),
      extendedCacheTtl: claudeExtendedCacheTtl(env),
    },
  }
}

export function normalizeRuntimeType(value: string | undefined): RuntimeBackendType | null {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return null
  switch (raw) {
    case 'mock':
      return 'mock'
    case 'sdk':
    case 'agent-sdk':
    case 'agent-sdk-sidecar':
    case 'sidecar':
    case 'cloud-agent-sdk':
      return 'agent-sdk-sidecar'
    case 'agent-sdk-socket':
    case 'socket':
    case 'runtime-socket':
      return 'agent-sdk-sidecar'
    case 'agent-http':
    case 'channels':
    case 'channel':
    case 'http-channel':
      return 'agent-http'
    case 'agentapi':
    case 'agent-api':
      return 'agentapi'
    case 'claude-p':
    case 'claudep':
    case 'pty-transcript':
      return 'claude-p'
    case 'codex-proxy':
    case 'codex-exec':
      // Per-thread codex-proxy passthrough. Distinct from the shim-level
      // 'codex' mode (which bypasses our adapter entirely) — codex-proxy
      // keeps the adapter daemon in the loop and forwards just the turn.
      return 'codex-proxy'
    default:
      throw new Error(`unknown CHA_CLAUDE_RUNTIME_TYPE: ${value}`)
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback
  const raw = value.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function numericEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function stringList(value: string | undefined): string[] {
  if (!value || !value.trim()) return []
  const raw = value.trim()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {}
  return raw.split(/\s+/).filter(Boolean)
}
