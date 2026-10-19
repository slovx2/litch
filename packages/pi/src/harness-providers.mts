// Pi 的账号与 provider。内置 provider 的登录走 SDK 的 ModelRuntime.login（OAuth 与 API key 都是），
// 凭据由它存进 Pi 的 auth.json；自定义 provider 是 models.json 里的 providers；当前在用的是 settings.json 的
// defaultProvider（切换时顺带换一个这家有的默认模型）。
import { writeFile } from 'node:fs/promises'
import { EXTENSION } from '../../protocol/src/device.mjs'
import type {
  HarnessAuthField,
  HarnessAuthMethod,
  HarnessAuthStartParams,
  HarnessAuthStartResponse,
  HarnessAuthStep,
  HarnessProvider,
  HarnessProviderAuthState,
  HarnessProviderIdParams,
  HarnessProvidersActivateParams,
  HarnessProvidersReadResponse,
  HarnessProvidersUpsertParams,
  HarnessProvidersWriteResponse,
} from '../../protocol/src/harness-config.mjs'
import { HARNESS_CONFIG_NOTIFICATION } from '../../protocol/src/harness-config.mjs'
import { AuthAttempt, attempt, failure, plain } from './harness-auth.mjs'
import {
  agentPath,
  changed,
  checkVersion,
  fail,
  HARNESS,
  hashOf,
  modelRuntime,
  parseObject,
  readText,
  t,
} from './harness-common.mjs'
import { customDefinition, providerTemplates, writeCustomProvider } from './harness-models.mjs'
import { defaultModelPerProvider, settingsStorage } from './pi-internals.mjs'
import { getAgentDir, ModelRuntime, SettingsManager } from './sdk.mjs'
import type { PiServer } from './server.mjs'

type Runtime = Awaited<ReturnType<typeof modelRuntime>>

// 走设备码的 OAuth（其余是浏览器授权，多半也能把回调地址粘贴回来）。只影响给人看的种类，实际的步骤跟着流程走
const DEVICE_CODE = new Set(['github-copilot', 'kimi-coding', 'meta', 'xai'])

const PROVIDER_ID = /^[A-Za-z0-9_-]+$/

async function files() {
  const settings = await readText(agentPath('settings.json'))
  const models = await readText(agentPath('models.json'))
  return { settings, models, version: hashOf(settings, models) }
}

/** 内置的 provider（不看 models.json），用来分哪些是用户加的 */
async function builtinIds(): Promise<Set<string>> {
  const runtime = await ModelRuntime.create({ authPath: agentPath('auth.json'), modelsPath: null })
  return new Set(runtime.getProviders().map((provider) => provider.id))
}

/** auth.json 里存的 key 给人看的样子：字面量只露末四位，命令写“命令” */
function storedLabel(stored: any): string | null {
  if (stored?.type !== 'api_key' || typeof stored.key !== 'string') return null
  if (stored.key.startsWith('!')) return '!command'
  return stored.key.length > 4 ? `…${stored.key.slice(-4)}` : '…'
}

function authState(runtime: Runtime, id: string, stored: any): HarnessProviderAuthState {
  const status = runtime.getProviderAuthStatus(id)
  if (!status.configured) return { signedIn: false, kind: 'none', label: null }
  if (runtime.isUsingOAuth(id))
    return {
      signedIn: true,
      kind: 'oauth',
      label: runtime.getProvider(id)?.auth.oauth?.name ?? null,
    }
  if (status.source === 'environment' || status.source === 'fallback')
    return { signedIn: true, kind: 'env', label: status.label ?? null }
  if (status.source === 'models_json_key' || status.source === 'models_json_command')
    return {
      signedIn: true,
      kind: 'apiKey',
      label: 'models.json',
      detail: t('key 写在 models.json 里', 'The key is in models.json'),
    }
  return { signedIn: true, kind: 'apiKey', label: storedLabel(stored) ?? status.label ?? null }
}

function methods(runtime: Runtime, id: string): HarnessAuthMethod[] {
  const auth = runtime.getProvider(id)?.auth
  const list: HarnessAuthMethod[] = []
  if (auth?.oauth) {
    const title = auth.oauth.loginLabel ?? auth.oauth.name
    list.push({
      id: 'oauth',
      kind: DEVICE_CODE.has(id) ? 'oauthDeviceCode' : 'oauthBrowser',
      title: plain(title),
      description: auth.oauth.isSubscription
        ? t('用订阅账号登录', 'Sign in with a subscription account')
        : null,
    })
  }
  if (auth?.apiKey?.login)
    list.push({
      id: 'api_key',
      kind: 'apiKey',
      title: plain(auth.apiKey.name),
      description: t(
        '存进 Pi 的 auth.json。还要别的信息（账号 ID 之类）时会接着问',
        "Saved in Pi's auth.json. Further details (account IDs and the like) are asked next if needed",
      ),
      fields: [{ id: 'key', title: t('API key', 'API key'), secret: true, optional: true }],
    })
  return list
}

