import { commandEnv } from '../../shared/src/command-env.mjs'

export { commandEnv } from '../../shared/src/command-env.mjs'

import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { type FSWatcher, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ApprovalPolicy } from './approval-policy.mjs'
import {
  customPermissionProfileList,
  isCustomPermissionProfile,
  profileSandboxMode,
  resolvePermissionProfile,
} from './permission-profiles.mjs'
import { ProtocolError, pageRecords, submissionHash } from './protocol-contract.mjs'
import { defaultSandboxPolicy } from './sandbox-policy.mjs'

export { normalizeApprovalPolicy } from './approval-policy.mjs'

import type { SessionStore } from './store.mjs'
import type {
  ClaudeRuntime,
  FileUpdateChange,
  ImageInput,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  PermissionDecision,
  RpcPeer,
  RuntimeEvent,
  ThreadItem,
  ThreadRecord,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnRecord,
  UserInput,
  UserInputAnswers,
  UserInputQuestion,
  WireMessage,
} from './types.mjs'
import { answerText } from './user-questions.mjs'
import {
  adapterHome,
  claudeModelOptions,
  claudeOutputFormat,
  codexCliVersion,
  codexHome,
  codexProxyModelOptions,
  codexUserAgent,
  debugLog,
  defaultAllowedTools,
  ensureParent,
  extractImageInputs,
  isCodexOpenAiModel,
  modelDisplayName,
  newId,
  normalizeCodexReasoningEffort,
  nowMillis,
  nowSeconds,
  platformFamily,
  platformOs,
  resolveClaudeEffort,
  resolveClaudeModel,
  textFromInput,
} from './util.mjs'

const execFileAsync = promisify(execFile)

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

export type SelectableModelOption = {
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
  efforts?: string[]
}

// 原生目录取得前只提供默认项；默认项交由原生 SDK 解析 settings.json。
const defaultModelOption: SelectableModelOption = {
  id: 'default',
  sdkModel: null,
  displayName: 'Default',
  description: 'Use the model configured for Claude Code',
  isDefault: true,
}
let runtimeModelCatalog: { key: string; options: SelectableModelOption[] } | null = null

// 原生目录随固定 CLI 与 Claude 用户设置变化；设置文件改变后重新读取。
function modelCatalogKey(): string {
  const settings = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    'settings.json',
  )
  try {
    const stat = statSync(settings)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'none'
  }
}

