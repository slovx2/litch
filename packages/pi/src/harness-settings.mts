// Pi 的配置项：读写 <agent-dir>/settings.json（用户层），认不出的键原样留着。
// 范围照设计 2.4 节：默认模型与思考、网络与重试、上下文压缩、技能与扩展的启停；TUI 的项（主题、全屏、
// 终端、快捷键）不做。Litch 自己的审批开关在设备设置（harness.pi.approvals）里，这里不重复列。
import { basename, dirname, relative } from 'node:path'
import type {
  HarnessConfigEdit,
  HarnessConfigReadResponse,
  HarnessConfigWriteParams,
  HarnessConfigWriteResponse,
  HarnessSettingGroup,
  HarnessSettingSpec,
  HarnessSettingValue,
} from '../../protocol/src/harness-config.mjs'
import {
  agentPath,
  changed,
  checkVersion,
  fail,
  hashOf,
  modelRuntime,
  parseObject,
  readText,
  t,
} from './harness-common.mjs'
import { environmentProxy } from './http-proxy.mjs'
import { settingsStorage } from './pi-internals.mjs'
import { builtInExtensions, DefaultPackageManager, getAgentDir, SettingsManager } from './sdk.mjs'
import type { PiServer } from './server.mjs'

const GROUPS: HarnessSettingGroup[] = [
  { id: 'defaults', title: t('默认模型与思考', 'Default model and thinking'), description: null },
  {
    id: 'network',
    title: t('网络与重试', 'Network and retries'),
    description: t(
      '请求失败时自动重试；代理只对 Pi 自己发出的请求生效',
      'Automatic retries on failure; the proxy applies to requests Pi makes itself',
    ),
  },
  {
    id: 'behavior',
    title: t('上下文压缩', 'Context compaction'),
    description: t(
      '上下文快满时把较早的对话总结成摘要',
      'Summarize older conversation when the context is nearly full',
    ),
  },
  {
    id: 'tools',
    title: t('技能与扩展', 'Skills and extensions'),
    description: t(
      '用户目录里的技能与扩展、Pi 内置的扩展。来自 Pi 包的在包的设置里启停',
      'Skills and extensions in the user directory, and the extensions built into Pi. Those from Pi packages are toggled in the package settings',
    ),
  },
]

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 整数项：键、组、标题、默认值、说明 */
function integer(
  key: string,
  group: string,
  title: [string, string],
  fallback: number | null,
  description?: [string, string],
): HarnessSettingSpec {
  return {
    key,
    group,
    type: 'integer',
    title: t(...title),
    description: description ? t(...description) : null,
    default: fallback,
    effect: 'newSession',
    minimum: 0,
  }
}

function boolean(
  key: string,
  group: string,
  title: [string, string],
  fallback: boolean,
): HarnessSettingSpec {
  return {
    key,
    group,
    type: 'boolean',
    title: t(...title),
    description: null,
    default: fallback,
    effect: 'newSession',
  }
}

