import { randomUUID } from 'node:crypto'
import type {
  HarnessAuthField,
  HarnessAuthMethod,
  HarnessAuthStartResponse,
  HarnessAuthStep,
  HarnessProvider,
  HarnessProviderAuthState,
  HarnessProvidersReadResponse,
  HarnessProvidersWriteResponse,
  HarnessProviderTemplate,
  HarnessSettingValue,
} from '../../protocol/src/harness-config.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import type { HarnessSettings } from './harness-settings.mjs'
import {
  type Attempt,
  conflict,
  invalid,
  notFound,
  opencodeMessage,
  text,
} from './harness-settings-shared.mjs'
import { editJsonc, parseJsonc, readAuth, readGlobalConfig, sha } from './native-config.mjs'

// 账号与 provider（litch/harness/providers/*、auth/*）。参考 OpenCode 官方桌面端的 provider 设置和连接对话框，
// 走 serve 的 v1 接口（1.18.33 实测可用；桌面端新版用的 /api/integration/* 在 serve 上列不出东西）：
// - 清单：GET /provider（全部、已连上的）；每家的登录方式：GET /provider/auth（插件提供的 OAuth 和带提示项的 API key）。
// - API key：PUT /auth/:id，存进 OpenCode 自己的 auth.json。断开：DELETE /auth/:id。
// - OAuth：POST /provider/:id/oauth/authorize 拿到授权链接和方式。method 为 auto 的（浏览器回调、设备码）
//   接着调 /oauth/callback 等它在 OpenCode 那边完成；为 code 的要用户把授权码贴回来，再交给 /oauth/callback。
// - 凭据改了之后收拾目录实例（POST /global/dispose），provider 的清单才会变；有回合在跑时等闲下来（HarnessSettings.dispose）。
// - 自定义 provider：OpenAI 兼容，字段照官方桌面端的表单（provider 号、名字、地址、key、模型、请求头），
//   写进全局配置的 provider.<id>，key 写进 auth.json，也可以写成 {env:变量名} 从环境变量取。
// OpenCode 按所选的模型决定用哪个 provider，没有“当前 provider”，switchable 为 false。

const OPENAI_COMPATIBLE = '@ai-sdk/openai-compatible'
const TEMPLATE_ID = 'openai-compatible'
const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
// 等浏览器回调、设备码轮询最多多久（OpenCode 那边自己也有超时）
const WAIT_MS = 15 * 60_000

const KEY_FIELD: HarnessAuthField = {
  id: 'key',
  title: text('API key', 'API key'),
  secret: true,
}
const CODE_FIELD: HarnessAuthField = {
  id: 'code',
  title: text('授权码', 'Authorization code'),
  secret: false,
}