// 以 resolvedModel（实际发往模型接口的型号）生成带精确版本的显示名，例如
// claude-opus-5-5[1m] → Opus 5.5 (1M context)；无法识别的格式沿用 CLI 显示名。
export function modelNameFromResolved(resolved: string | undefined): string | null {
  const match = resolved?.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/)
  if (!match?.[1] || !match[2]) return null
  const [, family, major, minor, longContext] = match
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`
  return longContext ? `${name} (1M context)` : name
}

export async function loadRuntimeModelCatalog(runtime: ClaudeRuntime): Promise<void> {
  if (process.env.CHA_CLAUDE_MODELS || !runtime.supportedModels) return
  const key = modelCatalogKey()
  if (runtimeModelCatalog?.key === key) return
  try {
    const models = await runtime.supportedModels()
    runtimeModelCatalog = {
      key,
      options: models.map((model) => {
        const precise = modelNameFromResolved(model.resolvedModel)
        return {
          id: model.value,
          sdkModel: model.value === 'default' ? null : model.value,
          // 选择仍传原生别名，CLI 升级后别名自动指向新型号；只有显示名带精确版本。
          displayName: precise
            ? model.value === 'default'
              ? `Default · ${precise}`
              : precise
            : model.displayName,
          description: model.description,
          isDefault: model.value === 'default',
          ...(model.supportedEffortLevels ? { efforts: model.supportedEffortLevels } : {}),
        }
      }),
    }
  } catch (error) {
    debugLog('model.catalog.failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function allSelectableModelOptions(): SelectableModelOption[] {
  if (process.env.CHA_CLAUDE_MODELS) return claudeModelOptions()
  return runtimeModelCatalog?.options ?? [defaultModelOption]
}

// 除目录行外，也接受 CLI 可直接解析的别名与完整型号（例如持久化的 opus）；
// 显式配置 CHA_CLAUDE_MODELS 时只接受该列表。
export function isSelectableModel(id: string): boolean {
  if (allSelectableModelOptions().some((option) => option.id.toLowerCase() === id.toLowerCase()))
    return true
  if (process.env.CHA_CLAUDE_MODELS) return false
  return (
    /^(default|best|opusplan|sonnet-1m|opus-plan|(sonnet|opus|haiku|fable)(\[1m\])?)$/.test(id) ||
    /^claude-[a-z0-9.-]+(\[1m\])?$/.test(id)
  )
}

export function defaultSelectableModelId(): string {
  const options = allSelectableModelOptions()
  const defaultModel = process.env.CHA_CLAUDE_DEFAULT_MODEL
  if (defaultModel && isSelectableModel(defaultModel)) return catalogModelId(defaultModel)
  return options.find((option) => option.isDefault === true)?.id ?? options[0]?.id ?? 'default'
}

// 和目录里某一行只是大小写不同的，按目录里的写法记：会话报的模型和 model/list 的那一行逐字相同。
export function catalogModelId(id: string): string {
  return (
    allSelectableModelOptions().find((option) => option.id.toLowerCase() === id.toLowerCase())
      ?.id ?? id
  )
}

// model/list 里给目录之外的模型补的一行：配置的默认模型（CHA_CLAUDE_DEFAULT_MODEL 或 config 的 model）、
// 会话指定的模型。CLI 别名和完整型号都认，原样交给它；能看出型号的显示精确名字，看不出的照原文。
export function extraModelOption(id: string, isDefault: boolean): SelectableModelOption {
  return {
    id,
    sdkModel: id,
    displayName: modelNameFromResolved(id) ?? modelDisplayName(id),
    description: isDefault
      ? 'Default model configured for this adapter'
      : 'Model selected for an existing thread',
    isDefault,
  }
}

export function normalizeSelectableModelId(value: string, fallback: string): string {
  const options = allSelectableModelOptions()
  for (const candidate of [value, fallback])
    if (isSelectableModel(candidate))
      return (
        options.find((option) => option.id.toLowerCase() === candidate.toLowerCase())?.id ??
        candidate
      )
  const defaultModel = defaultSelectableModelId()
  debugLog('config.model.repaired', { requestedModel: value, repairedModel: defaultModel })
  return defaultModel
}

export function modelFromParams(params: Record<string, unknown>, fallback: string | null): string {
  const config = asRecord(params.config)
  if (typeof params.model === 'string' && params.model.length > 0) return params.model
  if (typeof config.model === 'string' && config.model.length > 0) return config.model
  return fallback ?? ''
}

export function reasoningEffortFromParams(
  params: Record<string, unknown>,
  fallback: string | null,
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  const config = asRecord(params.config)
  const effort =
    typeof params.effort === 'string'
      ? params.effort
      : typeof config.model_reasoning_effort === 'string'
        ? config.model_reasoning_effort
        : fallback
  return normalizeCodexReasoningEffort(effort)
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function commandArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((part) => part.length > 0)
  if (typeof value === 'string' && value.trim())
    return [process.env.SHELL || '/bin/sh', '-lc', value]
  return []
}

/**
 * 参数里会带密钥、授权码的方法：登录（粘贴回来的授权码、API key、设备码）、provider 和 MCP 的写入
 * （密钥字段、env、headers）、配置写入（env 里的值）。这些参数的值不进调试日志，只记标识和有哪些键；
 * 按键名去盖（redact）盖不全，授权码的键就叫 code。
 */
const SECRET_PARAM_METHOD =
  /^(litch\/harness\/(auth\/|mcp\/login$|providers\/upsert$|mcp\/upsert$|config\/write$)|account\/login\/|mcpServer\/oauth\/|config\/(value\/write|batchWrite)$)/
const SECRET_PARAM_ID_KEYS = [
  'harness',
  'providerId',
  'methodId',
  'attemptId',
  'loginId',
  'templateId',
  'name',
  'previousName',
  'type',
] as const

export function summarizeRpcParams(method: string, params: unknown): unknown {
  const rec = asRecord(params)
  if (SECRET_PARAM_METHOD.test(method)) {
    const summary: Record<string, unknown> = {}
    for (const key of SECRET_PARAM_ID_KEYS)
      if (typeof rec[key] === 'string') summary[key] = rec[key]
    summary.paramKeys = Object.keys(rec)
    return summary
  }
  if (method === 'turn/start') {
    return {
      threadId: rec.threadId,
      cwd: rec.cwd,
      model: rec.model,
      effort: rec.effort,
      configEffort: asRecord(rec.config).model_reasoning_effort,
      hasOutputSchema: rec.outputSchema != null,
      inputTypes: Array.isArray(rec.input) ? rec.input.map((item) => asRecord(item).type) : [],
    }
  }
  if (method === 'process/spawn' || method === 'command/exec') {
    return {
      processHandle: rec.processHandle,
      processId: rec.processId,
      cwd: rec.cwd,
      command: commandArray(rec.command),
      streamStdoutStderr: rec.streamStdoutStderr,
      streamStdin: rec.streamStdin,
      tty: rec.tty,
      timeoutMs: rec.timeoutMs,
    }
  }
  if (method.includes('outputDelta')) {
    return {
      processHandle: rec.processHandle,
      processId: rec.processId,
      itemId: rec.itemId,
      stream: rec.stream,
      deltaBytes:
        typeof rec.deltaBase64 === 'string'
          ? Buffer.from(rec.deltaBase64, 'base64').byteLength
          : typeof rec.delta === 'string'
            ? rec.delta.length
            : 0,
      capReached: rec.capReached,
    }
  }
  if (method === 'item/agentMessage/delta') {
    return {
      threadId: rec.threadId,
      turnId: rec.turnId,
      itemId: rec.itemId,
      deltaChars: typeof rec.delta === 'string' ? rec.delta.length : 0,
    }
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = asRecord(rec.item)
    return {
      threadId: rec.threadId,
      turnId: rec.turnId,
      item: { id: item.id, type: item.type },
    }
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    const turn = asRecord(rec.turn)
    const items = Array.isArray(turn.items)
      ? turn.items.map((item) => ({ id: asRecord(item).id, type: asRecord(item).type }))
      : []
    return {
      threadId: rec.threadId,
      turn: { id: turn.id, status: turn.status, items },
    }
  }
  return rec
}

export function reviewLabel(target: unknown): string {
  const rec = asRecord(target)
  const type = stringOr(rec.type, 'uncommittedChanges')
  if (type === 'commit')
    return (
      'commit ' + stringOr(rec.sha, '') + (typeof rec.title === 'string' ? ': ' + rec.title : '')
    )
  if (type === 'baseBranch') return 'base branch ' + stringOr(rec.branch, 'main')
  if (type === 'custom') return stringOr(rec.instructions, 'custom review')
  return 'uncommitted changes'
}

export function reviewPrompt(target: unknown): string {
  const label = reviewLabel(target)
  return [
    'Review the code changes for: ' + label,
    '',
    'Prioritize correctness bugs, regressions, security issues, and missing tests.',
    'Return findings first, ordered by severity, with file and line references when available.',
    'If there are no actionable issues, say so clearly and mention residual risk.',
  ].join('\n')
}

export function compactSummary(thread: ThreadRecord, turns: TurnRecord[]): string {
  const snippets = turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === 'userMessage' || item.type === 'agentMessage')
    .slice(-12)
    .map((item) => {
      if (item.type === 'userMessage') return 'User: ' + textFromInput(item.content).slice(0, 500)
      if (item.type === 'agentMessage') return 'Assistant: ' + item.text.slice(0, 500)
      return ''
    })
    .filter(Boolean)
  return [
    'Context compacted for thread ' + thread.id + '.',
    '',
    snippets.length > 0
      ? snippets.join('\n')
      : 'No prior conversation content was available to summarize.',
  ].join('\n')
}

export function stringListFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {}
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
          if (typeof record.content === 'string') return record.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
  }
  return ''
}

export function fallbackStructuredText(outputSchema: unknown, prompt: string): string {
  return JSON.stringify(coerceStructuredValue(outputSchema, prompt), null, 0)
}

// claude-agent-sdk has shipped the subagent-spawning tool under both `Task`
// (older) and `Agent` (current 0.2.x) names; accept both plus a few common
// variants so the native collabAgentToolCall path triggers regardless of
// which name the model emits. Without this, an `Agent` tool_use falls
// through to the generic mcpToolCall branch and its inner Bash calls leak
// into the parent thread as a flat list (the bug seen on mac-mini).
export function isSubagentToolName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false
  const n = name.trim().toLowerCase()
  return (
    n === 'task' || n === 'agent' || n === 'subagent' || n === 'spawn_agent' || n === 'spawnagent'
  )
}

export function normalizeSandboxMode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v === 'read-only' || v === 'workspace-write' || v === 'danger-full-access' ? v : null
}

export interface PermissionProfilePolicy {
  id: string
  approvalPolicy: ApprovalPolicy | null
  sandboxMode: string | null
}

export function normalizePermissionProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id.length > 0 && id.length <= 128 ? id : null
}

export function permissionProfileIdFromParams(params: Record<string, unknown>): string | null {
  const direct = normalizePermissionProfileId(params.permissions)
  if (direct) return direct
  const active = asRecord(params.activePermissionProfile)
  return normalizePermissionProfileId(active.id)
}

export function hasLegacyPermissionParams(params: Record<string, unknown>): boolean {
  return (
    params.approvalPolicy != null ||
    typeof params.sandbox === 'string' ||
    (params.sandboxPolicy !== null &&
      typeof params.sandboxPolicy === 'object' &&
      !Array.isArray(params.sandboxPolicy))
  )
}

// permissions：配置里的 `permissions` 表。那里定义的档位按条目算出旧式沙箱模式（permission-profiles.mts）
export function permissionProfilePolicy(
  value: unknown,
  permissions?: unknown,
): PermissionProfilePolicy | null {
  const id = normalizePermissionProfileId(value)
  if (!id) return null
  if (isCustomPermissionProfile(permissions, id))
    return {
      id,
      approvalPolicy: null,
      sandboxMode: profileSandboxMode(resolvePermissionProfile(permissions, id)),
    }
  switch (id) {
    case ':read-only':
      return { id, approvalPolicy: 'on-request', sandboxMode: 'read-only' }
    case ':workspace':
      return { id, approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }
    case ':danger-full-access':
      return { id, approvalPolicy: 'never', sandboxMode: 'danger-full-access' }
    default:
      // Custom profiles are still reported to the App, but their policy is
      // resolved by the caller's explicit approval/sandbox fields when those
      // are available. Never silently grant a broader policy for an unknown id.
      return { id, approvalPolicy: null, sandboxMode: null }
  }
}

export function threadPermissionProfileId(
  permissionProfileId: string | null | undefined,
  approvalPolicy: ApprovalPolicy | null,
  sandboxMode: string | null,
): string | null {
  const explicit = normalizePermissionProfileId(permissionProfileId)
  if (explicit) return explicit
  if (sandboxMode === 'read-only') return ':read-only'
  if (sandboxMode === 'danger-full-access' && approvalPolicy === 'never')
    return ':danger-full-access'
  if (sandboxMode === 'workspace-write' && approvalPolicy === 'on-request') return ':workspace'
  return null
}

// turn/start uses `sandboxPolicy: SandboxPolicy` (a struct) instead of the
// thread/start `sandbox: SandboxMode` string. Translate the struct's `type`
// back to the internal canonical mode string the sidecar understands.
export function sandboxFromTurnParams(params: Record<string, unknown>): string | null {
  if (typeof params.sandbox === 'string') return normalizeSandboxMode(params.sandbox)
  const policy = params.sandboxPolicy
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null
  const type = (policy as Record<string, unknown>).type
  if (type === 'dangerFullAccess') return 'danger-full-access'
  if (type === 'readOnly') return 'read-only'
  if (type === 'workspaceWrite' || type === 'externalSandbox') return 'workspace-write'
  return null
}

export function normalizePersonality(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (
    v === 'none' ||
    v === 'friendly' ||
    v === 'pragmatic' ||
    v === 'cynic' ||
    v === 'robot' ||
    v === 'nerd'
  )
    return v
  return null
}

// Codex v2 ReasoningEffort enum (top-level, used by collabAgentToolCall and
// elsewhere). No serde(other) fallback — anything outside this set crashes
// the App's deserializer (same trap as threadSource = ""). Pass any value
// through here before emitting it on the wire.
export function normalizeReasoningEffortEnum(
  value: string | null | undefined,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (
    v === 'none' ||
    v === 'minimal' ||
    v === 'low' ||
    v === 'medium' ||
    v === 'high' ||
    v === 'xhigh'
  )
    return v
  return null
}

// Codex App's settings sheet writes the persistent reasoning-effort default
// under `params.config.model_reasoning_effort` (the same shape as the Codex
// CLI's `config.toml`). turn/start's top-level `effort` is only set when the
// user overrides for a single turn — the chosen value from the model picker
// otherwise lives in the config bag. Read both so the App's effort dropdown
// actually changes Claude's thinking budget instead of silently no-op'ing.
export function readConfigReasoningEffort(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null
  const cfg = config as Record<string, unknown>
  const direct = cfg.model_reasoning_effort ?? cfg['model_reasoning_effort']
  if (typeof direct === 'string' && direct.length > 0) return direct
  return null
}

// Codex v2 `ThreadSource` is a strict 3-variant enum with no `serde(other)`
// fallback. Anything outside this set (including an empty string) makes the
// App's ts-rs deserializer panic on `thread/list` / `thread/read` — which the
// user sees as the generic "Oops, an error has occurred" toast. Force every
// write/read through this gate so we never persist or ship an invalid value.
export function normalizeThreadSource(
  value: unknown,
): 'user' | 'subagent' | 'memory_consolidation' | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v === 'user' || v === 'subagent' || v === 'memory_consolidation') return v
  return null
}

// Codex v2 `SessionSource` is camelCase (`appServer`, not `app_server`); it
// has `serde(other) Unknown` so the wrong casing won't crash the App, just
// silently fall back to `unknown`. Convert to the wire form to keep the
// thread metadata UI honest.
export function normalizeSessionSource(value: unknown): string {
  if (typeof value !== 'string') return 'appServer'
  const v = value.trim()
  if (v === 'cli' || v === 'vscode' || v === 'exec' || v === 'appServer' || v === 'unknown')
    return v
  if (v === 'app_server' || v === 'app-server') return 'appServer'
  return 'unknown'
}

// `agentRole` / `agentNickname` are `string | null` on the wire (not enums),
// so an empty string doesn't crash — but the App treats `""` as "present"
// and renders an empty chip. Coerce to null so the field is just absent.
export function nullIfEmpty(value: string | null | undefined): string | null {
  if (value == null) return null
  return value === '' ? null : value
}

// Assemble the per-thread system prompt addendum from Codex App's instruction
// surface. Sidecar concatenates this onto Claude's default system prompt so
// the user's project / developer / personality settings actually take effect.
export function buildSystemPromptAddendum(input: {
  baseInstructions: string | null
  developerInstructions: string | null
  personality: string | null
}): string | null {
  const sections: string[] = []
  const base = (input.baseInstructions ?? '').trim()
  if (base) sections.push(`# Project instructions\n${base}`)
  const dev = (input.developerInstructions ?? '').trim()
  if (dev) sections.push(`# Developer instructions\n${dev}`)
  const cue = personalityPromptCue(input.personality)
  if (cue) sections.push(cue)
  return sections.length > 0 ? sections.join('\n\n') : null
}

