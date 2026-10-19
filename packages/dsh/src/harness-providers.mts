// harness 详情设置里的 provider 与登录（litch/harness/providers/*、auth/*），照 dsh 官方设置页的“模型”那一页：
// - DeepSeek 官方接口（llm-deepseek）：API key 存在它的 apiKeyEnv 指的凭据上（默认 DEEPSEEK_API_KEY）；
// - DeepSeek 账号（deepseek-account）：浏览器登录，授权后回调到这台设备上 dsh 的 Web 入口（127.0.0.1），
//   凭据由 dsh 存在 $DSH_HOME/.credentials.yaml；
// - pi-ai 自带的第三方（llm-pi-ai 的 providers.<id>）：填 key 时照官方页的做法写一条 {apiKeyEnv: <ID>_API_KEY}，
//   key 存在那条凭据上；
// - 自定义网关：llm-pi-ai 里用户自己声明的 provider（地址、协议、模型），key 同上。
// “当前在用的 provider”就是 dsh 默认模型（agent-default-model）所属的那一家，切换时换成那一家的第一个模型。

import { randomUUID } from 'node:crypto'
import type {
  HarnessAuthStartResponse,
  HarnessAuthStep,
  HarnessProvider,
  HarnessProviderAuthState,
  HarnessProvidersReadResponse,
  HarnessProvidersWriteResponse,
  HarnessSettingValue,
} from '../../protocol/src/harness-config.mjs'
import {
  type CredentialInfo,
  derivedKeyRef,
  describeCredentials,
  describeSettings,
  fromRemote,
  HarnessConfigError,
  mutateSettings,
  type PathOp,
  type SettingsSnapshot,
  schemaEnum,
  text,
  valueAt,
  versionOf,
} from './harness-common.mjs'
import type { WebRemote } from './remote.mjs'

export const ACCOUNT = 'deepseek-account'
const PI_AI = 'llm-pi-ai'
const GATEWAY = 'gateway'
/** provider 的 id 同时是设置里的键和凭据名的词干：凭据名是 shell 变量名，不能数字打头（照官方页） */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** 官方页对 key 的要求：可见的 ASCII 字符 */
const LEGAL_KEY = /^[\x21-\x7E]+$/

interface Row {
  entry: {
    provider: string
    displayName?: string
    settingsNs: string
    settingsPath: string[]
    declared?: boolean
  }
  kind: 'account' | 'apiKey'
  custom: boolean
  /** apiKey：凭据名 */
  ref: string | null
  /** pi-ai：providers.<id> 现在生效的定义；没配过是 undefined */
  profile: any
}

interface Context {
  remote: WebRemote
  settings: SettingsSnapshot
  rows: Row[]
  account: any
  catalog: any
  credentials: Record<string, CredentialInfo>
}

async function load(remote: WebRemote): Promise<Context> {
  try {
    const [settings, configurable, account, catalog] = await Promise.all([
      describeSettings(remote),
      remote.rpc('llm/listConfigurableProviders', {}, Array.isArray),
      remote.rpc('account/getState', {}),
      remote.rpc('session/modelCatalog', {}),
    ])
    const rows: Row[] = []
    for (const entry of configurable as Row['entry'][]) {
      const view = settings.namespaces.get(entry.settingsNs)
      if (entry.provider === ACCOUNT) {
        rows.push({ entry, kind: 'account', custom: false, ref: null, profile: undefined })
        continue
      }
      if (!view) continue
      const profile = valueAt(view.value, entry.settingsPath)
      const named = profile?.apiKeyEnv
      const ref =
        typeof named === 'string' && named
          ? named
          : entry.settingsNs === PI_AI
            ? derivedKeyRef(entry.provider)
            : 'DEEPSEEK_API_KEY'
      rows.push({ entry, kind: 'apiKey', custom: entry.declared === true, ref, profile })
    }
    const refs = rows.flatMap((row) => (row.ref ? [row.ref] : []))
    return {
      remote,
      settings,
      rows,
      account,
      catalog,
      credentials: await describeCredentials(remote, refs),
    }
  } catch (error) {
    throw fromRemote(error)
  }
}

const version = (ctx: Context): string =>
  versionOf([
    ['llm-deepseek', PI_AI, 'agent-default-model'].map(
      (ns) => ctx.settings.namespaces.get(ns)?.revision ?? null,
    ),
    Object.entries(ctx.credentials).map(([ref, info]) => [ref, info.configured]),
    ctx.account?.status ?? null,
  ])