export async function providersRead(): Promise<HarnessProvidersReadResponse> {
  const { settings, models, version } = await files()
  const active = parseObject(settings, agentPath('settings.json')).defaultProvider
  const custom = parseObject(models, agentPath('models.json')).providers ?? {}
  const builtins = await builtinIds()
  const stored = parseObject(await readText(agentPath('auth.json')), agentPath('auth.json'))
  const runtime = await modelRuntime()
  const credentials = new Set((await runtime.listCredentials()).map((item) => item.providerId))
  const providers = runtime.getProviders().map((provider): HarnessProvider => {
    const isCustom = !builtins.has(provider.id) && typeof custom[provider.id] === 'object'
    return {
      id: provider.id,
      title: plain(provider.name),
      kind: isCustom ? 'custom' : 'builtin',
      auth: authState(runtime, provider.id, stored[provider.id]),
      methods: methods(runtime, provider.id),
      active: provider.id === active,
      ...(isCustom
        ? { definition: customDefinition(custom[provider.id]), templateId: 'compatible' }
        : {}),
      canLogout: credentials.has(provider.id),
    }
  })
  return { providers, switchable: true, templates: providerTemplates(), version }
}

export async function providersUpsert(
  s: PiServer,
  p: HarnessProvidersUpsertParams,
): Promise<HarnessProvidersWriteResponse> {
  if (typeof p.providerId !== 'string' || !PROVIDER_ID.test(p.providerId))
    fail(
      'invalidValue',
      'provider 标识只能用字母、数字、- 和 _',
      'Provider IDs may only use letters, digits, - and _',
      'providerId',
    )
  if (p.templateId !== 'compatible')
    fail('notFound', `没有模板 ${p.templateId}`, `No template ${p.templateId}`, 'templateId')
  if ((await builtinIds()).has(p.providerId))
    fail(
      'invalidValue',
      `${p.providerId} 和内置的 provider 重名，换一个标识`,
      `${p.providerId} is a built-in provider; choose another ID`,
      'providerId',
    )
  const { models, version } = await files()
  checkVersion(p.expectedVersion, version)
  await writeCustomProvider(agentPath('models.json'), models, p.providerId, p.definition)
  changed(s, 'providers')
  return { version: (await files()).version, restartRequired: false }
}

export async function providersRemove(
  s: PiServer,
  p: HarnessProviderIdParams & { expectedVersion?: string },
): Promise<HarnessProvidersWriteResponse> {
  const { models, version } = await files()
  if (p.expectedVersion !== undefined) checkVersion(p.expectedVersion, version)
  const path = agentPath('models.json')
  const config = parseObject(models, path)
  if (
    typeof config.providers?.[p.providerId] !== 'object' ||
    (await builtinIds()).has(p.providerId)
  )
    fail('notFound', `没有自定义 provider ${p.providerId}`, `No custom provider ${p.providerId}`)
  delete config.providers[p.providerId]
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  changed(s, 'providers')
  return { version: (await files()).version, restartRequired: false }
}

/**
 * 把 id 设成当前在用的 provider：写 defaultProvider，默认模型这家没有时换成 Pi 给这家定的默认模型
 * （登录后 TUI 也是这么选的），再没有就用它的第一个模型。check 在持锁读到设置之后、改之前调
 */
async function setActive(
  id: string,
  runtime: Runtime,
  check?: (settings: string | undefined) => void,
): Promise<void> {
  const models = runtime.getModels(id)
  const preferredId = (await defaultModelPerProvider())[id]
  const storage = await settingsStorage(getAgentDir())
  const path = agentPath('settings.json')
  storage.withLock('global', (current) => {
    check?.(current)
    const settings = parseObject(current, path)
    settings.defaultProvider = id
    if (!models.some((model) => model.id === settings.defaultModel)) {
      const preferred = models.find((model) => model.id === preferredId) ?? models[0]
      if (preferred) settings.defaultModel = preferred.id
      else delete settings.defaultModel
    }
    return JSON.stringify(settings, null, 2)
  })
}

export async function providersActivate(
  s: PiServer,
  p: HarnessProvidersActivateParams,
): Promise<HarnessProvidersWriteResponse> {
  const runtime = await modelRuntime()
  if (!runtime.getProvider(p.providerId))
    fail('notFound', `没有 provider ${p.providerId}`, `No provider ${p.providerId}`)
  const { models } = await files()
  await setActive(p.providerId, runtime, (settings) =>
    checkVersion(p.expectedVersion, hashOf(settings, models)),
  )
  changed(s, 'providers')
  changed(s, 'config')
  return { version: (await files()).version, restartRequired: false }
}

