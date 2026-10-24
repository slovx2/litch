// harness 详情设置里的配置项（litch/harness/config/read、write）：照 dsh 官方 Web、桌面端设置页的那几块——
// 默认模型、权限预设、联网搜索、子代理、终端（Shell）、内置插件启停，外加只读的“会话日志上传由 Litch 关闭”。
// 值都读写 dsh 自己的设置（settings/*、pluginManager/*、credentials/*），不另存。
// 键用 dsh 的“命名空间.路径”（agent-default-model.model 这种）；插件是 plugins.<条目号>。
// 内置插件里有 dsh 运行离不开的（REQUIRED_PLUGINS）：开着的只读、不让关；已经被关掉的可以打开，并提示要打开。
// dsh 一部分组件没了（被关掉了）时照样读得出来（模型目录、权限预设、设置读不到就少那几项），好让人把插件开回去。

import type {
  HarnessConfigEdit,
  HarnessConfigReadResponse,
  HarnessConfigWriteResponse,
  HarnessSettingGroup,
  HarnessSettingSpec,
  HarnessSettingValue,
  HarnessText,
} from '../../protocol/src/harness-config.mjs'
import {
  type CredentialInfo,
  describeCredentials,
  describeSettings,
  fromRemote,
  HarnessConfigError,
  mutateSettings,
  type NamespaceView,
  type PathOp,
  type SettingsSnapshot,
  schemaDefault,
  schemaEnum,
  text,
  valueAt,
  versionOf,
} from './harness-common.mjs'
import type { WebRemote } from './remote.mjs'
import { dshHome, sessionLogForcedOff } from './runtime.mjs'

const GROUPS: HarnessSettingGroup[] = [
  { id: 'defaults', title: text('默认模型', 'Default model'), description: null },
  {
    id: 'permissions',
    title: text('权限', 'Permissions'),
    description: text(
      '新会话默认用哪个权限预设。预设定了沙箱（只读、可写工作区、不限）和要不要先问你',
      'Which permission preset new sessions start with. A preset sets the sandbox (read-only, workspace write, unrestricted) and whether you are asked first',
    ),
  },
  { id: 'behavior', title: text('行为', 'Behavior'), description: null },
  { id: 'webSearch', title: text('联网搜索', 'Web search'), description: null },
  { id: 'subagents', title: text('子代理', 'Subagents'), description: null },
  {
    id: 'shell',
    title: text('终端', 'Shell'),
    description: text(
      '模型运行命令时的超时与输出上限',
      'Timeouts and output limits for commands the model runs',
    ),
  },
  {
    id: 'tools',
    title: text('内置插件', 'Built-in plugins'),
    description: text(
      'dsh 自带的插件，关掉的不再加载，改动立即生效。dsh 运行离不开的那些不能关；其余的关掉后对应的功能就没了，dsh 官方界面也不让改这些，不确定时别动',
      'Plugins shipped with dsh; disabled ones are not loaded and changes apply immediately. The ones dsh cannot run without cannot be turned off; turning off any other removes what it provides. The official dsh app does not let you change these, so leave them alone if unsure',
    ),
  },
]

/** 插件页不列的：别处已经有开关的、MCP 服务（在 MCP 那一页）；按模块名认 */
const UNLISTED_MODULES = /\/dsh-(mcp-client|session-log-deepseek|web-search-deepseek)$/
/** Litch 自己插进去的 */
const LITCH_PLUGIN = /litch-client-tools/

/**
 * dsh 运行离不开的内置插件（按补丁里的 id）。对着 dsh 0.2.0-rc.2 逐个关掉试过（隔离的 DSH_HOME、回环上的假模型）：
 * 关掉之后回合跑不起来、重启 dsh 后跑不起来、dsh 自己说停用失败（关到一半，依赖它的跟着起不来），
 * 或者 Litch 读不出这一页（没法再打开），就算离不开。
 */