function checkVersion(ctx: Context, expected: string): void {
  if (version(ctx) !== expected)
    throw new HarnessConfigError(
      'versionConflict',
      text('provider 在读过之后被改了，请重读', 'Providers changed since they were read; reload'),
    )
}

function authOf(ctx: Context, row: Row): HarnessProviderAuthState {
  if (row.kind === 'account') {
    const phase = ctx.account?.attempt?.phase
    const signedIn = ctx.account?.status === 'credential-stored'
    return {
      signedIn,
      kind: signedIn ? 'oauth' : 'none',
      label: null,
      ...(!signedIn &&
      ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(phase)
        ? { detail: text('正在登录', 'Signing in') }
        : {}),
    }
  }
  const info = row.ref ? ctx.credentials[row.ref] : undefined
  // pi-ai 的 provider 要在设置里有一条定义才接得上，没有的话有 key 也用不了
  const usable =
    info?.configured === true && (row.entry.settingsNs !== PI_AI || row.profile !== undefined)
  return {
    signedIn: usable,
    kind: usable ? (info?.source === 'env' ? 'env' : 'apiKey') : 'none',
    label: usable ? row.ref : null,
    ...(info?.configured && !usable
      ? {
          detail: text(
            `有 ${row.ref}，填一次 key 就能用`,
            `${row.ref} exists; enter the key once to use it`,
          ),
        }
      : {}),
  }
}

const KEY_FIELD = { id: 'apiKey', title: text('API key', 'API key'), secret: true }

function titleOf(row: Row): string {
  if (row.entry.provider === ACCOUNT) return 'DeepSeek 账号'
  if (row.entry.provider === 'deepseek-official') return 'DeepSeek API'
  return String(row.profile?.displayName ?? row.entry.displayName ?? row.entry.provider)
}

function provider(ctx: Context, row: Row): HarnessProvider {
  const title = titleOf(row)
  const auth = authOf(ctx, row)
  const info = row.ref ? ctx.credentials[row.ref] : undefined
  const active = ctx.catalog?.default?.provider === row.entry.provider
  const shared: Omit<HarnessProvider, 'methods' | 'canLogout'> = {
    id: row.entry.provider,
    title:
      row.entry.provider === ACCOUNT
        ? text('DeepSeek 账号', 'DeepSeek account')
        : text(title, title),
    kind: row.custom ? 'custom' : 'builtin',
    auth,
    active,
  }
  if (row.kind === 'account')
    return {
      ...shared,
      methods: [
        {
          id: 'browser',
          kind: 'oauthBrowser',
          title: text('用 DeepSeek 账号登录', 'Sign in with a DeepSeek account'),
          description: text(
            '在浏览器里登录 DeepSeek 平台，授权后回到这台设备上的 dsh（127.0.0.1）',
            'Sign in to the DeepSeek platform in a browser; it then calls back to dsh on this device (127.0.0.1)',
          ),
        },
      ],
      canLogout: auth.signedIn,
    }
  return {
    ...shared,
    methods: [
      {
        id: 'apiKey',
        kind: 'apiKey',
        title: text('填 API key', 'Enter an API key'),
        description: text(
          `存在 dsh 的凭据 ${row.ref} 上`,
          `Stored as the dsh credential ${row.ref}`,
        ),
        fields: [KEY_FIELD],
      },
    ],
    canLogout: info?.configured === true && info.source === 'file' && info.writable,
    ...(row.custom
      ? {
          templateId: GATEWAY,
          definition: {
            displayName: String(row.profile?.displayName ?? ''),
            baseURL: String(row.profile?.baseURL ?? ''),
            api: String(row.profile?.api ?? ''),
            models: (row.profile?.models ?? []).map((model: any) => String(model?.id)),
            apiKey: { set: info?.configured === true },
          },
        }
      : {}),
  }
}

