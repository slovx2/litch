// harness 详情设置里不靠浏览器就能测的那几样（packages/ui/test/hconfig.test.mjs 直接引这个文件）：
// 草稿怎么从控件里来、保存前怎么变成要写的值、一个值怎么写成一小段字、MCP 表单和对面的形状怎么互换、
// 统一模式会覆盖哪些文件。只用可擦除的语法，只类型引用核心。
import type {
  HcAuthMethod,
  HcEffect,
  HcInstructionsView,
  HcMcpServer,
  HcMcpTransport,
  HcSettingSpec,
  HcValue,
  InstructionsOverview,
} from '@litch/core'

/** 这一版会画的类型；别的按只读摆出来 */
export const HC_TYPES: readonly string[] = [
  'boolean',
  'integer',
  'number',
  'string',
  'text',
  'enum',
  'stringList',
  'path',
  'secret',
  'json',
]

/**
 * 一栏的草稿：控件里现在是什么。开关是真假，别的都是输入框里的原字（数、列表、JSON 保存时才解析）；
 * clear 是“恢复默认”（删掉这个键）
 */
export type HcDraft = { kind: 'value'; value: boolean | string } | { kind: 'clear' }

/** 草稿 → 要写的值。不合规矩的给出哪一句 */
export type Parsed =
  | { ok: true; value: HcValue | null }
  | {
      ok: false
      problem: 'hc.bad.number' | 'hc.bad.integer' | 'hc.bad.range' | 'hc.bad.json' | 'hc.bad.empty'
    }

export function parseDraft(spec: HcSettingSpec, draft: HcDraft): Parsed {
  if (draft.kind === 'clear') return { ok: true, value: null }
  const { value } = draft
  if (spec.type === 'boolean') return { ok: true, value: value === true }
  const text = String(value)
  if (spec.type === 'integer' || spec.type === 'number') {
    const trimmed = text.trim()
    if (trimmed === '') return { ok: true, value: null }
    const number = Number(trimmed)
    if (!Number.isFinite(number)) return { ok: false, problem: 'hc.bad.number' }
    if (spec.type === 'integer' && !Number.isInteger(number))
      return { ok: false, problem: 'hc.bad.integer' }
    if (
      (spec.minimum !== null && number < spec.minimum) ||
      (spec.maximum !== null && number > spec.maximum)
    ) {
      return { ok: false, problem: 'hc.bad.range' }
    }
    return { ok: true, value: number }
  }
  if (spec.type === 'stringList') return { ok: true, value: linesOf(text) }
  if (spec.type === 'json') {
    if (text.trim() === '') return { ok: true, value: null }
    try {
      return { ok: true, value: JSON.parse(text) as HcValue }
    } catch {
      return { ok: false, problem: 'hc.bad.json' }
    }
  }
  if (spec.type === 'secret' && text === '') return { ok: false, problem: 'hc.bad.empty' }
  return { ok: true, value: text }
}

/** 一行一项：去掉两头的空白，空行不要 */
export const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

