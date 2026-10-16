import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  CODEX_PROTOCOL_VERSION,
  codexCliVersion as formatCliVersion,
  codexUserAgent as formatUserAgent,
} from '../../shared/src/runtime-version.mjs'

export { platformFamily, platformOs } from '../../shared/src/runtime-version.mjs'

import { setSharedLogger } from '../../shared/src/util.mjs'
import type { ImageInput } from './types.mjs'

// 所有 Claude 入口都经过此模块，不依赖 adapter main() 才启用共享模块日志。
setSharedLogger(debugLog)

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function nowMillis(): number {
  return Date.now()
}

export function newId(): string {
  return randomUUID()
}

export function codexHome(): string {
  return resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
}

export function adapterHome(): string {
  return resolve(
    process.env.CHA_CLAUDE_HOME || join(homedir(), '.codex-harness-adapter', 'claude-code'),
  )
}

// Unix domain socket paths are bounded by sockaddr_un.sun_path — roughly 104
// bytes on macOS and 108 on Linux. A deep CODEX_HOME (long usernames, nested
// workspaces) silently blew past that and surfaced as a cryptic EINVAL on
// connect. Fall back to a short, hashed path under the system temp dir.
export function socketPathLimit(): number {
  return platform() === 'darwin' ? 104 : 108
}

export function defaultSocketPath(): string {
  const preferred = join(codexHome(), 'app-server-control', 'app-server-control.sock')
  if (preferred.length <= socketPathLimit()) return preferred
  return join(tmpdir(), `ccx-${stableHash(preferred).slice(0, 16)}.sock`)
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
}

/** 记了、还没写出去的调试日志：写到哪个文件、哪几行（见 debugLog） */
let pendingLog: { path: string; lines: string[] } | null = null
/** 建好了的日志目录，不每一批都去建一遍 */
let readyLogDir: string | null = null
/** 进程正在退出：之后记的行当场写，不等下一轮事件循环（不会再有了） */
let exitingLog = false
process.on('exit', () => {
  exitingLog = true
  flushDebugLog()
})

/**
 * 记一行调试日志（默认写在状态目录的 debug.jsonl）。
 * 不当场写文件：每条通知都记一行，流式输出时一秒上千行，每行都同步地建目录、看大小、打开、写、关上，
 * 占了入口处理一条增量的一半开销。现在先攒着，这一轮事件循环的末尾（setImmediate）一次写出去，
 * 进程退出时（process.exit、正常停下）也写；行的先后不变，换了文件（改了 CHA_CLAUDE_DEBUG_LOG）时
 * 先把攒着的写进原来那个。进程被强杀时少的是最后这一轮里记的几行。
 */
export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.CHA_CLAUDE_DEBUG_LOG === '0' || process.env.CHA_CLAUDE_DEBUG_LOG === 'false')
    return
  const path = resolve(process.env.CHA_CLAUDE_DEBUG_LOG || join(adapterHome(), 'debug.jsonl'))
  let line: string
  try {
    const entry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...(redact(data) as Record<string, unknown>),
    }
    line = `${JSON.stringify(entry)}\n`
  } catch {
    return
  }
  if (pendingLog && pendingLog.path !== path) flushDebugLog()
  if (!pendingLog) {
    pendingLog = { path, lines: [] }
    if (!exitingLog) setImmediate(flushDebugLog)
  }
  pendingLog.lines.push(line)
  if (exitingLog) flushDebugLog()
}

/**
 * 把攒着的调试日志写出去。到了上限照旧轮换（rotateLogIfNeeded），在哪一行之前换和一行一行写时一样：
 * 写之前文件已经不小于上限，就先换一个新文件。写不成（磁盘满、没权限）就算了，日志不能耽误正事。
 */