// 固定的项；默认 provider、默认模型的选项是动态的，读的时候补上
const STATIC: HarnessSettingSpec[] = [
  {
    key: 'defaultProvider',
    group: 'defaults',
    type: 'enum',
    title: t('默认 provider', 'Default provider'),
    description: t(
      '新会话用哪家的模型。也可以在“账号与 provider”里切换',
      'Whose models new sessions use. Can also be switched under accounts and providers',
    ),
    default: null,
    effect: 'newSession',
    allowCustom: true,
  },
  {
    key: 'defaultModel',
    group: 'defaults',
    type: 'enum',
    title: t('默认模型', 'Default model'),
    description: t('默认 provider 下的模型标识', 'Model ID under the default provider'),
    default: null,
    effect: 'newSession',
    allowCustom: true,
  },
  {
    key: 'defaultThinkingLevel',
    group: 'defaults',
    type: 'enum',
    title: t('默认思考强度', 'Default thinking level'),
    description: t(
      '超出模型支持的范围时取它支持的最近一档',
      'Clamped to the nearest level the model supports',
    ),
    default: 'medium',
    effect: 'newSession',
    options: THINKING.map((value) => ({ value, title: t(value, value) })),
  },
  {
    key: 'enabledModels',
    group: 'defaults',
    type: 'stringList',
    title: t('参与切换的模型', 'Models to cycle through'),
    description: t(
      '模型的匹配式，和命令行的 --models 一样（如 anthropic/*、openai/gpt-5*）。不填是全部可用的模型',
      'Model patterns, as for --models on the command line (anthropic/*, openai/gpt-5*). Empty means all available models',
    ),
    default: null,
    effect: 'newSession',
    placeholder: 'anthropic/*',
  },
  {
    key: 'httpProxy',
    group: 'network',
    type: 'string',
    title: t('HTTP 代理', 'HTTP proxy'),
    description: t(
      '作为 HTTP_PROXY 和 HTTPS_PROXY 用；运行时的环境里已经有代理变量时以环境变量为准',
      'Used as HTTP_PROXY and HTTPS_PROXY; proxy variables already in the runtime environment take precedence',
    ),
    default: null,
    effect: 'harness',
    placeholder: 'http://127.0.0.1:7890',
  },
  boolean('retry.enabled', 'network', ['失败时自动重试', 'Retry on transient failures'], true),
  integer('retry.maxRetries', 'network', ['最多重试几次', 'Maximum retries'], 3),
  integer(
    'retry.baseDelayMs',
    'network',
    ['首次重试前等多久（毫秒）', 'Initial retry delay (ms)'],
    2000,
    ['之后每次翻倍', 'Doubles on each retry'],
  ),
  integer(
    'retry.maxAgentDelayMs',
    'network',
    ['重试最长等多久（毫秒）', 'Maximum retry delay (ms)'],
    60000,
  ),
  integer(
    'retry.provider.timeoutMs',
    'network',
    ['单次请求超时（毫秒）', 'Provider request timeout (ms)'],
    null,
    [
      '不填用 HTTP 空闲超时（默认 300000）',
      'Defaults to the HTTP idle timeout (300000 by default)',
    ],
  ),
  integer(
    'retry.provider.maxRetries',
    'network',
    ['provider 层的重试次数', 'Provider-level retries'],
    0,
    [
      '一般保持 0，让 Pi 自己处理限额和用量错误',
      'Usually keep 0 so Pi handles quota and usage-limit errors itself',
    ],
  ),
  integer(
    'retry.provider.maxRetryDelayMs',
    'network',
    ['服务端要求的等待最长接受多久（毫秒）', 'Maximum server-requested delay (ms)'],
    60000,
    ['0 表示不限', '0 disables the limit'],
  ),
  boolean('compaction.enabled', 'behavior', ['自动压缩', 'Automatic compaction'], true),
  integer(
    'compaction.reserveTokens',
    'behavior',
    ['给回答留的 token', 'Tokens reserved for the response'],
    16384,
  ),
  integer(
    'compaction.keepRecentTokens',
    'behavior',
    ['保留最近多少 token 不总结', 'Recent tokens kept without summarizing'],
    20000,
  ),
  {
    key: 'skills',
    group: 'tools',
    type: 'stringList',
    title: t('技能路径', 'Skill paths'),
    description: t(
      '另外加载的技能文件或目录（相对代理目录）。前缀 + 强制加载、- 不加载、! 排除匹配的',
      'Additional skill files or directories (relative to the agent directory). Prefix + to force-load, - to skip, ! to exclude matches',
    ),
    default: null,
    effect: 'newSession',
  },
  {
    key: 'extensions',
    group: 'tools',
    type: 'stringList',
    title: t('扩展路径', 'Extension paths'),
    description: t(
      '另外加载的扩展文件或目录，写法同技能路径；-builtin:mcp 关掉内置的 MCP',
      'Additional extension files or directories, same syntax as skill paths; -builtin:mcp turns off the built-in MCP support',
    ),
    default: null,
    effect: 'newSession',
  },
]

// ---------- 技能与扩展的启停 ----------

/** 一个能单独启停的技能或扩展：键是 `skills:<式子>`、`extensions:<式子>`，式子照 pi config 的写法 */
interface Toggle {
  key: string
  kind: 'skills' | 'extensions'
  pattern: string
  path: string
  enabled: boolean
  /** 来自 Pi 包的：在包的设置里启停，这里只读 */
  packageSource: string | null
}

const stripPrefix = (entry: string) => (/^[!+-]/.test(entry) ? entry.slice(1) : entry)

/** 用户层的技能与扩展，和 `pi config` 列的一样（不装缺的包、不看项目层） */
async function userResources(): Promise<Toggle[]> {
  const agentDir = getAgentDir()
  const settingsManager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false })
  const resolved = await new DefaultPackageManager({
    cwd: agentDir,
    agentDir,
    settingsManager,
    builtinExtensions: builtInExtensions.map((extension: { name: string }) => extension.name),
  }).resolve(async () => 'skip')
  return (['skills', 'extensions'] as const).flatMap((kind) =>
    resolved[kind]
      .filter((item) => item.metadata.scope === 'user')
      .map((item) => {
        // 同 pi config 的 getResourcePatternForScope：内置的用路径本身，其余相对它的基准目录
        const pattern =
          item.metadata.source === 'builtin'
            ? item.path
            : relative(item.metadata.baseDir ?? agentDir, item.path)
        return {
          key: `${kind}:${pattern}`,
          kind,
          pattern,
          path: item.path,
          enabled: item.enabled,
          packageSource: item.metadata.origin === 'package' ? item.metadata.source : null,
        }
      }),
  )
}