export function personalityPromptCue(personality: string | null): string | null {
  switch (personality) {
    case 'friendly':
      return 'Personality: friendly. Communicate in a warm, encouraging tone; default to plain language and short paragraphs.'
    case 'pragmatic':
      return 'Personality: pragmatic. Be concise and direct; lead with the answer, skip pleasantries, prefer concrete code or commands.'
    case 'cynic':
      return 'Personality: cynic. Be terse and wry; surface trade-offs and risks plainly; avoid hype.'
    case 'robot':
      return 'Personality: robot. Reply in clipped, structured prose; prefer bullet points and exact field names; minimise filler.'
    case 'nerd':
      return 'Personality: nerd. Get into mechanism and detail; explain underlying assumptions and edge cases when relevant.'
    case 'none':
    case null:
    default:
      return null
  }
}

// Codex App's thread envelope expects a sandbox object whose `type` matches the
// chosen tier. Returning the right shape lets the App render the correct badge
// (Read-only / Workspace / Full access) and stops it from over-prompting.
export function sandboxEnvelope(mode: string | null, cwd: string): unknown {
  return defaultSandboxPolicy(mode, cwd)
}

export function permissionProfileList(
  params: Record<string, unknown>,
  permissions?: unknown,
): unknown {
  if (params.cwd != null && (typeof params.cwd !== 'string' || !params.cwd.trim()))
    throw new ProtocolError(-32602, 'cwd 必须是非空字符串')
  const profiles: Array<{ id: string; description: string | null; allowed: boolean }> = [
    { id: ':read-only', description: null, allowed: true },
    { id: ':workspace', description: null, allowed: true },
    { id: ':danger-full-access', description: null, allowed: true },
    ...customPermissionProfileList(permissions),
  ]
  const { data, nextCursor } = pageRecords(
    profiles,
    { ...params, limit: params.limit ?? profiles.length, sortDirection: 'asc' },
    `permissions:${submissionHash({ profiles, cwd: params.cwd ?? null })}`,
    (profile) => profile.id,
  )
  return { data, nextCursor }
}