export async function readProviders(remote: WebRemote): Promise<HarnessProvidersReadResponse> {
  const ctx = await load(remote)
  const pi = ctx.settings.namespaces.get(PI_AI)
  const protocols = (pi && schemaEnum(pi.schema, ['providers', '*', 'api'])) ?? [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
  ]
  const field = (
    key: string,
    type: 'string' | 'enum' | 'stringList' | 'secret',
    zh: string,
    en: string,
    rest = {},
  ) => ({
    key,
    group: GATEWAY,
    type,
    title: text(zh, en),
    description: null,
    default: null,
    effect: 'none' as const,
    ...rest,
  })
  return {
    providers: ctx.rows.map((row) => provider(ctx, row)),
    switchable: true,
    templates: [
      {
        id: GATEWAY,
        title: text('自定义网关', 'Custom gateway'),
        description: text(
          'OpenAI 或 Anthropic 兼容的接口；provider 的 id 只能用小写字母、数字和 -，字母打头',
          'An OpenAI- or Anthropic-compatible endpoint; the provider id uses lowercase letters, digits and -, starting with a letter',
        ),
        fields: [
          field('displayName', 'string', '显示名', 'Display name'),
          field('baseURL', 'string', '接口地址', 'Endpoint', {
            placeholder: 'https://example.com/v1',
          }),
          field('api', 'enum', '协议', 'Protocol', {
            options: protocols.map((value) => ({ value, title: text(value, value) })),
          }),
          field('models', 'stringList', '模型', 'Models', {
            description: text('每行一个模型名', 'One model id per line'),
          }),
          field('apiKey', 'secret', 'API key', 'API key'),
        ],
      },
    ],
    version: version(ctx),
  }
}

function rowOf(ctx: Context, providerId: string): Row {
  const row = ctx.rows.find((one) => one.entry.provider === providerId)
  if (!row)
    throw new HarnessConfigError(
      'notFound',
      text(`没有 ${providerId} 这个 provider`, `No provider named ${providerId}`),
    )
  return row
}

const invalid = (zh: string, en: string, key?: string) =>
  new HarnessConfigError('invalidValue', text(zh, en), key)

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

async function storeKey(remote: WebRemote, ref: string, key: string): Promise<void> {
  if (!LEGAL_KEY.test(key))
    throw invalid(
      'API key 里有不能用的字符',
      'The API key contains characters that are not allowed',
      'apiKey',
    )
  await remote.rpc('credentials/set', { ref, value: key }).catch((error) => {
    throw fromRemote(error, 'apiKey')
  })
}

/** 新增或修改一个自定义网关：一次 settings/mutate 写 providers.<id>，key 另经 credentials/set 存在它的凭据名上 */
export async function upsertProvider(
  remote: WebRemote,
  providerId: string,
  templateId: string,
  definition: Record<string, HarnessSettingValue>,
  expectedVersion: string,
): Promise<HarnessProvidersWriteResponse> {
  const ctx = await load(remote)
  checkVersion(ctx, expectedVersion)
  if (templateId !== GATEWAY)
    throw new HarnessConfigError(
      'notFound',
      text(`没有 ${templateId} 这个模板`, `No template named ${templateId}`),
    )
  if (!ROUTE_PATTERN.test(providerId))
    throw invalid(
      'provider 的 id 只能用小写字母、数字和 -，字母打头',
      'The provider id must use lowercase letters, digits and -, starting with a letter',
      'providerId',
    )
  const existing = ctx.rows.find((row) => row.entry.provider === providerId)
  if (existing && !existing.custom)
    throw new HarnessConfigError(
      'readOnly',
      text(
        `${providerId} 是 dsh 自带的，不能当自定义网关改`,
        `${providerId} ships with dsh and cannot be edited as a custom gateway`,
      ),
      'providerId',
    )
  const view = ctx.settings.namespaces.get(PI_AI)
  if (!view)
    throw new HarnessConfigError(
      'unavailable',
      text(
        '这个 dsh 没有 llm-pi-ai，加不了自定义网关',
        'This dsh has no llm-pi-ai; custom gateways are unavailable',
      ),
    )
  const baseURL = String(definition.baseURL ?? '').trim()
  if (!isHttpUrl(baseURL))
    throw invalid('接口地址要是 http(s) 的网址', 'The endpoint must be an http(s) URL', 'baseURL')
  const protocols = schemaEnum(view.schema, ['providers', '*', 'api']) ?? []
  const api = String(definition.api ?? '')
  if (protocols.length && !protocols.includes(api))
    throw invalid(
      `协议只能是 ${protocols.join('、')}`,
      `The protocol must be one of ${protocols.join(', ')}`,
      'api',
    )
  const ids = Array.isArray(definition.models)
    ? definition.models.map((one) => String(one).trim()).filter(Boolean)
    : []
  if (!ids.length) throw invalid('至少填一个模型', 'Enter at least one model', 'models')
  const stored = valueAt(view.user, ['providers', providerId]) ?? {}
  // 已有的模型保留它别的字段（上下文长度之类），只按 id 增删
  const models = ids.map(
    (id) => (stored.models ?? []).find((model: any) => model?.id === id) ?? { id },
  )
  const key = typeof definition.apiKey === 'string' ? definition.apiKey.trim() : ''
  const ref =
    typeof stored.apiKeyEnv === 'string' && stored.apiKeyEnv
      ? stored.apiKeyEnv
      : derivedKeyRef(providerId)
  const path = ['providers', providerId]
  const displayName = String(definition.displayName ?? '').trim()
  const ops: PathOp[] = [
    displayName
      ? { op: 'set', path: [...path, 'displayName'], value: displayName }
      : { op: 'unset', path: [...path, 'displayName'] },
    { op: 'set', path: [...path, 'baseURL'], value: baseURL },
    { op: 'set', path: [...path, 'api'], value: api },
    { op: 'set', path: [...path, 'models'], value: models },
    ...(key && !stored.apiKeyEnv
      ? [{ op: 'set' as const, path: [...path, 'apiKeyEnv'], value: ref }]
      : []),
  ]
  await mutateSettings(remote, PI_AI, ops, view.revision)
  if (key) await storeKey(remote, ref, key)
  return { version: version(await load(remote)), restartRequired: false }
}