const TEMPLATE: HarnessProviderTemplate = {
  id: TEMPLATE_ID,
  title: text('OpenAI 兼容', 'OpenAI compatible'),
  description: text(
    '接口照 OpenAI 的 Chat Completions 的服务（自建网关、各家的兼容接口）',
    'Services that follow OpenAI’s Chat Completions API (self-hosted gateways, compatible endpoints)',
  ),
  fields: [
    {
      key: 'name',
      group: 'provider',
      type: 'string',
      title: text('名字', 'Name'),
      description: null,
      default: null,
      effect: 'none',
      placeholder: 'My Gateway',
    },
    {
      key: 'baseURL',
      group: 'provider',
      type: 'string',
      title: text('地址', 'Base URL'),
      description: text('以 http:// 或 https:// 开头', 'Starts with http:// or https://'),
      default: null,
      effect: 'none',
      placeholder: 'https://api.example.com/v1',
    },
    {
      key: 'apiKey',
      group: 'provider',
      type: 'secret',
      title: text('API key', 'API key'),
      description: text(
        '存进 OpenCode 的 auth.json。也可以写 {env:变量名}，从环境变量取',
        'Stored in OpenCode’s auth.json. You can also write {env:NAME} to read it from an environment variable',
      ),
      default: null,
      effect: 'none',
      clearable: true,
    },
    {
      key: 'models',
      group: 'provider',
      type: 'stringList',
      title: text('模型', 'Models'),
      description: text(
        '一行一个模型号；要起名字写成“模型号=名字”',
        'One model ID per line; write “id=Name” to give it a name',
      ),
      default: [],
      effect: 'none',
    },
    {
      key: 'headers',
      group: 'provider',
      type: 'stringList',
      title: text('请求头', 'Headers'),
      description: text('一行一个，写成“名字: 值”', 'One per line, as “Name: value”'),
      default: [],
      effect: 'none',
      clearable: true,
    },
  ],
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const mask = (key: unknown) =>
  typeof key === 'string' && key.length >= 8 ? `…${key.slice(-4)}` : null

/** 配置里自己加的 OpenAI 兼容 provider（和官方桌面端认“自定义”的条件一样） */
function customProviders(merged: Record<string, any>): Record<string, any> {
  const all = isRecord(merged.provider) ? merged.provider : {}
  return Object.fromEntries(
    Object.entries(all).filter(
      ([, value]) =>
        isRecord(value) &&
        value.npm === OPENAI_COMPATIBLE &&
        isRecord(value.models) &&
        Object.keys(value.models).length > 0,
    ),
  )
}

/** OpenCode 给的提示项（text、select，带 when 条件的是可填可不填） */
function promptFields(prompts: any[] | undefined): HarnessAuthField[] {
  return (prompts ?? []).map((prompt) => ({
    id: String(prompt.key),
    title: text(String(prompt.message ?? prompt.key), String(prompt.message ?? prompt.key)),
    secret: false,
    ...(prompt.when ? { optional: true } : {}),
    ...(prompt.placeholder ? { placeholder: String(prompt.placeholder) } : {}),
    ...(prompt.type === 'select'
      ? {
          options: (prompt.options ?? []).map((option: any) => ({
            value: String(option.value),
            title: text(String(option.label), String(option.label)),
            ...(option.hint ? { description: text(String(option.hint), String(option.hint)) } : {}),
          })),
        }
      : {}),
  }))
}

// OpenCode 只说是 oauth，浏览器回调还是设备码要等授权那一步才知道。按名字猜一个，给客户端挑能用的方式参考
function oauthKind(providerId: string, label: string): HarnessAuthMethod['kind'] {
  return /headless|device/i.test(label) || providerId === 'github-copilot'
    ? 'oauthDeviceCode'
    : 'oauthBrowser'
}

function methodsFor(provider: any, listed: any[]): HarnessAuthMethod[] {
  const methods: HarnessAuthMethod[] = listed.map((method, index) => {
    const label = String(method.label ?? method.type)
    if (method.type === 'oauth')
      return {
        id: `oauth-${index}`,
        kind: oauthKind(String(provider.id), label),
        title: text(label, label),
        description: null,
      }
    return {
      id: `api-${index}`,
      kind: 'apiKey',
      title: text(label, label),
      description: null,
      fields: [KEY_FIELD, ...promptFields(method.prompts)],
    }
  })
  // 插件没列 API key 的，照官方桌面端也给一个：任何 provider 都能把 key 存进 auth.json
  if (!listed.some((method) => method.type === 'api'))
    methods.push({
      id: 'api',
      kind: 'apiKey',
      title: text('填 API key', 'Enter an API key'),
      description: null,
      fields: [KEY_FIELD],
    })
  for (const name of Array.isArray(provider.env) ? provider.env : [])
    methods.push({
      id: `env-${name}`,
      kind: 'env',
      title: text(`环境变量 ${name}`, `Environment variable ${name}`),
      description: text(
        'OpenCode 也认这个环境变量。写进 Litch 设备设置里 OpenCode 的环境变量，重启 OpenCode 后生效',
        'OpenCode also reads this variable. It is written to the OpenCode environment in Litch’s device settings and takes effect after OpenCode restarts',
      ),
      envName: String(name),
      effect: 'harness',
    })
  return methods
}

function authState(
  provider: any,
  connected: Set<string>,
  entries: Record<string, any>,
): HarnessProviderAuthState {
  const id = String(provider.id)
  const entry = entries[id]
  if (!connected.has(id))
    return {
      signedIn: false,
      kind: 'none',
      label: null,
      ...(entry
        ? {
            detail: text(
              '有凭据，但 OpenCode 没有加载它（可能被停用了）',
              'Credentials exist but OpenCode did not load the provider (it may be disabled)',
            ),
          }
        : {}),
    }
  if (entry?.type === 'oauth') return { signedIn: true, kind: 'oauth', label: null }
  if (entry?.type === 'api' || entry?.type === 'wellknown')
    return { signedIn: true, kind: 'apiKey', label: mask(entry.key) }
  if (provider.source === 'env')
    return {
      signedIn: true,
      kind: 'env',
      label: (provider.env ?? []).find((name: string) => process.env[name]) ?? null,
    }
  return { signedIn: true, kind: 'apiKey', label: null }
}

function definitionOf(config: any, entries: Record<string, any>, id: string) {
  const models = isRecord(config.models) ? config.models : {}
  const headers = isRecord(config.options?.headers) ? config.options.headers : {}
  return {
    name: String(config.name ?? id),
    baseURL: String(config.options?.baseURL ?? ''),
    apiKey: {
      set: Boolean(entries[id]?.key || config.options?.apiKey || config.env?.length),
    },
    models: Object.entries(models).map(([model, value]: [string, any]) =>
      value?.name && value.name !== model ? `${model}=${value.name}` : model,
    ),
    headers: Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  } satisfies Record<string, HarnessSettingValue>
}

async function listing(h: HarnessSettings) {
  const api = await h.server.api()
  const [list, methods] = await Promise.all([
    api.request('GET', '/provider', { timeoutMs: 30000 }),
    api.request('GET', '/provider/auth', { timeoutMs: 30000 }).catch(() => ({})),
  ])
  return { list: list ?? {}, methods: isRecord(methods) ? methods : {} }
}

function version(h: HarnessSettings): string {
  return sha(`${readGlobalConfig(h.paths).version}\n${readAuth(h.paths).text}`)
}

export async function providersRead(h: HarnessSettings): Promise<HarnessProvidersReadResponse> {
  await h.server.api()
  const snapshot = readGlobalConfig(h.paths)
  const { entries } = readAuth(h.paths)
  const { list, methods } = await listing(h)
  const connected = new Set<string>(list.connected ?? [])
  const custom = customProviders(snapshot.merged)
  const all: any[] = [...(list.all ?? [])]
  // 停用了的自定义 provider OpenCode 不列，从配置里补上，好让用户改或删
  for (const [id, config] of Object.entries(custom))
    if (!all.some((provider) => provider.id === id)) all.push({ id, name: config.name ?? id })
  const providers: HarnessProvider[] = all.map((provider) => {
    const id = String(provider.id)
    const name = String(provider.name ?? id)
    const config = custom[id]
    return {
      id,
      title: text(name, name),
      kind: config ? 'custom' : 'builtin',
      auth: authState(provider, connected, entries),
      methods: methodsFor(provider, Array.isArray(methods[id]) ? methods[id] : []),
      active: false,
      ...(config ? { definition: definitionOf(config, entries, id), templateId: TEMPLATE_ID } : {}),
      canLogout: Boolean(entries[id]),
    }
  })
  const rank = (provider: HarnessProvider) =>
    provider.auth.signedIn ? 0 : provider.kind === 'custom' ? 1 : 2
  providers.sort(
    (a, b) =>
      rank(a) - rank(b) || a.title.en.localeCompare(b.title.en, 'en', { sensitivity: 'base' }),
  )
  return {
    providers,
    switchable: false,
    templates: [TEMPLATE],
    version: sha(`${snapshot.version}\n${readAuth(h.paths).text}`),
  }
}

function lines(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw invalid(key, `${key} 应当是一列字`, `${key} must be a list of strings`)
  return value.map((item) => item.trim()).filter(Boolean)
}

export async function providersUpsert(
  h: HarnessSettings,
  p: any,
): Promise<HarnessProvidersWriteResponse> {
  const id = String(p.providerId ?? '').trim()
  if (!PROVIDER_ID.test(id))
    throw invalid(
      'providerId',
      'provider 号只能用小写字母、数字、- 和 _，并以字母或数字开头',
      'Provider ID may only contain lowercase letters, digits, - and _, and must start with a letter or digit',
    )
  if (p.templateId !== TEMPLATE_ID)
    throw notFound(`没有模板 ${p.templateId}`, `No template ${p.templateId}`)
  // serve 先起来（它读配置时会改文件，见 configRead）
  await h.server.api()
  if (p.expectedVersion !== version(h)) throw conflict()
  const definition = isRecord(p.definition) ? p.definition : {}
  await h.server.api()
  const snapshot = readGlobalConfig(h.paths)
  const existing = customProviders(snapshot.merged)[id]
  if (!existing) {
    const { list } = await listing(h)
    const disabled: string[] = snapshot.merged.disabled_providers ?? []
    if ((list.all ?? []).some((provider: any) => provider.id === id) && !disabled.includes(id))
      throw invalid('providerId', `已经有 provider ${id}`, `Provider ${id} already exists`)
  }
  const name = String(definition.name ?? existing?.name ?? '').trim()
  if (!name) throw invalid('name', '名字不能空着', 'Name is required')
  const baseURL = String(definition.baseURL ?? existing?.options?.baseURL ?? '').trim()
  if (!/^https?:\/\//.test(baseURL))
    throw invalid(
      'baseURL',
      '地址要以 http:// 或 https:// 开头',
      'Base URL must start with http:// or https://',
    )
  const modelLines =
    definition.models === undefined && existing
      ? definitionOf(existing, {}, id).models
      : lines(definition.models, 'models')
  if (!modelLines.length)
    throw invalid('models', '至少要有一个模型', 'At least one model is required')
  const models: Record<string, any> = {}
  for (const line of modelLines) {
    const at = line.indexOf('=')
    const model = (at < 0 ? line : line.slice(0, at)).trim()
    const label = (at < 0 ? line : line.slice(at + 1)).trim() || model
    if (!model || models[model])
      throw invalid(
        'models',
        `模型 ${model || '（空）'} 重复或没写模型号`,
        `Model ${model} is duplicated or empty`,
      )
    // 已有的模型保留用户在配置里给它写的别的设置（上下文长度之类）
    models[model] = {
      ...(isRecord(existing?.models?.[model]) ? existing.models[model] : {}),
      name: label,
    }
  }
  const headerLines =
    definition.headers === undefined && existing
      ? definitionOf(existing, {}, id).headers
      : lines(definition.headers, 'headers')
  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const at = line.indexOf(':')
    const header = at < 0 ? '' : line.slice(0, at).trim()
    const value = at < 0 ? '' : line.slice(at + 1).trim()
    if (!header || !value)
      throw invalid(
        'headers',
        `请求头“${line}”要写成“名字: 值”`,
        `Header “${line}” must be “Name: value”`,
      )
    headers[header] = value
  }
  // key：不给是不改；空串是清掉；{env:名字} 写进配置的 env，从环境变量取
  const rawKey = typeof definition.apiKey === 'string' ? definition.apiKey.trim() : undefined
  const env = rawKey?.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const { options: oldOptions = {}, env: oldEnv, ...rest } = isRecord(existing) ? existing : {}
  const next: Record<string, any> = {
    ...rest,
    npm: OPENAI_COMPATIBLE,
    name,
    options: {
      ...oldOptions,
      baseURL,
      ...(Object.keys(headers).length ? { headers } : {}),
    },
    models,
  }
  if (!Object.keys(headers).length) delete next.options.headers
  if (env) next.env = [env]
  else if (rawKey === undefined && oldEnv) next.env = oldEnv
  if (rawKey !== undefined) delete next.options.apiKey
  const api = await h.server.api()
  // key 先存，配置后写：配置一写 serve 就重读，那时 key 已经在了
  if (rawKey && !env)
    await api.request('PUT', `/auth/${encodeURIComponent(id)}`, {
      body: { type: 'api', key: rawKey },
      timeoutMs: 30000,
    })
  else if (rawKey !== undefined)
    await api
      .request('DELETE', `/auth/${encodeURIComponent(id)}`, { timeoutMs: 30000 })
      .catch(() => null)
  let source = editJsonc(snapshot.text, ['provider', id], next)
  const disabled: unknown = parseJsoncSafe(source).disabled_providers
  if (Array.isArray(disabled) && disabled.includes(id))
    source = editJsonc(
      source,
      ['disabled_providers'],
      disabled.filter((entry) => entry !== id),
    )
  const restartRequired = await h.commitConfig(
    snapshot.target,
    source,
    snapshot.files.some((file) => file.path === snapshot.target) ? snapshot.text : null,
  )
  if (source === snapshot.text && rawKey !== undefined) await h.dispose()
  h.changed('providers')
  h.changed('config')
  return { version: version(h), restartRequired }
}

function parseJsoncSafe(source: string): Record<string, any> {
  try {
    const value = parseJsonc(source || '{}', 'opencode.json')
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

export async function providersRemove(
  h: HarnessSettings,
  p: any,
): Promise<HarnessProvidersWriteResponse> {
  const id = String(p.providerId ?? '')
  await h.server.api()
  const snapshot = readGlobalConfig(h.paths)
  if (!customProviders(snapshot.merged)[id])
    throw notFound(`没有自定义 provider ${id}`, `No custom provider ${id}`)
  const api = await h.server.api()
  await api
    .request('DELETE', `/auth/${encodeURIComponent(id)}`, { timeoutMs: 30000 })
    .catch(() => null)
  let source = editJsonc(snapshot.text, ['provider', id], undefined)
  const disabled: unknown = parseJsoncSafe(source).disabled_providers
  if (Array.isArray(disabled) && disabled.includes(id)) {
    const rest = disabled.filter((entry) => entry !== id)
    source = editJsonc(source, ['disabled_providers'], rest.length ? rest : undefined)
  }
  const restartRequired = await h.commitConfig(snapshot.target, source, snapshot.text)
  h.changed('providers')
  h.changed('config')
  return { version: version(h), restartRequired }
}

// ---------- 登录 ----------

/** 授权链接里回调到本机的端口（redirect_uri 指向 localhost、127.0.0.1 的），远程设备上要转发它 */
export function callbackPort(url: string): number | null {
  try {
    const redirect = new URL(url).searchParams.get('redirect_uri')
    if (!redirect) return null
    const target = new URL(redirect)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return null
    return Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
  } catch {
    return null
  }
}

/** OpenCode 在说明里给的设备码（“Enter code: ABCD-1234”） */
export function deviceCode(instructions: string): string | null {
  return /code[:：]?\s*([A-Z0-9]{3,}(?:-[A-Z0-9]+)+|[A-Z0-9]{6,})/i.exec(instructions)?.[1] ?? null
}

const failed = (zh: string, en: string): HarnessAuthStep => ({
  kind: 'failed',
  message: text(zh, en),
})

function signedIn(h: HarnessSettings, providerId: string): HarnessProviderAuthState {
  const entry = readAuth(h.paths).entries[providerId]
  if (entry?.type === 'oauth') return { signedIn: true, kind: 'oauth', label: null }
  return { signedIn: true, kind: 'apiKey', label: mask(entry?.key) }
}

async function oauthMethods(h: HarnessSettings, providerId: string): Promise<any[]> {
  const { methods } = await listing(h)
  return Array.isArray(methods[providerId]) ? methods[providerId] : []
}

/** 带 when 条件、条件不成立的提示项不交给 OpenCode */
function applicable(prompts: any[] | undefined, inputs: Record<string, string>) {
  const out: Record<string, string> = {}
  for (const prompt of prompts ?? []) {
    const value = inputs[prompt.key]
    if (value === undefined || value === '') continue
    const when = prompt.when
    if (when && when.op === 'eq' && inputs[when.key] !== when.value) continue
    if (when && when.op === 'neq' && inputs[when.key] === when.value) continue
    out[prompt.key] = value
  }
  return out
}

/** 登录成功之后：收拾目录实例让 provider 加载上，告诉各连接 */
async function completed(h: HarnessSettings, providerId: string): Promise<HarnessAuthStep> {
  await h.dispose()
  h.changed('providers')
  return { kind: 'done', auth: signedIn(h, providerId) }
}

async function authorize(
  h: HarnessSettings,
  attempt: Attempt,
  method: any,
  inputs: Record<string, string>,
): Promise<HarnessAuthStep> {
  const api = await h.server.api()
  const providerId = attempt.providerId as string
  let result: any
  try {
    const given = applicable(method.prompts, inputs)
    result = await api.request(
      'POST',
      `/provider/${encodeURIComponent(providerId)}/oauth/authorize`,
      {
        body: { method: attempt.index, ...(Object.keys(given).length ? { inputs: given } : {}) },
        timeoutMs: 60000,
      },
    )
  } catch (error) {
    h.attempts.delete(attempt.id)
    return failed(
      `OpenCode 没能开始登录：${opencodeMessage(error)}`,
      `OpenCode could not start the sign-in: ${opencodeMessage(error)}`,
    )
  }
  if (!result?.url) {
    h.attempts.delete(attempt.id)
    return failed('OpenCode 没有给出授权链接', 'OpenCode returned no authorization URL')
  }
  const instructions = String(result.instructions ?? '')
  const message = instructions ? text(instructions, instructions) : null
  if (result.method === 'code') {
    attempt.stage = 'code'
    return {
      kind: 'openUrl',
      url: String(result.url),
      callbackPort: null,
      message,
      prompt: [CODE_FIELD],
    }
  }
  // auto：浏览器回调或设备码，OpenCode 那边自己等；/oauth/callback 一直挂到它完成
  attempt.stage = 'waiting'
  void wait(h, attempt)
  const code = deviceCode(instructions)
  if (code) return { kind: 'deviceCode', url: String(result.url), userCode: code, message }
  return {
    kind: 'openUrl',
    url: String(result.url),
    callbackPort: callbackPort(String(result.url)),
    message,
  }
}

async function wait(h: HarnessSettings, attempt: Attempt): Promise<void> {
  const providerId = attempt.providerId as string
  let step: HarnessAuthStep
  try {
    const api = await h.server.api()
    await api.request('POST', `/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
      body: { method: attempt.index },
      signal: attempt.abort.signal,
      timeoutMs: WAIT_MS,
    })
    step = await completed(h, providerId)
  } catch (error) {
    if (attempt.abort.signal.aborted) return
    step = failed(
      `登录没有完成：${opencodeMessage(error)}`,
      `Sign-in did not complete: ${opencodeMessage(error)}`,
    )
  } finally {
    h.attempts.delete(attempt.id)
  }
  h.authUpdated(attempt.id, step, { providerId })
}

export async function authStart(
  h: HarnessSettings,
  _peer: RpcPeer,
  p: any,
): Promise<HarnessAuthStartResponse> {
  const providerId = String(p.providerId ?? '')
  const methodId = String(p.methodId ?? '')
  const inputs: Record<string, string> = isRecord(p.inputs) ? p.inputs : {}
  const attemptId = randomUUID()
  const api = await h.server.api()
  if (methodId === 'api' || methodId.startsWith('api-')) {
    const key = String(inputs.key ?? '').trim()
    if (!key) throw invalid('key', 'API key 不能空着', 'API key is required')
    const { key: _, ...rest } = inputs
    const metadata = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => typeof value === 'string' && value.trim()),
    )
    await api.request('PUT', `/auth/${encodeURIComponent(providerId)}`, {
      body: { type: 'api', key, ...(Object.keys(metadata).length ? { metadata } : {}) },
      timeoutMs: 30000,
    })
    return { attemptId, step: await completed(h, providerId) }
  }
  if (methodId.startsWith('env-'))
    throw invalid(
      'methodId',
      '环境变量方式由客户端写进设备设置，不经这里',
      'Environment variables are written to the device settings by the client, not here',
    )
  const index = Number(/^oauth-(\d+)$/.exec(methodId)?.[1] ?? Number.NaN)
  const method = (await oauthMethods(h, providerId))[index]
  if (method?.type !== 'oauth')
    throw notFound(
      `${providerId} 没有登录方式 ${methodId}`,
      `${providerId} has no sign-in method ${methodId}`,
    )
  const attempt: Attempt = {
    id: attemptId,
    providerId,
    index,
    stage: 'inputs',
    abort: new AbortController(),
  }
  h.attempts.set(attemptId, attempt)
  // 有提示项（GitHub 企业版地址之类）又没给的，先问
  if (method.prompts?.length && !Object.keys(inputs).length)
    return {
      attemptId,
      step: { kind: 'prompt', fields: promptFields(method.prompts), message: null },
    }
  return { attemptId, step: await authorize(h, attempt, method, inputs) }
}

export async function authContinue(h: HarnessSettings, p: any): Promise<HarnessAuthStep> {
  const attempt = h.attempts.get(String(p.attemptId ?? ''))
  if (!attempt?.providerId)
    throw notFound('这次登录已经结束或不存在', 'This sign-in has ended or does not exist')
  const inputs: Record<string, string> = isRecord(p.inputs) ? p.inputs : {}
  if (attempt.stage === 'inputs') {
    const method = (await oauthMethods(h, attempt.providerId))[attempt.index as number]
    if (!method) {
      h.attempts.delete(attempt.id)
      return failed('这个登录方式已经没有了', 'This sign-in method is no longer available')
    }
    return authorize(h, attempt, method, inputs)
  }
  if (attempt.stage === 'waiting')
    throw invalid(
      'attemptId',
      '这次登录在等浏览器那边完成，不用再填什么',
      'This sign-in is waiting for the browser; nothing to enter',
    )
  const code = String(inputs.code ?? '').trim()
  if (!code) throw invalid('code', '授权码不能空着', 'Authorization code is required')
  try {
    const api = await h.server.api()
    await api.request(
      'POST',
      `/provider/${encodeURIComponent(attempt.providerId)}/oauth/callback`,
      { body: { method: attempt.index, code }, timeoutMs: 120000 },
    )
    return await completed(h, attempt.providerId)
  } catch (error) {
    return failed(
      `登录没有完成：${opencodeMessage(error)}`,
      `Sign-in did not complete: ${opencodeMessage(error)}`,
    )
  } finally {
    h.attempts.delete(attempt.id)
  }
}

export async function authCancel(h: HarnessSettings, p: any): Promise<Record<string, never>> {
  const attempt = h.attempts.get(String(p.attemptId ?? ''))
  // OpenCode 的 v1 接口没有取消登录：这边不再等，它那边挂着的到时自己作废
  attempt?.abort.abort()
  if (attempt) h.attempts.delete(attempt.id)
  return {}
}

export async function authLogout(h: HarnessSettings, p: any): Promise<Record<string, never>> {
  const providerId = String(p.providerId ?? '')
  if (!readAuth(h.paths).entries[providerId])
    throw notFound(`${providerId} 没有存着的凭据`, `No stored credentials for ${providerId}`)
  const api = await h.server.api()
  await api.request('DELETE', `/auth/${encodeURIComponent(providerId)}`, { timeoutMs: 30000 })
  await h.dispose()
  h.changed('providers')
  return {}
}