export function emptyTokenBreakdown(): TokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
}

// claude-agent-sdk's Task tool appends a fixed metadata trailer to the
// subagent's tool_result content:
//   `agentId: <hex> (use SendMessage with to: '<hex>' to continue this agent)`
//   `<usage>total_tokens: N\ntool_uses: M\nduration_ms: K</usage>`
// Codex App renders neither natively — they just show as raw text after the
// real result. Strip both from the visible body and surface the values via
// agentNickname / token usage / metrics so the subagent timeline carries the
// SDK-reported identity and cost.
interface SubagentTrailer {
  cleanText: string
  agentId: string | null
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null
}

// Codex v2 McpToolCallResult requires {content[], structuredContent, _meta}.
// Claude SDK tool_result.content is one of: a string, an array of Anthropic
// content blocks ({type:'text'|'image', ...}), or a structured JsonValue.
// Wrap into the protocol shape — if content is already an array, use it; if
// it's a primitive/object, materialize as a single text block so the App
// renders something useful instead of an empty result.
export function wrapMcpToolResult(content: unknown): {
  content: unknown[]
  structuredContent: unknown | null
  _meta: unknown | null
} {
  if (content == null) return { content: [], structuredContent: null, _meta: null }
  if (Array.isArray(content)) return { content, structuredContent: null, _meta: null }
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof content === 'object' ? content : null,
    _meta: null,
  }
}