/** 存着的值放进控件时的原字（草稿就从它开始改） */
export function rawOf(spec: HcSettingSpec, value: HcValue | null | undefined): boolean | string {
  if (spec.type === 'boolean') return value === true
  if (value === null || value === undefined) return ''
  if (spec.type === 'stringList') return Array.isArray(value) ? value.map(String).join('\n') : ''
  if (spec.type === 'json') return JSON.stringify(value, null, 2)
  if (spec.type === 'secret') return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 密钥读到的是 {set}：设没设过 */
export const secretSet = (value: HcValue | null | undefined): boolean =>
  typeof value === 'object' && value !== null && (value as { set?: unknown }).set === true

/** 草稿和存着的一样（改回去了）：这一栏不算改过 */
export function sameAsStored(
  spec: HcSettingSpec,
  draft: HcDraft,
  stored: HcValue | undefined,
): boolean {
  if (draft.kind === 'clear') return stored === undefined
  if (spec.type === 'secret') return false
  const parsed = parseDraft(spec, draft)
  if (!parsed.ok) return false
  const now = stored === undefined ? null : stored
  return JSON.stringify(parsed.value) === JSON.stringify(now)
}

/** 型号清单的一行（`id` 或 `id = 显示名`）里的型号 ID */
export const modelLineId = (line: string): string => line.split('=')[0]?.trim() ?? ''

/**
 * 从 provider 拉来的型号勾选完，并回清单：拉来的里勾掉的去掉，勾上而清单里没有的加在末尾
 * （有显示名写成 `id = 显示名`），清单里别的行原样留着
 */
export function mergeDiscovered(
  current: readonly string[],
  found: readonly { id: string; title: string | null }[],
  picked: ReadonlySet<string>,
): string[] {
  const foundIds = new Set(found.map((model) => model.id))
  const kept = current.filter((line) => {
    const id = modelLineId(line)
    return !foundIds.has(id) || picked.has(id)
  })
  const have = new Set(kept.map(modelLineId))
  const added = found
    .filter((model) => picked.has(model.id) && !have.has(model.id))
    .map((model) =>
      model.title && model.title !== model.id ? `${model.id} = ${model.title}` : model.id,
    )
  return [...kept, ...added]
}

/** 改了之后怎么生效：给人看的那一句的键。立刻生效的没有 */
export const effectKey = (effect: HcEffect): 'hc.effect.newSession' | 'hc.effect.harness' | null =>
  effect === 'newSession'
    ? 'hc.effect.newSession'
    : effect === 'harness'
      ? 'hc.effect.harness'
      : null

/** 这种登录方式界面会不会走（对面以后加的种类不给入口） */
export const KNOWN_AUTH: readonly string[] = [
  'oauthBrowser',
  'oauthDeviceCode',
  'oauthPaste',
  'apiKey',
  'env',
]
export const usableMethods = (methods: readonly HcAuthMethod[]): HcAuthMethod[] =>
  methods.filter((method) => KNOWN_AUTH.includes(method.kind))

// ---------- MCP 表单 ----------

/** MCP 表单里的样子：参数、环境变量、请求头都是一行一项的原字，保存时才拆 */
export interface McpForm {
  name: string
  transport: HcMcpTransport
  enabled: boolean
  command: string
  /** 一行一个参数 */
  args: string
  cwd: string
  url: string
  bearerTokenEnvVar: string
  /** 一行一个 NAME=VALUE；密钥另记 */
  env: { name: string; value: string; secret: boolean; kept: boolean }[]
  /** 一行一个 Name: value */
  headers: string
  extra: Record<string, HcValue>
}

export function formOf(server: HcMcpServer | null, transports: readonly HcMcpTransport[]): McpForm {
  if (!server) {
    return {
      name: '',
      transport: transports[0] ?? 'stdio',
      enabled: true,
      command: '',
      args: '',
      cwd: '',
      url: '',
      bearerTokenEnvVar: '',
      env: [],
      headers: '',
      extra: {},
    }
  }
  return {
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    command: server.command ?? '',
    args: server.args.join('\n'),
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    bearerTokenEnvVar: server.bearerTokenEnvVar ?? '',
    env: Object.entries(server.env).map(([name, value]) => {
      const secret = server.secretKeys.includes(name)
      // 密钥读到的是空串：表示“原来的留着”，界面上写“已设置”
      return { name, value: secret ? '' : value, secret, kept: secret }
    }),
    headers: Object.entries(server.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n'),
    extra: { ...server.extra },
  }
}

export type McpProblem =
  | 'hc.mcp.bad.name'
  | 'hc.mcp.bad.command'
  | 'hc.mcp.bad.url'
  | 'hc.mcp.bad.env'

/** 表单 → 交给核心的服务。密钥没改的不带值（不出现在 env 里），名字仍在 secretKeys 里 */
export function serverOf(
  form: McpForm,
): { ok: true; server: HcMcpServer } | { ok: false; problem: McpProblem } {
  const name = form.name.trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return { ok: false, problem: 'hc.mcp.bad.name' }
  const remote = form.transport !== 'stdio'
  if (!remote && !form.command.trim()) return { ok: false, problem: 'hc.mcp.bad.command' }
  if (remote && !/^https?:\/\/\S+$/i.test(form.url.trim()))
    return { ok: false, problem: 'hc.mcp.bad.url' }
  const env: Record<string, string> = {}
  const secretKeys: string[] = []
  for (const entry of form.env) {
    const key = entry.name.trim()
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, problem: 'hc.mcp.bad.env' }
    if (entry.secret) {
      secretKeys.push(key)
      // 没填新值的密钥：不带，对面保留原来的
      if (entry.value !== '' || !entry.kept) env[key] = entry.value
    } else env[key] = entry.value
  }
  const headers: Record<string, string> = {}
  for (const line of linesOf(form.headers)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return {
    ok: true,
    server: {
      name,
      transport: form.transport,
      enabled: form.enabled,
      command: remote ? null : form.command.trim(),
      args: remote ? [] : linesOf(form.args),
      cwd: remote || !form.cwd.trim() ? null : form.cwd.trim(),
      env,
      secretKeys,
      url: remote ? form.url.trim() : null,
      headers: remote ? headers : {},
      bearerTokenEnvVar:
        remote && form.bearerTokenEnvVar.trim() ? form.bearerTokenEnvVar.trim() : null,
      extra: form.extra,
      status: null,
    },
  }
}

// ---------- 统一模式 ----------

/** 选了 source 这个 harness 作底稿统一时，哪些文件会被换掉：已经存在、又不是已经指向它的那些 */
export function overwrittenBy(
  overview: InstructionsOverview,
  source: string,
): HcInstructionsView[] {
  const base = overview.entries.find((entry) => entry.harness === source)?.info
  if (!base) return []
  return overview.entries.flatMap((entry) =>
    entry.harness !== source &&
    entry.info &&
    entry.info.path !== base.path &&
    entry.info.exists &&
    entry.info.linkTarget !== base.path
      ? [entry.info]
      : [],
  )
}