export function flushDebugLog(): void {
  const pending = pendingLog
  pendingLog = null
  if (!pending) return
  const { path, lines } = pending
  try {
    const maxBytes = numericEnv('CHA_CLAUDE_DEBUG_LOG_MAX_BYTES', 50 * 1024 * 1024)
    let size = maxBytes > 0 ? fileSize(path) : 0
    let chunk = ''
    for (const line of lines) {
      if (maxBytes > 0 && size >= maxBytes) {
        appendLog(path, chunk)
        chunk = ''
        rotateLogIfNeeded(path)
        size = 0
      }
      chunk += line
      size += Buffer.byteLength(line)
    }
    appendLog(path, chunk)
  } catch {}
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 接在日志文件后面；目录没有（头一次写，或者被删了）就建了再写 */
function appendLog(path: string, text: string): void {
  if (!text) return
  const dir = dirname(path)
  if (readyLogDir !== dir) {
    ensureParent(path)
    readyLogDir = dir
  }
  try {
    appendFileSync(path, text)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    ensureParent(path)
    appendFileSync(path, text)
  }
}

// Long-running adapter daemons would otherwise grow debug.jsonl until the disk
// fills. Bound it with a simple `.1`/`.2`/... rotation: when the active log
// passes `maxBytes`, push it down one slot and start fresh. Bound by `keep`,
// dropping anything older. Sized envs override; failures swallow because the
// debug log is best-effort and must never break the main flow.
export function rotateLogIfNeeded(path: string): void {
  const maxBytes = numericEnv('CHA_CLAUDE_DEBUG_LOG_MAX_BYTES', 50 * 1024 * 1024)
  if (maxBytes <= 0) return
  const keep = Math.max(1, numericEnv('CHA_CLAUDE_DEBUG_LOG_KEEP', 3))
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return // file does not exist yet — nothing to rotate
  }
  if (size < maxBytes) return
  // Drop the oldest slot if it would push us past `keep`.
  const oldest = `${path}.${keep}`
  try {
    unlinkSync(oldest)
  } catch {}
  // Shift `.k-1` → `.k`, `.k-2` → `.k-1`, …, `.1` → `.2`.
  for (let i = keep - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`)
    } catch {}
  }
  // Move the active log to `.1`. The next appendFileSync recreates it.
  try {
    renameSync(path, `${path}.1`)
  } catch {}
}

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

// CLI 探测与 initialize 使用同一协议版本；升级时同步 schema 和 codex-shim。
// 主机可以用 CHA_CLAUDE_COMPAT_VERSION 显式覆盖报告版本。
const DEFAULT_CODEX_COMPAT_VERSION = CODEX_PROTOCOL_VERSION

export function codexCompatVersion(): string {
  return (
    process.env.CHA_CLAUDE_COMPAT_VERSION ||
    process.env.CODEX_SHIM_COMPAT_VERSION ||
    DEFAULT_CODEX_COMPAT_VERSION
  )
}

// Distinguishing tag appended after the (clean, probe-parseable) version so the
// Claude adapter is identifiable next to a real `codex` that now reports the
// same version. Set CHA_CLAUDE_VERSION_SUFFIX="" to disable and behave exactly
// like upstream codex.
const DEFAULT_VERSION_SUFFIX = 'codex-harness-adapter'

export function codexVersionSuffix(): string {
  return process.env.CHA_CLAUDE_VERSION_SUFFIX ?? DEFAULT_VERSION_SUFFIX
}

export function codexCliVersion(): string {
  return formatCliVersion(codexCompatVersion(), codexVersionSuffix())
}

export function codexUserAgent(clientName: string, clientVersion: string): string {
  return formatUserAgent(clientName, clientVersion, codexCompatVersion(), codexVersionSuffix())
}

const unavailableFileImagePrompt =
  '[图片内容不可用：当前运行时无法解析 fileId 附件。请勿推测图片内容；可继续处理正文。]'

export function textFromInput(input: unknown): string {
  if (!Array.isArray(input)) return ''
  return input
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const value = item as {
        type?: string
        text?: string
        path?: string
        name?: string
        url?: string
        fileId?: string
      }
      if (value.type === 'text') return value.text ?? ''
      if (value.type === 'mention') return `@${value.path ?? value.name ?? ''}`
      if (value.type === 'localImage') return `[local image: ${value.path ?? ''}]`
      if (value.type === 'image')
        return typeof value.url !== 'string' && typeof value.fileId === 'string'
          ? unavailableFileImagePrompt
          : '[image]'
      if (value.type === 'skill') return `/${value.name ?? 'skill'}`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

// Split UserInput[] into the text prompt + a list of image inputs ready to
// hand to Claude SDK as multimodal content blocks. localImage paths are read
// + base64 encoded (capped at 10 MiB to avoid OOM); image URLs pass through
// (data: URLs decode inline). Anything we can't read falls back to the same
// `[image]` text representation textFromInput uses, so the user still sees
// an indication in the prompt.
export interface ImageExtractResult {
  textPrompt: string
  images: ImageInput[]
}

export function extractImageInputs(input: unknown): ImageExtractResult {
  if (!Array.isArray(input)) return { textPrompt: '', images: [] }
  const texts: string[] = []
  const images: ImageInput[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as {
      type?: string
      text?: string
      path?: string
      name?: string
      url?: string
      fileId?: string
    }
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
    else if (item.type === 'mention') texts.push(`@${item.path ?? item.name ?? ''}`)
    else if (item.type === 'skill') texts.push(`/${item.name ?? 'skill'}`)
    else if (item.type === 'localImage' && typeof item.path === 'string') {
      const img = readLocalImage(item.path)
      if (img) images.push(img)
      else texts.push(`[local image unavailable: ${item.path}]`)
    } else if (item.type === 'image' && typeof item.url === 'string') {
      const img = parseImageUrl(item.url)
      if (img) images.push(img)
      else texts.push('[image]')
    } else if (item.type === 'image' && typeof item.fileId === 'string') {
      // fileId 是上游存储标识，不能当成本地路径或 URL，也不能静默丢掉图片。
      texts.push(unavailableFileImagePrompt)
    }
  }
  return { textPrompt: texts.filter(Boolean).join('\n'), images }
}

function readLocalImage(path: string): ImageInput | null {
  try {
    const stat = statSync(path)
    if (stat.size > 10 * 1024 * 1024) return null
    const buf = readFileSync(path)
    return {
      kind: 'base64',
      mediaType: sniffImageMediaType(path),
      data: buf.toString('base64'),
      displayPath: path,
    }
  } catch {
    return null
  }
}

function parseImageUrl(url: string): ImageInput | null {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)(?:;([^,]+))?,(.*)$/)
    if (!match) return null
    const mediaType = match[1] || 'application/octet-stream'
    const isBase64 = (match[2] ?? '').includes('base64')
    const payload = match[3] ?? ''
    return {
      kind: 'base64',
      mediaType,
      data: isBase64
        ? payload
        : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64'),
      displayPath: url.slice(0, 64) + (url.length > 64 ? '...' : ''),
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) {
    return { kind: 'url', mediaType: 'image/*', data: url, displayPath: url }
  }
  return null
}

function sniffImageMediaType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'image/png'
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function modelDisplayName(model: string): string {
  if (model === 'default') return 'Claude Default'
  if (model === 'sonnet') return 'Claude Sonnet'
  if (model === 'opus') return 'Claude Opus'
  if (model === 'fable') return 'Claude Fable'
  if (model === 'haiku') return 'Claude Haiku'
  if (model === 'sonnet-1m') return 'Claude Sonnet 1M'
  if (model === 'opus-plan') return 'Claude Opus Plan / Sonnet Execute'
  return model
}

function modelDescription(model: string): string {
  if (model === 'opus-plan' || model === 'claude-opus-plan' || model === 'opusplan') {
    return 'Uses Opus in plan mode and Sonnet for execution; selecting this model does not enable plan mode.'
  }
  return 'Claude Code runtime model'
}

function scanDiscoveredRouterModels(): Set<string> {
  const models = new Set<string>()
  models.add('sonnet')
  models.add('opus')
  models.add('fable')
  models.add('haiku')
  models.add('sonnet-1m')
  models.add('opus-plan')

  const cacheBase = join(homedir(), '.cache')
  if (existsSync(cacheBase)) {
    try {
      for (const sub of readdirSync(cacheBase)) {
        const routerDir = join(cacheBase, sub, 'claude-router')
        if (existsSync(routerDir)) {
          for (const item of readdirSync(routerDir)) {
            if (!item.startsWith('.')) models.add(item)
          }
        }
      }
    } catch {}
  }

  const extraRoots = (process.env.CLAUDE_CONFIG_DIRS || process.env.CLAUDE_ROUTER_DIR || '')
    .split(/[,:]/)
    .map((p) => p.trim())
    .filter(Boolean)
  for (const extra of extraRoots) {
    if (existsSync(extra)) {
      try {
        for (const item of readdirSync(extra)) {
          if (!item.startsWith('.')) models.add(item)
        }
      } catch {}
    }
  }
  return models
}

let cachedDiscoveredModels: { expiresAt: number; set: Set<string> } | null = null
function getDiscoveredRouterModelsCached(): Set<string> {
  const now = Date.now()
  if (cachedDiscoveredModels && cachedDiscoveredModels.expiresAt > now) {
    return cachedDiscoveredModels.set
  }
  const set = scanDiscoveredRouterModels()
  cachedDiscoveredModels = { expiresAt: now + 15_000, set }
  return set
}

const cachedCodexProxyModelOptions: { expiresAt: number; data: Array<any> } | null = null

// 仅用于显式配置的 CHA_CLAUDE_MODELS；默认目录取自原生 CLI。
export function claudeModelOptions(): Array<{
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
}> {
  const configured = process.env.CHA_CLAUDE_MODELS
  if (configured) {
    try {
      const parsed = JSON.parse(configured)
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => {
          if (typeof entry === 'string') return modelOption(entry)
          if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id : String(record.model ?? 'sonnet')
            return {
              id,
              sdkModel:
                typeof record.sdkModel === 'string' ? record.sdkModel : resolveClaudeModel(id),
              displayName:
                typeof record.displayName === 'string' ? record.displayName : modelDisplayName(id),
              description:
                typeof record.description === 'string' ? record.description : modelDescription(id),
              isDefault: record.isDefault === true,
            }
          }
          return modelOption('sonnet')
        })
      }
    } catch {}
    return configured
      .split(',')
      .map((part) => modelOption(part.trim()))
      .filter((entry) => entry.id.length > 0)
  }
  return []
}

export function resolveClaudeModel(
  model: string | null | undefined,
  purpose: 'normal' | 'summary' = 'normal',
): string | null {
  const raw = (model ?? '').trim()
  if (purpose === 'summary') {
    const summaryModel =
      process.env.CHA_CLAUDE_SUMMARY_MODEL || process.env.CHA_CLAUDE_TITLE_MODEL || 'haiku'
    if (isCodexOpenAiModel(raw) || !raw) return summaryModel
  }
  if (!raw || raw === 'default' || raw === 'claude-default')
    return process.env.CHA_CLAUDE_DEFAULT_MODEL || null
  if (raw === 'claude-code' || raw === 'custom') return process.env.CHA_CLAUDE_DEFAULT_MODEL || null
  const aliases: Record<string, string> = {
    'claude-sonnet': 'sonnet',
    'claude-opus': 'opus',
    'claude-fable': 'fable',
    'claude-haiku': 'haiku',
    'sonnet-1m': 'sonnet[1m]',
    'claude-sonnet-1m': 'sonnet[1m]',
    'opus-plan': 'opusplan',
    'claude-opus-plan': 'opusplan',
  }
  const envAliases = parseJsonObject(process.env.CHA_CLAUDE_MODEL_ALIASES)
  const mapped = typeof envAliases[raw] === 'string' ? envAliases[raw] : aliases[raw]
  if (mapped) return mapped
  // Case-insensitive match against configured models (e.g. GLM-5.3 -> glm-5.3)
  const configured = process.env.CHA_CLAUDE_MODELS
  if (configured) {
    const list = configured
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const matched = list.find((m) => m.toLowerCase() === raw.toLowerCase())
    if (matched) return matched
  }
  // Match case-insensitively against discovered router models
  const discoveredIds = getDiscoveredRouterModelsCached()
  for (const id of discoveredIds) {
    if (id.toLowerCase() === raw.toLowerCase()) return id
  }
  if (isNativeClaudeModel(raw)) return raw
  return process.env.CHA_CLAUDE_DEFAULT_MODEL || null
}

export function defaultAllowedTools(): string[] | null {
  const raw = process.env.CHA_CLAUDE_ALLOWED_TOOLS
  if (raw == null || raw.trim() === '') return null
  const value = raw.trim()
  if (value === '*' || value.toLowerCase() === 'default') return null
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function claudeOutputFormat(outputSchema: unknown): unknown | null {
  if (outputSchema == null) return null
  if (outputSchema && typeof outputSchema === 'object' && !Array.isArray(outputSchema)) {
    const record = outputSchema as Record<string, unknown>
    if (record.type === 'json_schema' && record.schema != null) return outputSchema
  }
  return { type: 'json_schema', schema: outputSchema }
}

export function normalizeCodexReasoningEffort(
  value: string | null | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value
  if (value === 'minimal') return 'low'
  return null
}

export function resolveClaudeEffort(
  value: string | null | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null {
  const raw = (value ?? '').trim()
  const envAliases = parseJsonObject(process.env.CHA_CLAUDE_EFFORT_ALIASES)
  const mapped = typeof envAliases[raw] === 'string' ? envAliases[raw] : raw
  if (
    mapped === 'low' ||
    mapped === 'medium' ||
    mapped === 'high' ||
    mapped === 'xhigh' ||
    mapped === 'max'
  )
    return mapped
  if (mapped === 'minimal') return 'low'
  return null
}

function modelOption(
  id: string,
  isDefault = false,
  description = modelDescription(id),
): {
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
} {
  return {
    id,
    sdkModel: resolveClaudeModel(id),
    displayName: modelDisplayName(id),
    description,
    isDefault,
  }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Determine if a model identifier should be routed to Claude Code runtime.
 * In modern proxy/gateway environments (such as custom LLM endpoints, local fine-tunes,
 * or non-Anthropic backend relays), arbitrary model identifiers (e.g. glm-*, ark-*, qwen-*)
 * can be served via Claude Code CLI. We allow any non-Codex-OpenAI model string to pass through.
 */
function isNativeClaudeModel(model: string): boolean {
  return !isCodexOpenAiModel(model)
}

export function isCodexOpenAiModel(model: string): boolean {
  return /^gpt[-_]/.test(model) || /^o[0-9]/.test(model) || model.startsWith('codex-')
}

// Models exposed in model/list when a real Codex CLI is available — picking
// any of these in the Codex App flips the new thread to runtimeBackend='codex'
// so turns get forwarded to the OpenAI Codex CLI instead of the Claude SDK.
// We only expose them when `resolveCodexBinary()` returns a real path; that
// way Mac/Linux installs without `codex` see only Claude models and the
// picker stays clean.
export function codexProxyModelOptions(): Array<{
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
}> {
  // Suppressed in mock / opt-out flows. Mock runtime tests assume a clean
  // Claude-only model list; environments without a real Codex shouldn't see
  // unusable picker entries.
  if (process.env.CHA_CLAUDE_MOCK === '1') return []
  if (process.env.CHA_CLAUDE_DISABLE_CODEX_PROXY === '1') return []
  if (!resolveCodexBinary()) return []
  const now = Date.now()
  if (cachedCodexProxyModelOptions && cachedCodexProxyModelOptions.expiresAt > now) {
    return cachedCodexProxyModelOptions.data
  }
  const env = process.env.CHA_CLAUDE_CODEX_MODELS
  let ids: string[] = []
  if (env && env.trim()) {
    ids = env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  } else {
    const catalogCandidates = [join(homedir(), '.codex/model_catalog.json')]
    for (const p of catalogCandidates) {
      if (existsSync(p)) {
        try {
          const cat = JSON.parse(readFileSync(p, 'utf8'))
          if (cat && Array.isArray(cat.models)) {
            ids = cat.models.map((m: any) => m.slug || m.id || m.model).filter(Boolean)
            break
          }
        } catch {}
      }
    }
    if (ids.length === 0) {
      ids = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']
    }
  }
  return ids.map((id) => ({
    id,
    sdkModel: id,
    displayName: `Codex · ${id}`,
    description: 'Real OpenAI Codex CLI (forwarded via `codex exec --json`).',
    isDefault: false,
  }))
}

// Resolve the real codex CLI binary — explicit CODEX_REAL wins; otherwise
// walk PATH for an entry that isn't this very script (to avoid recursion if
// our shim is also called `codex`). Returns null when nothing usable found.
export function resolveCodexBinary(): string | null {
  const explicit = process.env.CODEX_REAL
  if (explicit && explicit.trim()) return explicit.trim()
  const knownCandidates = [
    join(
      homedir(),
      '.local/node/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex.real',
    ),
  ]
  for (const c of knownCandidates) {
    if (existsSync(c)) return c
  }
  // PATH walk is mostly for dev — production deployments should set
  // CODEX_REAL explicitly in the shim env (~/.zshenv).
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean)

  for (const dir of paths) {
    const candidate = `${dir}/codex`
    try {
      const st = statSync(candidate)
      if (!st.isFile()) continue
      // Skip our shim — a hashbang + 'CLAUDE_CODEX' header is a strong
      // signal it's our codex-shim and would recurse.
      const head = readFileSync(candidate, { encoding: 'utf8' }).slice(0, 200)
      if (head.includes('CHA_CLAUDE_ADAPTER') || head.includes('codex-harness-adapter')) continue
      return candidate
    } catch {}
  }
  return null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]'
  if (typeof value === 'string')
    return value.length > 1200 ? value.slice(0, 1200) + '...[truncated]' : value
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 40).map((entry) => redact(entry, depth + 1))
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (/token|secret|password|api.?key|authorization|cookie/i.test(key)) {
      result[key] = '[redacted]'
    } else {
      result[key] = redact(entry, depth + 1)
    }
  }
  return result
}