/** 删掉一个自定义网关：先清它的凭据（只清照官方页派生出来的那条），再删定义 */
export async function removeProvider(
  remote: WebRemote,
  providerId: string,
): Promise<HarnessProvidersWriteResponse> {
  const ctx = await load(remote)
  const row = rowOf(ctx, providerId)
  if (!row.custom)
    throw new HarnessConfigError(
      'readOnly',
      text('只能删自定义网关', 'Only custom gateways can be removed'),
    )
  const info = row.ref ? ctx.credentials[row.ref] : undefined
  if (
    row.ref === derivedKeyRef(providerId) &&
    info?.configured &&
    info.source === 'file' &&
    info.writable
  )
    await remote.rpc('credentials/unset', { ref: row.ref }).catch((error) => {
      throw fromRemote(error)
    })
  await mutateSettings(remote, PI_AI, [{ op: 'unset', path: ['providers', providerId] }], undefined)
  return { version: version(await load(remote)), restartRequired: false }
}

/** 切换在用的 provider：默认模型换成这一家的第一个模型（已经是这一家的不动） */
export async function activateProvider(
  remote: WebRemote,
  providerId: string,
  expectedVersion: string,
): Promise<HarnessProvidersWriteResponse> {
  const ctx = await load(remote)
  checkVersion(ctx, expectedVersion)
  rowOf(ctx, providerId)
  if (ctx.catalog?.default?.provider !== providerId) {
    const group = (ctx.catalog?.groups ?? []).find((one: any) => one.id === providerId)
    const model = group?.models?.[0]?.id
    if (!model)
      throw invalid(
        '这个 provider 还没有能用的模型：先登录或填 key',
        'This provider has no usable model yet: sign in or enter a key first',
      )
    const defaults = ctx.settings.namespaces.get('agent-default-model')
    await mutateSettings(
      remote,
      'agent-default-model',
      [
        { op: 'set', path: ['provider'], value: providerId },
        { op: 'set', path: ['model'], value: model },
        { op: 'unset', path: ['reasoningEffort'] },
      ],
      defaults?.revision,
    )
  }
  return { version: version(await load(remote)), restartRequired: false }
}

/** 填 key：pi-ai 的 provider 先照官方页写上 apiKeyEnv（没配过的连定义一起建），再存 key */
export async function setApiKey(
  remote: WebRemote,
  providerId: string,
  key: string,
): Promise<HarnessProviderAuthState> {
  const ctx = await load(remote)
  const row = rowOf(ctx, providerId)
  if (row.kind !== 'apiKey' || !row.ref)
    throw new HarnessConfigError(
      'notFound',
      text('这个 provider 不用 API key', 'This provider does not take an API key'),
    )
  if (!key.trim()) throw invalid('API key 不能是空的', 'The API key cannot be empty', 'apiKey')
  if (row.entry.settingsNs === PI_AI && !row.profile?.apiKeyEnv) {
    const view = ctx.settings.namespaces.get(PI_AI)
    await mutateSettings(
      remote,
      PI_AI,
      [{ op: 'set', path: [...row.entry.settingsPath, 'apiKeyEnv'], value: row.ref }],
      view?.revision,
    )
  }
  await storeKey(remote, row.ref, key.trim())
  const after = await load(remote)
  return authOf(after, rowOf(after, providerId))
}