// Codex v2 McpToolCallError requires { message: string } — and nothing else.
// Coerce any tool_result body the SDK gave us into that single-field shape.
export function wrapMcpToolError(content: unknown): { message: string } {
  if (content == null) return { message: 'tool call failed' }
  if (typeof content === 'string') return { message: content }
  if (Array.isArray(content)) {
    // Concatenate any text blocks; fall back to a JSON dump.
    const text = content
      .map((b) =>
        b && typeof b === 'object' && (b as any).type === 'text'
          ? String((b as any).text ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n')
    return { message: text || JSON.stringify(content) }
  }
  if (typeof content === 'object' && content && typeof (content as any).message === 'string') {
    return { message: (content as any).message }
  }
  return { message: JSON.stringify(content) }
}

// Agent 工具的结构化结果（SDK 的 tool_use_result）：正文不带模型侧的包装前缀与尾部，
// 用量来自运行统计。只认已完成的形态，后台启动回执不是结果。
export function subagentStructuredResult(value: unknown): SubagentTrailer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  if (result.status !== 'completed' || !Array.isArray(result.content)) return null
  const cleanText = result.content
    .map((block) =>
      block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text'
        ? String((block as Record<string, unknown>).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n')
  const totalTokens = Number(result.totalTokens)
  return {
    cleanText,
    agentId: typeof result.agentId === 'string' && result.agentId ? result.agentId : null,
    usage: Number.isFinite(totalTokens)
      ? {
          totalTokens,
          toolUses: Number(result.totalToolUseCount) || 0,
          durationMs: Number(result.totalDurationMs) || 0,
        }
      : null,
  }
}

// 工具结果写回对应条目：命令、文件修改、MCP 调用与搜索各自的终态字段不同。
export function toolItemWithResult(
  item: ThreadItem,
  content: unknown,
  isError: boolean,
  durationMs: number | null,
): ThreadItem {
  if (item.type === 'commandExecution')
    return {
      ...item,
      status: isError ? 'failed' : 'completed',
      aggregatedOutput: item.aggregatedOutput ?? toolResultText(content),
      exitCode: parseExitCodeFromResult(content) ?? (isError ? 1 : 0),
      durationMs,
    }
  if (item.type === 'fileChange') return { ...item, status: isError ? 'failed' : 'completed' }
  if (item.type === 'mcpToolCall')
    // 协议要求 McpToolCallResult = {content[], structuredContent, _meta}，错误为 {message}。
    return {
      ...item,
      status: isError ? 'failed' : 'completed',
      result: isError ? null : wrapMcpToolResult(content),
      error: isError ? wrapMcpToolError(content) : null,
      durationMs,
    }
  if (item.type === 'webSearch')
    return { ...item, action: parseWebSearchAction(item.query, toolResultText(content)) }
  return item
}

// 用户在审批里拒绝（含“拒绝并停下”）的调用：没有执行，所以命令没有输出、退出码和时长，
// 给模型看的那句拒绝的话也不写进条目。照上游 app-server：命令和文件改动有专门的 declined 状态；
// 别的条目类型协议里没有这种状态（MCP 工具调用上游也记成失败，原因在 error 里），原样返回、照旧由工具结果收尾。
export function declinedToolItem(item: ThreadItem): ThreadItem {
  if (item.type === 'commandExecution')
    return { ...item, status: 'declined', aggregatedOutput: null, exitCode: null, durationMs: null }
  if (item.type === 'fileChange') return { ...item, status: 'declined' }
  return item
}

export function parseSubagentTrailer(text: string): SubagentTrailer {
  if (!text) return { cleanText: '', agentId: null, usage: null }
  let cleanText = text
  let agentId: string | null = null
  let usage: SubagentTrailer['usage'] = null

  const usageMatch = cleanText.match(
    /<usage>\s*total_tokens:\s*(\d+)\s*\n\s*tool_uses:\s*(\d+)\s*\n\s*duration_ms:\s*(\d+)\s*<\/usage>\s*$/,
  )
  if (usageMatch) {
    usage = {
      totalTokens: Number(usageMatch[1]) || 0,
      toolUses: Number(usageMatch[2]) || 0,
      durationMs: Number(usageMatch[3]) || 0,
    }
    cleanText = cleanText.slice(0, usageMatch.index).replace(/\s+$/, '')
  }

  const agentMatch = cleanText.match(/\n?agentId:\s*([0-9a-f]{8,32})\b[^\n]*\s*$/i)
  if (agentMatch) {
    agentId = agentMatch[1] ?? null
    cleanText = cleanText.slice(0, agentMatch.index).replace(/\s+$/, '')
  }

  return { cleanText, agentId, usage }
}

// Best-effort parse of a Claude Bash tool_result for the real shell exit
// code. Claude's tool result content is usually plain stdout/stderr, but in
// some failure modes (and via custom wrappers / Codex CLI shims) the SDK
// suffixes a `Exit code: N` / `exit status N` marker. Returning null lets
// the caller fall back to 0/1 from event.isError.
// Map Claude's TodoWrite input to Codex v2 TurnPlanStep[]. Claude todos carry
// { content, status, activeForm } with status pending|in_progress|completed;
// the wire TurnPlanStepStatus is camelCase pending|inProgress|completed.
export function todoWriteToPlanSteps(
  input: Record<string, unknown>,
): Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }> | null {
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  return todos.map((raw) => {
    const todo = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const step =
      typeof todo.content === 'string' && todo.content.length > 0
        ? todo.content
        : typeof todo.activeForm === 'string'
          ? todo.activeForm
          : ''
    const status =
      todo.status === 'in_progress'
        ? 'inProgress'
        : todo.status === 'completed'
          ? 'completed'
          : 'pending'
    return { step, status }
  })
}

export function parseExitCodeFromResult(content: unknown): number | null {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((p) => (typeof p === 'string' ? p : ((p as Record<string, unknown>)?.text ?? '')))
            .join('')
        : ''
  if (!text) return null
  const match = text.match(/(?:Exit code|exit status|exit code):\s*(-?\d+)/i)
  if (!match) return null
  const code = Number(match[1])
  return Number.isFinite(code) ? code : null
}

// Best-effort: when the WebSearch tool returns a result, sniff whether the
// first result was an explicit page open vs a result list. Codex App's
// `webSearch` ThreadItem renders the action badge accordingly.
export function parseWebSearchAction(
  query: string,
  resultText: string,
):
  | { type: 'search'; query: string | null; queries: string[] | null }
  | { type: 'openPage'; url: string | null }
  | { type: 'findInPage'; pattern: string | null; url: string | null }
  | { type: 'other' } {
  // Codex v2 WebSearchAction variants are tagged but the inner fields are NOT
  // optional in Rust — they're `Option<...>` with NO `#[serde(default)]`, so
  // App rejects an item that ships a bare {type:'search'} (missing required
  // fields). Always populate every field of the chosen variant, even if null.
  if (!resultText) return { type: 'search', query: query || null, queries: null }
  const urlMatch = resultText.match(/https?:\/\/[^\s)\]"'<]+/)
  if (urlMatch && query) return { type: 'openPage', url: urlMatch[0] }
  return { type: 'search', query: query || null, queries: null }
}

// Maps the raw Anthropic usage block carried on the Claude Agent SDK
// ResultMessage onto the Codex `TokenUsageBreakdown` shape. Cache-creation
// tokens count as input; Claude does not separate reasoning output tokens.
export function tokenBreakdownFromClaudeUsage(usage: Record<string, unknown>): TokenUsageBreakdown {
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheCreation = num(usage.cache_creation_input_tokens)
  const inputTokens = num(usage.input_tokens) + cacheCreation
  const outputTokens = num(usage.output_tokens)
  return {
    inputTokens,
    cachedInputTokens: cacheRead,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + cacheRead + outputTokens,
  }
}

export function coerceStructuredValue(schema: unknown, prompt: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return prompt
  const record = schema as Record<string, unknown>
  if (record.type === 'string') return conciseStructuredString(prompt)
  if (record.type === 'array') {
    const itemSchema =
      record.items && typeof record.items === 'object' && !Array.isArray(record.items)
        ? record.items
        : { type: 'string' }
    const values = prompt
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*\d.、)\s]+/, ''))
      .filter(Boolean)
    return (values.length > 0 ? values : prompt.trim() ? [prompt.trim()] : [])
      .slice(0, 10)
      .map((value) => coerceStructuredValue(itemSchema, value))
  }
  if (record.type !== 'object') return null
  const properties =
    record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(record.required)
    ? record.required.map(String)
    : Object.keys(properties)
  const result: Record<string, unknown> = {}
  for (const key of required) {
    const property = properties[key]
    result[key] = coerceStructuredValue(property, prompt)
  }
  return result
}