export const REQUIRED_PLUGINS = new Set<string>([
  // 模型、会话、智能体主循环和它带的工具
  'llm',
  'llm-deepseek',
  'agent',
  'agent-loop',
  'agent-default-model',
  'system-prompt',
  'session',
  'session-controller',
  'user-questions',
  'commands',
  'preset-standard',
  'agent-preset-registry',
  'deepseek-llm-api-extensions',
  'session-title',
  'subagent',
  'subagent-model-selection-settings',
  'goal',
  'skill',
  'token-meter',
  'jobs',
  'web',
  // 存储与会话记录
  'storage',
  'storage-json',
  'storage-domain',
  'session-persistence-jsonl',
  'session-projection',
  'session-query-sqlite',
  'attachment-local',
  'workspace',
  'workspace-files',
  'workspace-changes',
  // 沙箱、命令、权限
  'subprocess',
  'sandbox',
  'sandbox-policy',
  'bash-sandbox',
  'fs-sandbox',
  'shell-env',
  'ptc-runtime',
  'approval',
  'permission',
  // 设置、凭据、账号（关掉之后 Litch 这一页也读不出来）
  'settings',
  'config-editor',
  'settings-controller',
  'credentials',
  'authorization',
  'deepseek-account',
  // 宿主与 Web 接口
  'typert-loader',
  'cordis-host-runner',
  'web-startup',
  'web-runtime',
  'file-upload',
])

/** 读一次要用的 dsh 状态 */
interface Context {
  remote: WebRemote
  settings: SettingsSnapshot
  catalog: any
  presets: any
  plugins: any[]
  credentials: Record<string, CredentialInfo>
}

/** 一个配置项和它怎么读写 */
interface Item {
  spec: HarnessSettingSpec
  /** 用户层写了的值；没写是 undefined */
  read(ctx: Context): HarnessSettingValue | undefined
  /** 实际生效的值（和 read 不同时报成 overridden） */
  effective?(ctx: Context): HarnessSettingValue | undefined
  overriddenBy?: HarnessText
  /** 写的时候直接改（插件开关、凭据），不经设置命名空间：放在最后做 */
  direct?: boolean
  /** 写：设置命名空间的改动收进 ops，别的（插件、凭据）直接做 */
  write(
    ctx: Context,
    value: HarnessSettingValue | null,
    ops: Map<string, PathOp[]>,
  ): Promise<void> | void
}

const WEB_SEARCH = 'web-search-deepseek'
const SHELL_NAMESPACES = ['bash-sandbox', 'pwsh-sandbox']

function spec(
  key: string,
  group: string,
  type: HarnessSettingSpec['type'],
  title: HarnessText,
  rest: Partial<HarnessSettingSpec> = {},
): HarnessSettingSpec {
  return { key, group, type, title, description: null, default: null, effect: 'none', ...rest }
}

function addOp(ops: Map<string, PathOp[]>, ns: string, op: PathOp): void {
  ops.set(ns, [...(ops.get(ns) ?? []), op])
}

/** 设置命名空间里一个字段，原样读写 */
function field(
  view: NamespaceView,
  path: string[],
  type: HarnessSettingSpec['type'],
  group: string,
  title: HarnessText,
  rest: Partial<HarnessSettingSpec> = {},
): Item {
  const options = type === 'enum' ? schemaEnum(view.schema, path) : null
  return {
    spec: spec(`${view.ns}.${path.join('.')}`, group, type, title, {
      default: valueAt(view.base, path) ?? schemaDefault(view.schema, path),
      ...(options
        ? { options: options.map((value) => ({ value, title: text(value, value) })) }
        : {}),
      ...rest,
    }),
    read: (ctx) => valueAt(ctx.settings.namespaces.get(view.ns)?.user, path),
    effective: (ctx) => valueAt(ctx.settings.namespaces.get(view.ns)?.value, path),
    write: (_ctx, value, ops) =>
      addOp(ops, view.ns, value === null ? { op: 'unset', path } : { op: 'set', path, value }),
  }
}