/** 登出：DeepSeek 账号走 account/signOut，别的清掉凭据 */
export async function logout(remote: WebRemote, providerId: string): Promise<void> {
  const ctx = await load(remote)
  const row = rowOf(ctx, providerId)
  try {
    if (row.kind === 'account')
      await remote.rpc('account/signOut', { client: clientMetadata(remote) })
    else if (row.ref) {
      const info = ctx.credentials[row.ref]
      if (info?.source === 'env')
        throw new HarnessConfigError(
          'readOnly',
          text(
            `${row.ref} 来自环境变量，在这里清不掉`,
            `${row.ref} comes from an environment variable and cannot be cleared here`,
          ),
        )
      await remote.rpc('credentials/unset', { ref: row.ref })
    }
  } catch (error) {
    throw fromRemote(error)
  }
}

/** account/* 要的界面信息：dsh 拿它算平台请求头 */
export const clientMetadata = (remote: WebRemote) => ({
  version: remote.version,
  locale: Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN',
  timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
})

const ACCOUNT_FAILURE: Record<string, [string, string]> = {
  cancelled: ['登录取消了', 'Sign-in was cancelled'],
  expired: ['登录超时了，再试一次', 'Sign-in timed out; try again'],
  failed: ['登录没成功', 'Sign-in failed'],
}

/** 账号状态 → 登录的一步；还在等的中间状态是 null */
function accountStep(view: any, attemptId: string, port: number): HarnessAuthStep | null {
  const attempt = view?.attempt
  if (!attempt || attempt.id !== attemptId) return null
  if (attempt.phase === 'waiting-browser' && attempt.authorizeUrl)
    return {
      kind: 'openUrl',
      url: attempt.authorizeUrl,
      callbackPort: port,
      message: text(
        '在浏览器里登录 DeepSeek，授权后会回到这台设备上的 dsh',
        'Sign in to DeepSeek in the browser; it then returns to dsh on this device',
      ),
    }
  if (attempt.phase === 'succeeded')
    return { kind: 'done', auth: { signedIn: true, kind: 'oauth', label: null } }
  const failure = ACCOUNT_FAILURE[attempt.phase]
  if (failure) {
    const reason = attempt.errorCode ? `（${attempt.errorCode}）` : ''
    return { kind: 'failed', message: text(`${failure[0]}${reason}`, `${failure[1]}${reason}`) }
  }
  return null
}

/**
 * DeepSeek 账号登录：account/startSignIn 的回调地址是 dsh 的 Web 入口（只认 127.0.0.1 加端口），
 * 授权链接随后经 account/watch 到。应答等到授权链接（或失败）才回；之后的进展经 onStep 送出。
 * 返回取消跟随的函数。
 */
export async function startAccountSignIn(
  remote: WebRemote,
  onStep: (attemptId: string, step: HarnessAuthStep) => void,
): Promise<{ response: HarnessAuthStartResponse; stop: () => void }> {
  const started = await remote
    .rpc('account/startSignIn', {
      client: clientMetadata(remote),
      callbackOrigin: `http://127.0.0.1:${remote.port}`,
      loginSource: 'web',
    })
    .catch((error) => {
      throw fromRemote(error)
    })
  const attemptId: string | undefined = started?.attempt?.id
  if (!attemptId)
    throw new HarnessConfigError(
      'authFailed',
      text('dsh 没有开始登录', 'dsh did not start a sign-in'),
    )
  let settle: (step: HarnessAuthStep) => void = () => {}
  const first = new Promise<HarnessAuthStep>((resolve) => {
    settle = resolve
  })
  let answered = false
  let last = ''
  const stop = remote.open(
    'account/watch',
    {},
    (view) => {
      const step = accountStep(view, attemptId, remote.port)
      if (!step || JSON.stringify(step) === last) return
      last = JSON.stringify(step)
      if (!answered) {
        answered = true
        settle(step)
      } else onStep(attemptId, step)
      if (step.kind === 'done' || step.kind === 'failed') stop()
    },
    (error) => {
      if (!answered) {
        answered = true
        settle({
          kind: 'failed',
          message: text(
            `登录中断了：${error?.message ?? '连接断了'}`,
            `Sign-in stopped: ${error?.message ?? 'connection lost'}`,
          ),
        })
      }
    },
  )
  const timer = setTimeout(() => {
    if (answered) return
    answered = true
    settle({
      kind: 'failed',
      message: text(
        '等不到 DeepSeek 的授权链接（连不上平台？）',
        'No authorization link from DeepSeek (platform unreachable?)',
      ),
    })
  }, 30000)
  const step = await first
  clearTimeout(timer)
  if (step.kind === 'failed') stop()
  return { response: { attemptId, step }, stop }
}

export const newAttemptId = (): string => randomUUID()