export function conciseStructuredString(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const source = lines.at(-1) ?? prompt.trim()
  const colon = Math.max(source.lastIndexOf('：'), source.lastIndexOf(':'))
  const value = colon >= 0 ? source.slice(colon + 1).trim() : source
  return value
    .replace(/^[-*\d.、)\s]+/, '')
    .slice(0, 80)
    .trim()
}

export function normalizeDecision(response: unknown): PermissionDecision['decision'] {
  const decision = asRecord(response).decision
  if (
    decision === 'accept' ||
    decision === 'acceptForSession' ||
    decision === 'decline' ||
    decision === 'cancel'
  )
    return decision
  // 仅接受本请求 availableDecisions 中的决策；未提供策略修订时不能把任意对象升级为授权。
  return 'decline'
}

export function fileChangeFromTool(
  toolName: string,
  input: Record<string, unknown>,
): FileUpdateChange[] {
  const path = String(input.file_path ?? input.path ?? input.filename ?? 'unknown')
  const current = readText(path)
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((edit, index) => {
      const rec = asRecord(edit)
      const target = String(input.file_path ?? input.path ?? `edit-${index}`)
      const oldText = String(rec.old_string ?? '')
      const newText = String(rec.new_string ?? '')
      return {
        path: target,
        kind: { type: 'update', move_path: null },
        diff: simpleDiff(target, oldText, newText, editStart(current, oldText, newText)),
      }
    })
  }
  if (toolName === 'Write') {
    // 与原生 Codex 一致：新建文件的 diff 就是完整内容（客户端按行计为新增）；覆盖已有文件是更新，给出统一 diff。
    const content = String(input.content ?? '')
    if (current === null) return [{ path, kind: { type: 'add' }, diff: content }]
    return [
      {
        path,
        kind: { type: 'update', move_path: null },
        diff: simpleDiff(path, current, content, 1),
      },
    ]
  }
  const oldText = String(input.old_string ?? '')
  const newText = String(input.new_string ?? '')
  return [
    {
      path,
      kind: { type: 'update', move_path: null },
      diff: simpleDiff(path, oldText, newText, editStart(current, oldText, newText)),
    },
  ]
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 改动从文件的第几行开始：CLI 发来调用时多半还没改，按旧文字找；已经改完了（来晚了）按新文字找。
 * 都找不到（文件读不到、文字对不上）算第 1 行：行号不准，但增删照样画得出来
 */