function toggleTitle(toggle: Toggle): string {
  if (toggle.path.startsWith('builtin:')) return toggle.path.slice('builtin:'.length)
  const name = basename(toggle.path)
  // 目录式的技能（foo/SKILL.md）、扩展（foo/index.ts）用目录名
  if (/^(SKILL\.md|index\.[cm]?[jt]s)$/i.test(name)) return basename(dirname(toggle.path))
  return name.replace(/\.(md|[cm]?[jt]s)$/i, '')
}

function toggleSpec(toggle: Toggle): HarnessSettingSpec {
  const builtin = toggle.path.startsWith('builtin:')
  const kind = toggle.kind === 'skills' ? ['技能', 'Skill'] : ['扩展', 'Extension']
  return {
    key: toggle.key,
    group: 'tools',
    type: 'boolean',
    title: t(
      `${kind[0]}：${toggleTitle(toggle)}${builtin ? '（内置）' : ''}`,
      `${kind[1]}: ${toggleTitle(toggle)}${builtin ? ' (built-in)' : ''}`,
    ),
    description: t(toggle.path, toggle.path),
    default: true,
    effect: 'newSession',
    clearable: false,
    ...(toggle.packageSource
      ? {
          readOnly: true,
          readOnlyReason: t(
            `来自 Pi 包 ${toggle.packageSource}，在包的设置里启停`,
            `Comes from the Pi package ${toggle.packageSource}; toggle it in the package settings`,
          ),
        }
      : {}),
  }
}

// ---------- 读 ----------

const settingsPath = () => agentPath('settings.json')

function getPath(object: Record<string, any>, key: string): unknown {
  let value: any = object
  for (const part of key.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    value = value[part]
  }
  return value
}

function setPath(object: Record<string, any>, key: string, value: unknown): void {
  const parts = key.split('.')
  let target = object
  for (const part of parts.slice(0, -1)) {
    if (typeof target[part] !== 'object' || target[part] === null || Array.isArray(target[part]))
      target[part] = {}
    target = target[part]
  }
  target[parts.at(-1)!] = value
}

/** 删掉一个键；删完空了的上层对象一并删掉 */
function deletePath(object: Record<string, any>, key: string): void {
  const parts = key.split('.')
  const chain: Record<string, any>[] = [object]
  for (const part of parts.slice(0, -1)) {
    const next = chain.at(-1)![part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return
    chain.push(next)
  }
  delete chain.at(-1)![parts.at(-1)!]
  for (let index = chain.length - 1; index > 0; index--) {
    if (Object.keys(chain[index]!).length) break
    delete chain[index - 1]![parts[index - 1]!]
  }
}

export async function configRead(): Promise<HarnessConfigReadResponse> {
  const path = settingsPath()
  const text = await readText(path)
  const settings = parseObject(text, path)
  const runtime = await modelRuntime()
  const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : null
  const specs = STATIC.map((spec): HarnessSettingSpec => {
    if (spec.key === 'defaultProvider')
      return {
        ...spec,
        options: runtime.getProviders().map((item) => ({
          value: item.id,
          title: t(item.name, item.name),
          description: runtime.getProviderAuthStatus(item.id).configured
            ? t('已有凭据', 'Credentials available')
            : t('没有凭据', 'No credentials'),
        })),
      }
    if (spec.key === 'defaultModel')
      return {
        ...spec,
        options: (provider ? runtime.getModels(provider) : []).map((model) => ({
          value: model.id,
          title: t(model.name, model.name),
        })),
      }
    return spec
  })
  const toggles = await userResources()
  const values: Record<string, HarnessSettingValue> = {}
  for (const spec of STATIC) {
    const value = getPath(settings, spec.key)
    if (value !== undefined && value !== null) values[spec.key] = value as HarnessSettingValue
  }
  for (const toggle of toggles) values[toggle.key] = toggle.enabled
  const proxy = environmentProxy()
  return {
    groups: GROUPS,
    settings: [...specs, ...toggles.map(toggleSpec)],
    values,
    ...(proxy && values.httpProxy !== undefined
      ? {
          overridden: {
            httpProxy: {
              value: proxy.value,
              by: t(`环境变量 ${proxy.name}`, `Environment variable ${proxy.name}`),
            },
          },
        }
      : {}),
    actions: [],
    version: hashOf(text),
    files: [
      { role: 'settings', path },
      { role: 'instructions', path: agentPath('AGENTS.md') },
    ],
  }
}

// ---------- 写 ----------

function invalid(key: string, zh: string, en: string): never {
  fail('invalidValue', `${key}：${zh}`, `${key}: ${en}`, key)
}

/** 按项的类型检查值，返回要写进去的值 */
function checked(spec: HarnessSettingSpec, value: HarnessSettingValue): unknown {
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') invalid(spec.key, '应当是真假值', 'must be a boolean')
      return value
    case 'integer':
      if (!Number.isSafeInteger(value) || (value as number) < (spec.minimum ?? 0))
        invalid(spec.key, '应当是不小于 0 的整数', 'must be a non-negative integer')
      return value
    case 'stringList':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        invalid(spec.key, '应当是一列字', 'must be a list of strings')
      return (value as string[]).map((item) => item.trim()).filter(Boolean)
    case 'enum':
    case 'string': {
      if (typeof value !== 'string' || !value.trim())
        invalid(spec.key, '不能为空', 'must not be empty')
      const text = (value as string).trim()
      if (spec.type === 'enum' && !spec.allowCustom && !spec.options?.some((o) => o.value === text))
        invalid(spec.key, `不认识 ${text}`, `unknown value ${text}`)
      return text
    }
    default:
      return invalid(spec.key, '这一项不能写', 'cannot be written')
  }
}