const modelId = (provider: unknown, model: unknown): string | undefined =>
  typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : undefined

function splitModel(value: string, key: string): { provider: string; model: string } {
  const slash = value.indexOf('/')
  if (slash < 1 || slash === value.length - 1)
    throw new HarnessConfigError(
      'invalidValue',
      text('模型要写成 provider/模型名', 'A model must be written as provider/model'),
      key,
    )
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

function modelItems(view: NamespaceView, catalog: any): Item[] {
  const groups: any[] = catalog?.groups ?? []
  const models = groups.flatMap((group) =>
    (group.models ?? []).map((model: any) => ({ group, model, id: `${group.id}/${model.id}` })),
  )
  const current = modelId(view.value?.provider, view.value?.model)
  const efforts: any[] = models.find((entry) => entry.id === current)?.model.reasoning?.efforts ?? [
    ...new Map(
      models.flatMap((entry) => entry.model.reasoning?.efforts ?? []).map((e: any) => [e.id, e]),
    ).values(),
  ]
  const ns = view.ns
  return [
    {
      spec: spec(
        'agent-default-model.model',
        'defaults',
        'enum',
        text('默认模型', 'Default model'),
        {
          description: text(
            '新会话用的模型。会话里换过模型之后 dsh 也会把那一个记成新的默认',
            'The model new sessions use. Choosing a model inside a session also makes it the new default in dsh',
          ),
          default: modelId(view.base?.provider, view.base?.model) ?? null,
          effect: 'newSession',
          clearable: false,
          allowCustom: true,
          options: models.map(({ group, model, id }) => ({
            value: id,
            title: text(
              `${group.name ?? group.id} · ${model.name ?? model.id}`,
              `${group.name ?? group.id} · ${model.name ?? model.id}`,
            ),
            ...(model.description
              ? { description: text(model.description, model.description) }
              : {}),
          })),
        },
      ),
      read: (ctx) => {
        const user = ctx.settings.namespaces.get(ns)?.user
        return modelId(user?.provider, user?.model)
      },
      effective: (ctx) => {
        const value = ctx.settings.namespaces.get(ns)?.value
        return modelId(value?.provider, value?.model)
      },
      write: (_ctx, value, ops) => {
        if (value === null)
          throw new HarnessConfigError(
            'invalidValue',
            text('默认模型不能清掉', 'The default model cannot be cleared'),
            'agent-default-model.model',
          )
        const { provider, model } = splitModel(String(value), 'agent-default-model.model')
        addOp(ops, ns, { op: 'set', path: ['provider'], value: provider })
        addOp(ops, ns, { op: 'set', path: ['model'], value: model })
      },
    },
    {
      ...field(
        view,
        ['reasoningEffort'],
        'enum',
        'defaults',
        text('默认推理强度', 'Default reasoning effort'),
        {
          description: text(
            '不设时用那个模型自己的默认强度',
            'When unset, the model’s own default effort is used',
          ),
          effect: 'newSession',
          options: efforts.map((effort) => ({
            value: String(effort.id),
            title: text(effort.name ?? effort.id, effort.name ?? effort.id),
            ...(effort.description
              ? { description: text(effort.description, effort.description) }
              : {}),
          })),
        },
      ),
    },
  ]
}

const presetTitle = (name: string): HarnessText =>
  ({
    'read-only': text('只读', 'Read only'),
    'workspace-write': text('可写工作区', 'Workspace write'),
    'danger-full-access': text('完全访问', 'Full access'),
  })[name] ?? text(name, name)

/** 联网搜索的密钥：存在它的 apiKeyEnv 指的那条凭据上（默认和 DeepSeek 官方接口共用 DEEPSEEK_API_KEY） */
const webSearchRef = (view: NamespaceView): string =>
  typeof view.value?.apiKeyEnv === 'string' && view.value.apiKeyEnv
    ? view.value.apiKeyEnv
    : 'DEEPSEEK_API_KEY'

function pluginItem(
  plugin: any,
  group: string,
  key: string,
  title: HarnessText,
  description: HarnessText | null,
): Item {
  const required = REQUIRED_PLUGINS.has(plugin.patchId)
  const on = plugin.enabled === true
  const rest: Partial<HarnessSettingSpec> = { description, clearable: false }
  // 离不开的：开着的不让关；被关掉了的可以打开，说一声要打开
  if (required && on)
    Object.assign(rest, {
      readOnly: true,
      readOnlyReason: text(
        'dsh 运行离不开它，关掉后 dsh 会起不来或用不了',
        'dsh cannot run without it; turning it off breaks dsh',
      ),
    })
  else if (required)
    rest.description = text(
      `dsh 运行离不开它，现在被关掉了，dsh 可能起不来或用不了，请打开${description ? `。${description['zh-CN']}` : ''}`,
      `dsh cannot run without it and it is off, so dsh may not work; turn it on${description ? `. ${description.en}` : ''}`,
    )
  return {
    spec: spec(key, group, 'boolean', title, rest),
    direct: true,
    read: (ctx) => ctx.plugins.find((one) => one.entryId === plugin.entryId)?.enabled === true,
    write: async (ctx, value) => {
      if (typeof value !== 'boolean')
        throw new HarnessConfigError('invalidValue', text('要填开或关', 'Must be on or off'), key)
      const result = await ctx.remote
        .rpc('pluginManager/setPluginEnabled', { id: plugin.entryId, enabled: value })
        .catch((error) => {
          throw fromRemote(error, key)
        })
      if (result?.application === 'failed')
        throw new HarnessConfigError(
          'invalidValue',
          text(
            `dsh 没能${value ? '启用' : '停用'}这个插件（${result.error?.code ?? '未知原因'}）`,
            `dsh could not ${value ? 'enable' : 'disable'} this plugin (${result.error?.code ?? 'unknown'})`,
          ),
          key,
        )
    },
  }
}

function items(ctx: Context): Item[] {
  const ns = (name: string) => ctx.settings.namespaces.get(name)
  const list: Item[] = []
  const defaults = ns('agent-default-model')
  if (defaults) list.push(...modelItems(defaults, ctx.catalog))
  const permission = ns('permission')
  if (permission) {
    const options: any[] = ctx.presets?.defaultOptions ?? ctx.presets?.options ?? []
    list.push({
      ...field(
        permission,
        ['defaultPreset'],
        'enum',
        'permissions',
        text('默认权限预设', 'Default permission preset'),
        {
          default: ctx.presets?.defaultPreset ?? null,
          effect: 'newSession',
          options: options.map((option) => ({
            value: String(option.value),
            title: presetTitle(String(option.value)),
          })),
        },
      ),
    })
  }
  const loop = ns('agent-loop')
  if (loop)
    list.push(
      field(
        loop,
        ['maxParallelToolCalls'],
        'integer',
        'behavior',
        text('一步里最多并行几个工具调用', 'Max parallel tool calls per step'),
        { minimum: 1 },
      ),
    )
  const log = ns('session-log-deepseek')
  if (log) {
    const forced = sessionLogForcedOff()
    list.push({
      ...field(
        log,
        ['enabled'],
        'boolean',
        'behavior',
        text('会话日志上传', 'Session log upload'),
        {
          description: text(
            'dsh 默认随模型请求把会话日志传给 DeepSeek',
            'By default dsh uploads session logs to DeepSeek with model requests',
          ),
          ...(forced
            ? { readOnly: true, readOnlyReason: text('由 Litch 关闭', 'Turned off by Litch') }
            : {}),
        },
      ),
      overriddenBy: text('Litch（起 dsh 时的补丁）', 'Litch (patch applied when starting dsh)'),
    })
  }
  const search = ns(WEB_SEARCH)
  const searchPlugin = ctx.plugins.find((plugin) => plugin.patchId === WEB_SEARCH)
  if (searchPlugin)
    list.push(
      pluginItem(
        searchPlugin,
        'webSearch',
        `${WEB_SEARCH}.enabled`,
        text('启用联网搜索', 'Enable web search'),
        null,
      ),
    )
  if (search) {
    const ref = webSearchRef(search)
    list.push(
      {
        spec: spec(
          `${WEB_SEARCH}.apiKey`,
          'webSearch',
          'secret',
          text('搜索用的 API key', 'Search API key'),
          {
            description: text(
              `存在 dsh 的凭据 ${ref} 上（默认和 DeepSeek 官方接口共用）`,
              `Stored as the dsh credential ${ref} (shared with the DeepSeek API by default)`,
            ),
          },
        ),
        direct: true,
        read: (c) => ({ set: c.credentials[ref]?.configured === true }),
        write: async (c, value) => {
          const call =
            value === null || value === ''
              ? c.remote.rpc('credentials/unset', { ref })
              : c.remote.rpc('credentials/set', { ref, value: String(value) })
          await call.catch((error) => {
            throw fromRemote(error, `${WEB_SEARCH}.apiKey`)
          })
        },
      },
      field(
        search,
        ['apiKeyEnv'],
        'string',
        'webSearch',
        text('密钥的凭据名', 'Credential name for the key'),
      ),
      field(search, ['baseURL'], 'string', 'webSearch', text('接口地址', 'Endpoint'), {
        placeholder: 'https://api.deepseek.com/anthropic',
      }),
      field(search, ['model'], 'string', 'webSearch', text('搜索用的模型', 'Search model')),
      field(
        search,
        ['maxUses'],
        'integer',
        'webSearch',
        text('每次最多搜几回', 'Max searches per call'),
        { minimum: 1 },
      ),
      field(
        search,
        ['maxTokens'],
        'integer',
        'webSearch',
        text('每次最多多少 token', 'Max tokens per call'),
        { minimum: 1 },
      ),
    )
  }
  const subagent = ns('subagent')
  if (subagent)
    list.push(
      field(
        subagent,
        ['maxDepth'],
        'integer',
        'subagents',
        text('最多嵌套几层', 'Max nesting depth'),
        { minimum: 0 },
      ),
      field(
        subagent,
        ['maxActiveSubagents'],
        'integer',
        'subagents',
        text('同时最多几个', 'Max active subagents'),
        { minimum: 1 },
      ),
    )
  const choose = ns('subagent-model-selection-settings')
  if (choose) {
    list.push(
      field(
        choose,
        ['enabled'],
        'boolean',
        'subagents',
        text('允许给子代理另选模型', 'Allow choosing a model for subagents'),
      ),
    )
    const pairs = (value: any) =>
      Array.isArray(value)
        ? value.map((entry: any) => `${entry?.provider}/${entry?.model}`)
        : undefined
    list.push({
      spec: spec(
        'subagent-model-selection-settings.allowedModels',
        'subagents',
        'stringList',
        text('子代理可选的模型', 'Models subagents may use'),
        {
          description: text('每行一个，写成 provider/模型名', 'One per line, as provider/model'),
          default: [],
        },
      ),
      read: (c) => pairs(c.settings.namespaces.get(choose.ns)?.user?.allowedModels),
      effective: (c) => pairs(c.settings.namespaces.get(choose.ns)?.value?.allowedModels),
      write: (_c, value, ops) => {
        const key = 'subagent-model-selection-settings.allowedModels'
        if (value === null) return addOp(ops, choose.ns, { op: 'unset', path: ['allowedModels'] })
        if (!Array.isArray(value))
          throw new HarnessConfigError(
            'invalidValue',
            text('要填一列模型', 'Must be a list of models'),
            key,
          )
        addOp(ops, choose.ns, {
          op: 'set',
          path: ['allowedModels'],
          value: value.map((one) => splitModel(String(one), key)),
        })
      },
    })
  }
  const shell = SHELL_NAMESPACES.map(ns).find(Boolean)
  if (shell)
    list.push(
      field(
        shell,
        ['timeoutMs'],
        'integer',
        'shell',
        text('命令默认超时（毫秒）', 'Default command timeout (ms)'),
        { minimum: 1 },
      ),
      field(
        shell,
        ['maxTimeoutMs'],
        'integer',
        'shell',
        text('命令最长超时（毫秒）', 'Max command timeout (ms)'),
        { minimum: 1 },
      ),
      field(
        shell,
        ['maxOutputBytes'],
        'integer',
        'shell',
        text('每条输出流保留多少字节', 'Bytes kept per output stream'),
        { minimum: 1 },
      ),
    )
  for (const plugin of ctx.plugins) {
    if (
      !plugin.patchId ||
      plugin.readOnlyReason ||
      UNLISTED_MODULES.test(String(plugin.moduleName ?? '')) ||
      LITCH_PLUGIN.test(`${plugin.moduleName ?? ''}|${plugin.entryId}`)
    )
      continue
    const title = String(plugin.meta?.title ?? plugin.moduleName ?? plugin.patchId)
    const description = plugin.meta?.description ? String(plugin.meta.description) : null
    list.push(
      pluginItem(
        plugin,
        'tools',
        `plugins.${plugin.entryId}`,
        text(title, title),
        description ? text(description, description) : null,
      ),
    )
  }
  return list
}

async function load(remote: WebRemote): Promise<Context> {
  try {
    // 插件列表读不到才算读不出来；别的几样读不到（提供它们的插件被关掉了）就少那几项，好让人把插件开回去
    const [settings, catalog, presets, plugins] = await Promise.all([
      describeSettings(remote).catch(
        (): SettingsSnapshot => ({ writable: false, namespaces: new Map() }),
      ),
      remote.rpc('session/modelCatalog', {}).catch(() => null),
      remote.rpc('permissionPresets/catalog', {}).catch(() => null),
      remote.rpc('pluginManager/listPlugins', {}, Array.isArray),
    ])
    const search = settings.namespaces.get(WEB_SEARCH)
    const credentials = search ? await describeCredentials(remote, [webSearchRef(search)]) : {}
    return { remote, settings, catalog, presets, plugins, credentials }
  } catch (error) {
    throw fromRemote(error)
  }
}

/** 版本号：用到的命名空间的修订号、插件开关、凭据有没有 */
const version = (ctx: Context): string =>
  versionOf([
    [...ctx.settings.namespaces.values()].map((view) => [view.ns, view.revision]),
    ctx.plugins.map((plugin) => [plugin.entryId, plugin.enabled]),
    Object.entries(ctx.credentials).map(([ref, info]) => [ref, info.configured]),
  ])

export async function readConfig(remote: WebRemote): Promise<HarnessConfigReadResponse> {
  const ctx = await load(remote)
  const list = items(ctx)
  const values: Record<string, HarnessSettingValue> = {}
  const overridden: NonNullable<HarnessConfigReadResponse['overridden']> = {}
  for (const item of list) {
    const value = item.read(ctx)
    if (value !== undefined) values[item.spec.key] = value
    const effective = item.effective?.(ctx)
    if (
      item.overriddenBy &&
      effective !== undefined &&
      JSON.stringify(effective) !== JSON.stringify(value)
    )
      overridden[item.spec.key] = { value: effective, by: item.overriddenBy }
  }
  const used = new Set(list.map((item) => item.spec.group))
  const home = dshHome()
  return {
    groups: GROUPS.filter((group) => used.has(group.id)),
    settings: list.map((item) => item.spec),
    values,
    ...(Object.keys(overridden).length ? { overridden } : {}),
    actions: [],
    version: version(ctx),
    files: [
      { role: 'settings', path: `${home}/profiles/web/cordis.patch.yml` },
      { role: 'credentials', path: `${home}/.credentials.yaml` },
    ],
  }
}

const invalid = (key: string, zh: string, en: string) =>
  new HarnessConfigError('invalidValue', text(`${key}：${zh}`, `${key}: ${en}`), key)

/** 按声明核对一个值；不对就报 invalidValue */
function check(item: HarnessSettingSpec, value: HarnessSettingValue | null): void {
  const { key } = item
  if (item.readOnly)
    throw new HarnessConfigError(
      'readOnly',
      item.readOnlyReason ?? text('这一项不能改', 'This setting is read-only'),
      key,
    )
  if (value === null) {
    if (item.clearable === false) throw invalid(key, '不能清掉', 'cannot be cleared')
    return
  }
  const fail = (zh: string, en: string) => {
    throw invalid(key, zh, en)
  }
  switch (item.type) {
    case 'boolean':
      if (typeof value !== 'boolean') fail('要填开或关', 'must be a boolean')
      return
    case 'integer':
    case 'number':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (item.type === 'integer' && !Number.isInteger(value))
      )
        fail('要填数字', 'must be a number')
      if (
        (item.minimum !== undefined && (value as number) < item.minimum) ||
        (item.maximum !== undefined && (value as number) > item.maximum)
      )
        fail('超出范围', 'out of range')
      return
    case 'enum':
      if (typeof value !== 'string') fail('要填一个选项', 'must be one of the options')
      if (
        !item.allowCustom &&
        item.options?.length &&
        !item.options.some((option) => option.value === value)
      )
        fail('不在可选的范围里', 'is not one of the options')
      return
    case 'stringList':
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
        fail('要填一列字', 'must be a list of strings')
      return
    case 'json':
      return
    default:
      if (typeof value !== 'string') fail('要填字', 'must be a string')
  }
}