function editStart(content: string | null, oldText: string, newText: string): number {
  if (content === null) return 1
  for (const text of [oldText, newText]) {
    if (!text) continue
    const at = content.indexOf(text)
    if (at >= 0) return content.slice(0, at).split('\n').length
  }
  return 1
}

/** 一段文字拆成补丁里的行：末尾的换行不多出一个空行，中间的空行照留 */
function patchLines(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/**
 * 旧文字整段换成新文字的统一格式补丁，一个 hunk，从 start 行起。hunk 头带行号和行数：
 * 只写 “@@” 的客户端认不出是补丁，增删就不染色了
 */
export function simpleDiff(path: string, oldText: string, newText: string, start = 1): string {
  const removed = patchLines(oldText)
  const added = patchLines(newText)
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${removed.length ? start : start - 1},${removed.length} +${added.length ? start : start - 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n')
}

// `git diff` failing is expected outside a repo, so we still return '' to keep
// turns working — but the reason is written to the debug log instead of being
// dropped silently, and a genuine git error is flagged as such.
export function isNotAGitRepo(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not a git repository/i.test(message)
}

// Cheap upfront check — if cwd isn't in a git work-tree, skip the expensive
// `git diff` spawn entirely. Without this guard a non-git workspace (App
// Remote pointing at $HOME or any arbitrary dir) was spamming debug.jsonl
// with multi-KB "not a git repository" failures on every turn cycle, since
// gitDiff runs from runRuntimeTurn after each tool result.
const gitRepoCache = new Map<string, boolean>()
export async function isGitWorkTree(cwd: string): Promise<boolean> {
  if (gitRepoCache.has(cwd)) return gitRepoCache.get(cwd) as boolean
  let inside = false
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      timeout: 3_000,
      maxBuffer: 1024,
    })
    inside = stdout.trim() === 'true'
  } catch {
    inside = false
  }
  gitRepoCache.set(cwd, inside)
  return inside
}

