// 自定义 provider：<agent-dir>/models.json 的 providers（字段照 Pi 的 docs/models.md“Configure a compatible endpoint”）。
// 只有一个模板“兼容接口”：接口类型、地址、key、模型、请求头。写的时候只动模板里的字段，
// compat、modelOverrides、各模型的其余描述（上下文长度、价格之类）原样留着。
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  HarnessProviderTemplate,
  HarnessSettingSpec,
  HarnessSettingValue,
} from '../../protocol/src/harness-config.mjs'
import { fail, parseObject, t } from './harness-common.mjs'

const APIS = [
  ['openai-completions', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic-messages', 'Anthropic Messages'],
  ['google-generative-ai', 'Google Generative AI'],
  ['mistral-conversations', 'Mistral Conversations'],
] as const

const field = (spec: Omit<HarnessSettingSpec, 'group' | 'effect'>): HarnessSettingSpec => ({
  group: 'provider',
  effect: 'newSession',
  ...spec,
})

export function providerTemplates(): HarnessProviderTemplate[] {
  return [
    {
      id: 'compatible',
      title: t('兼容接口', 'Compatible endpoint'),
      description: t(
        'Ollama、LM Studio、vLLM、各种代理网关等，说 Pi 已支持的接口的服务',
        'Ollama, LM Studio, vLLM, proxy gateways and other servers that speak an API Pi supports',
      ),
      fields: [
        field({
          key: 'name',
          type: 'string',
          title: t('显示名', 'Display name'),
          description: null,
          default: null,
        }),
        field({
          key: 'api',
          type: 'enum',
          title: t('接口类型', 'API'),
          description: null,
          default: 'openai-completions',
          options: APIS.map(([value, title]) => ({ value, title: t(title, title) })),
        }),
        field({
          key: 'baseUrl',
          type: 'string',
          title: t('地址', 'Base URL'),
          description: null,
          default: null,
          placeholder: 'http://localhost:11434/v1',
        }),
        field({
          key: 'apiKey',
          type: 'secret',
          title: t('API key', 'API key'),
          description: t(
            '也可以写 $NAME 引用环境变量、!command 执行命令取值。服务不要 key 时随便填一个，模型才会出现',
            'Can also be $NAME for an environment variable or !command to run a command. Use any value when the server needs no key, so its models show up',
          ),
          default: null,
        }),
        field({
          key: 'models',
          type: 'stringList',
          title: t('模型', 'Models'),
          description: t('模型标识，一行一个', 'Model IDs, one per line'),
          default: null,
        }),
        field({
          key: 'headers',
          type: 'stringList',
          title: t('请求头', 'Headers'),
          description: t('一行一个，写成“名字: 值”', 'One per line, as "Name: value"'),
          default: null,
          clearable: true,
        }),
        field({
          key: 'authHeader',
          type: 'boolean',
          title: t('用 Authorization: Bearer 发 key', 'Send the key as Authorization: Bearer'),
          description: null,
          default: false,
        }),
      ],
    },
  ]
}

/** models.json 里的一项，按模板的字段给出；key 只说有没有 */
export function customDefinition(entry: Record<string, any>): Record<string, HarnessSettingValue> {
  const definition: Record<string, HarnessSettingValue> = {
    apiKey: { set: typeof entry.apiKey === 'string' && entry.apiKey !== '' },
    models: Array.isArray(entry.models)
      ? entry.models.map((model: any) => model?.id).filter((id: unknown) => typeof id === 'string')
      : [],
  }
  for (const key of ['name', 'api', 'baseUrl'] as const)
    if (typeof entry[key] === 'string') definition[key] = entry[key]
  if (entry.headers && typeof entry.headers === 'object')
    definition.headers = Object.entries(entry.headers).map(([name, value]) => `${name}: ${value}`)
  if (typeof entry.authHeader === 'boolean') definition.authHeader = entry.authHeader
  return definition
}

function invalid(key: string, zh: string, en: string): never {
  fail('invalidValue', `${key}：${zh}`, `${key}: ${en}`, key)
}

function text(
  definition: Record<string, unknown>,
  key: string,
  required: boolean,
): string | undefined {
  const value = definition[key]
  if (value === undefined || value === null || value === '') {
    if (required) invalid(key, '不能为空', 'is required')
    return undefined
  }
  if (typeof value !== 'string') invalid(key, '应当是字符串', 'must be a string')
  return value.trim()
}

function list(definition: Record<string, unknown>, key: string): string[] | undefined {
  const value = definition[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    invalid(key, '应当是一列字', 'must be a list of strings')
  return (value as string[]).map((item) => item.trim()).filter(Boolean)
}

/** 新增或修改 models.json 里的一个 provider。current 是读到的文件内容（版本已经对过） */
export async function writeCustomProvider(
  path: string,
  current: string | undefined,
  id: string,
  definition: Record<string, HarnessSettingValue>,
): Promise<void> {
  if (!definition || typeof definition !== 'object')
    invalid('definition', '应当是对象', 'must be an object')
  const config = parseObject(current, path)
  if (
    config.providers !== undefined &&
    (typeof config.providers !== 'object' || Array.isArray(config.providers))
  )
    fail('unavailable', `${path} 的 providers 应当是对象`, `providers in ${path} must be an object`)
  config.providers ??= {}
  const previous: Record<string, any> = config.providers[id] ?? {}
  const entry: Record<string, any> = { ...previous }
  const name = text(definition, 'name', false)
  if (name) entry.name = name
  else delete entry.name
  const api = text(definition, 'api', false) ?? previous.api ?? 'openai-completions'
  if (!APIS.some(([value]) => value === api)) invalid('api', `不认识 ${api}`, `unknown API ${api}`)
  entry.api = api
  const baseUrl = text(definition, 'baseUrl', true)!
  if (!URL.canParse(baseUrl)) invalid('baseUrl', '不是合法的地址', 'is not a valid URL')
  entry.baseUrl = baseUrl
  // 密钥不给表示不改，给空串是删掉
  if (typeof definition.apiKey === 'string') {
    if (definition.apiKey.trim()) entry.apiKey = definition.apiKey.trim()
    else delete entry.apiKey
  } else if (definition.apiKey !== undefined && !(typeof definition.apiKey === 'object'))
    invalid('apiKey', '应当是字符串', 'must be a string')
  const models = list(definition, 'models')
  if (!models?.length) invalid('models', '至少要有一个模型', 'needs at least one model')
  const known = new Map<string, any>(
    (Array.isArray(previous.models) ? previous.models : []).map((model: any) => [model?.id, model]),
  )
  entry.models = models.map((modelId) => known.get(modelId) ?? { id: modelId })
  const headers = list(definition, 'headers')
  if (headers !== undefined) {
    if (!headers.length) delete entry.headers
    else
      entry.headers = Object.fromEntries(
        headers.map((line) => {
          const colon = line.indexOf(':')
          if (colon < 1)
            invalid('headers', `“${line}”应当写成“名字: 值”`, `"${line}" must be "Name: value"`)
          return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
        }),
      )
  }
  if (typeof definition.authHeader === 'boolean') {
    if (definition.authHeader) entry.authHeader = true
    else delete entry.authHeader
  }
  config.providers[id] = entry
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}