/** Pi 登录流程里的一问，换成协议的字段 */
function field(prompt: {
  type: string
  message: string
  placeholder?: string
  options?: readonly { id: string; label: string; description?: string }[]
}): HarnessAuthField {
  const base = {
    title: plain(prompt.message),
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
  }
  switch (prompt.type) {
    case 'secret':
      return { id: 'value', secret: true, ...base }
    case 'manual_code':
      return { id: 'code', secret: false, ...base }
    case 'select':
      return {
        id: 'value',
        secret: false,
        ...base,
        options: (prompt.options ?? []).map((option) => ({
          value: option.id,
          title: plain(option.label),
          ...(option.description ? { description: plain(option.description) } : {}),
        })),
      }
    default:
      // 文字题有的可以留空（GitHub Copilot 的企业域名留空是 github.com），留不留空由流程自己判
      return { id: 'value', secret: false, optional: true, ...base }
  }
}

export async function authStart(
  s: PiServer,
  p: HarnessAuthStartParams,
): Promise<HarnessAuthStartResponse> {
  const runtime = await modelRuntime()
  if (!runtime.getProvider(p.providerId))
    fail('notFound', `没有 provider ${p.providerId}`, `No provider ${p.providerId}`)
  const method = methods(runtime, p.providerId).find((item) => item.id === p.methodId)
  if (!method)
    fail(
      'notFound',
      `${p.providerId} 没有登录方式 ${p.methodId}`,
      `${p.providerId} has no method ${p.methodId}`,
    )
  // API key 登录时先给了 key 的，流程问第一个密钥时直接交上去，不再单独问一次
  let prefill = method.kind === 'apiKey' ? p.inputs?.key?.trim() || undefined : undefined
  const login: AuthAttempt = new AuthAttempt((step) =>
    s.notifyExtension(EXTENSION.harnessConfig, HARNESS_CONFIG_NOTIFICATION.authUpdated, {
      harness: HARNESS,
      attemptId: login.id,
      providerId: p.providerId,
      step,
    }),
  )
  const first = login.next()
  // 有的流程要一个稳定的本机标识（ChatGPT 登录），和 TUI 一样存在设置里
  const settings = SettingsManager.create(getAgentDir(), getAgentDir())
  const run = async () => {
    await runtime.login(
      p.providerId,
      method.id === 'oauth' ? 'oauth' : 'api_key',
      {
        signal: login.signal,
        async prompt(prompt) {
          if (prompt.type === 'secret' && prefill !== undefined) {
            const value = prefill
            prefill = undefined
            return value
          }
          const asked = field(prompt)
          return (await login.ask([asked], prompt.message, prompt.signal))[asked.id]!
        },
        notify(event) {
          if (event.type === 'auth_url') login.openUrl(event.url, event.instructions)
          else if (event.type === 'device_code')
            login.deviceCode(event.verificationUri, event.userCode)
          else if (event.type === 'info')
            login.note([event.message, ...(event.links ?? []).map((link) => link.url)].join(' '))
          // progress（“正在换取令牌”之类）不单独成一步
        },
      },
      { getDeviceId: () => settings.getOrCreateDeviceId() },
    )
    await settings.flush()
    // 还没选过默认 provider 的，登录的这家就当默认（同 TUI 登录后选默认模型）
    const current = parseObject(
      await readText(agentPath('settings.json')),
      agentPath('settings.json'),
    )
    if (typeof current.defaultProvider !== 'string') {
      await setActive(p.providerId, runtime)
      changed(s, 'config')
    }
  }
  run().then(
    async () => {
      const stored = parseObject(await readText(agentPath('auth.json')), agentPath('auth.json'))
      login.finish({
        kind: 'done',
        auth: authState(await modelRuntime(), p.providerId, stored[p.providerId]),
      })
      changed(s, 'providers')
    },
    (error) => login.finish({ kind: 'failed', message: failure(error, login.signal) }),
  )
  return { attemptId: login.id, step: await first }
}

export async function authContinue(p: {
  attemptId: string
  inputs: Record<string, string>
}): Promise<HarnessAuthStep> {
  return attempt(p.attemptId).answer(p.inputs ?? {})
}

export function authCancel(p: { attemptId: string }): Record<string, never> {
  attempt(p.attemptId).cancel()
  return {}
}

export async function authLogout(
  s: PiServer,
  p: HarnessProviderIdParams,
): Promise<Record<string, never>> {
  const runtime = await modelRuntime()
  if (!runtime.getProvider(p.providerId))
    fail('notFound', `没有 provider ${p.providerId}`, `No provider ${p.providerId}`)
  // 只清 auth.json 里存的凭据；环境变量、models.json 里的 key 不动（同 /logout）
  await runtime.logout(p.providerId, { signal: AbortSignal.timeout(15_000) })
  changed(s, 'providers')
  return {}
}