/** 写若干项：先全部核对、把设置命名空间的改动算出来，再按命名空间写（带读到的修订号），最后改插件开关和凭据 */
export async function writeConfig(
  remote: WebRemote,
  edits: HarnessConfigEdit[],
  expectedVersion: string,
): Promise<HarnessConfigWriteResponse> {
  const ctx = await load(remote)
  if (version(ctx) !== expectedVersion)
    throw new HarnessConfigError(
      'versionConflict',
      text('配置在读过之后被改了，请重读', 'The settings changed since they were read; reload'),
    )
  const byKey = new Map(items(ctx).map((item) => [item.spec.key, item]))
  const targets = edits.map((edit) => {
    const item = byKey.get(edit.key)
    if (!item)
      throw new HarnessConfigError(
        'notFound',
        text(`没有 ${edit.key} 这一项`, `No setting named ${edit.key}`),
        edit.key,
      )
    check(item.spec, edit.value)
    return { item, value: edit.value }
  })
  const ops = new Map<string, PathOp[]>()
  for (const { item, value } of targets) if (!item.direct) await item.write(ctx, value, ops)
  // 默认模型的 provider、model 是必填的：用户层还没写过、这次只改强度时，把现在生效的那一对一起写上
  const pending = ops.get('agent-default-model')
  const defaults = ctx.settings.namespaces.get('agent-default-model')
  if (
    pending &&
    defaults &&
    defaults.user?.provider === undefined &&
    !pending.some((op) => op.path[0] === 'provider')
  )
    pending.unshift(
      { op: 'set', path: ['provider'], value: defaults.value?.provider },
      { op: 'set', path: ['model'], value: defaults.value?.model },
    )
  for (const [ns, list] of ops)
    await mutateSettings(remote, ns, list, ctx.settings.namespaces.get(ns)?.revision, edits[0]?.key)
  for (const { item, value } of targets) if (item.direct) await item.write(ctx, value, ops)
  const after = await load(remote)
  const overriddenKeys = targets
    .filter(({ item, value }) => {
      const effective = item.effective?.(after)
      return (
        value !== null &&
        effective !== undefined &&
        JSON.stringify(effective) !== JSON.stringify(value)
      )
    })
    .map(({ item }) => item.spec.key)
  return { version: version(after), overriddenKeys, restartRequired: false }
}