function applyToggle(settings: Record<string, any>, toggle: Toggle, value: unknown): void {
  if (toggle.packageSource)
    fail(
      'readOnly',
      `${toggle.key} 来自 Pi 包，在包的设置里启停`,
      `${toggle.key} comes from a Pi package; toggle it in the package settings`,
      toggle.key,
    )
  if (typeof value !== 'boolean') invalid(toggle.key, '应当是真假值', 'must be a boolean')
  // 同 pi config 的 toggleTopLevelResource：去掉这个式子已有的写法，再加一条 + 或 -
  const current: unknown[] = Array.isArray(settings[toggle.kind]) ? settings[toggle.kind] : []
  settings[toggle.kind] = [
    ...current.filter(
      (entry) => typeof entry !== 'string' || stripPrefix(entry) !== toggle.pattern,
    ),
    `${value ? '+' : '-'}${toggle.pattern}`,
  ]
}

export async function configWrite(
  s: PiServer,
  p: HarnessConfigWriteParams,
): Promise<HarnessConfigWriteResponse> {
  if (!Array.isArray(p.edits)) fail('invalidValue', 'edits 必须是数组', 'edits must be an array')
  const specs = new Map(STATIC.map((spec) => [spec.key, spec]))
  const toggles = p.edits.some((edit) => /^(skills|extensions):/.test(edit?.key))
    ? new Map((await userResources()).map((toggle) => [toggle.key, toggle]))
    : new Map<string, Toggle>()
  // 先查一遍再动文件：要么全写、要么全不写
  const apply: Array<(settings: Record<string, any>) => void> = p.edits.map(
    (edit: HarnessConfigEdit) => {
      const key = typeof edit?.key === 'string' ? edit.key : ''
      const toggle = toggles.get(key)
      if (toggle) return (settings) => applyToggle(settings, toggle, edit.value)
      const spec = specs.get(key)
      if (!spec) fail('notFound', `没有配置项 ${key}`, `No setting ${key}`, key)
      if (edit.value === null) return (settings) => deletePath(settings, key)
      const value = checked(spec, edit.value)
      return (settings) => setPath(settings, key, value)
    },
  )
  const storage = await settingsStorage(getAgentDir())
  const path = settingsPath()
  let version = ''
  storage.withLock('global', (current) => {
    checkVersion(p.expectedVersion, hashOf(current))
    const settings = parseObject(current, path)
    for (const step of apply) step(settings)
    // 和 Pi 自己写设置一样：两个空格缩进
    const next = JSON.stringify(settings, null, 2)
    version = hashOf(next)
    return next
  })
  changed(s, 'config')
  return {
    version,
    overriddenKeys:
      environmentProxy() && p.edits.some((edit) => edit.key === 'httpProxy' && edit.value !== null)
        ? ['httpProxy']
        : [],
    restartRequired: p.edits.some((edit) => specs.get(edit.key)?.effect === 'harness'),
  }
}