// 回合 diff 只能包含本回合的改动：开始时把工作区（含未跟踪文件，遵守忽略规则）写入临时索引得到基线树，
// 之后与当前工作区树比较。真实索引只被复制作为 stat 缓存，不会被修改；与 Codex Desktop 的回合 diff 捕获方式一致。
export async function gitWorktreeTree(cwd: string): Promise<string | null> {
  if (!(await isGitWorkTree(cwd))) return null
  const directory = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-index-'))
  const index = join(directory, 'index')
  const git = (args: string[]) =>
    execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_INDEX_FILE: index },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
  try {
    const { stdout: realIndex } = await execFileAsync('git', ['rev-parse', '--git-path', 'index'], {
      cwd,
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    })
    await copyFile(resolve(cwd, realIndex.trim()), index).catch(() => undefined)
    await git(['add', '-A', '--', '.'])
    return (await git(['write-tree'])).stdout.trim() || null
  } catch (error) {
    debugLog('git.snapshot.failed', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function gitTurnDiff(cwd: string, base: string | null): Promise<string> {
  if (!base) return ''
  const current = await gitWorktreeTree(cwd)
  if (!current) return ''
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--no-ext-diff', '--no-color', base, current, '--'],
      {
        cwd,
        timeout: 10_000,
        maxBuffer: 5 * 1024 * 1024,
      },
    )
    return stdout
  } catch (error) {
    debugLog('git.turnDiff.failed', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    })
    return ''
  }
}

export async function gitDiff(cwd: string): Promise<string> {
  if (!(await isGitWorkTree(cwd))) return ''
  let trackedDiff = ''
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], {
      cwd,
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    trackedDiff = stdout
  } catch (error) {
    debugLog('git.diff.failed', {
      cwd,
      reason: isNotAGitRepo(error) ? 'notAGitRepository' : 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    return ''
  }
  const untrackedDiff = await gitUntrackedDiff(cwd)
  return [trackedDiff, untrackedDiff].filter(Boolean).join('\n')
}

export async function gitUntrackedDiff(cwd: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      {
        cwd,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    )
    const paths = stdout.split('\0').filter(Boolean).slice(0, 50)
    const diffs: string[] = []
    for (const path of paths) {
      const bytes = await readFile(`${cwd}/${path}`)
      if (bytes.includes(0)) continue
      diffs.push(addedFileDiff(path, bytes.toString('utf8')))
    }
    return diffs.join('\n')
  } catch (error) {
    debugLog('git.untrackedDiff.failed', {
      cwd,
      reason: isNotAGitRepo(error) ? 'notAGitRepository' : 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    return ''
  }
}

export function addedFileDiff(path: string, text: string): string {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n')
}

// Normalise the App's item/tool/requestUserInput response into the shape the
// runtime expects. The Codex wire schema is
// `{answers: {[questionId]: {answers: string[]}}}` — we accept that plus a
// couple of forgiving variants (the App's experimental field set changes over
// time) and fall back to empty per-question selections when nothing parses.
export function normalizeUserInputAnswers(
  response: unknown,
  questions: UserInputQuestion[],
): UserInputAnswers {
  const empty: UserInputAnswers = {
    answers: Object.fromEntries(questions.map((q) => [q.id, { answers: [] as string[] }])),
  }
  if (!response || typeof response !== 'object') return empty
  const root = response as Record<string, unknown>
  const slot = (root.answers ?? root) as Record<string, unknown>
  if (!slot || typeof slot !== 'object') return empty
  const out: UserInputAnswers['answers'] = {}
  for (const q of questions) {
    const raw = (slot as Record<string, unknown>)[q.id]
    if (!raw) {
      out[q.id] = { answers: [] }
      continue
    }
    if (Array.isArray(raw)) {
      out[q.id] = { answers: raw.map(String) }
      continue
    }
    if (typeof raw === 'string') {
      out[q.id] = { answers: [raw] }
      continue
    }
    const entry = raw as Record<string, unknown>
    const list = Array.isArray(entry.answers) ? entry.answers.map(String) : []
    const notes = typeof entry.notes === 'string' ? entry.notes : null
    out[q.id] = notes != null ? { answers: list, notes } : { answers: list }
  }
  return { answers: out }
}

// Build the Codex dynamicToolCall contentItems body for the answered question.
// One inputText item per question, formatted as `Header: answer`. This is what
// the App renders under the choice card after the user picks an option.
// 答案的字和交给模型的是同一份（user-questions.mts 的 answerText），不按文字挑拣。
export function userInputAnswersAsContent(
  questions: UserInputQuestion[],
  answers: UserInputAnswers,
): Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }> {
  const out: Array<{ type: 'inputText'; text: string }> = []
  for (const q of questions) {
    const body = answerText(answers.answers[q.id]) || '(no answer)'
    out.push({ type: 'inputText', text: `${q.header}: ${body}` })
  }
  return out
}
