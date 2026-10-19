import type {
  HarnessConfigEdit,
  HarnessConfigReadResponse,
  HarnessConfigWriteResponse,
  HarnessSettingGroup,
  HarnessSettingOption,
  HarnessSettingSpec,
  HarnessSettingValue,
  HarnessText,
} from '../../protocol/src/harness-config.mjs'
import type { HarnessSettings } from './harness-settings.mjs'
import {
  conflict,
  HarnessError,
  invalid,
  opencodeMessage,
  text,
} from './harness-settings-shared.mjs'
import { authFile, editJsonc, parseJsonc, readGlobalConfig } from './native-config.mjs'

// 配置项（litch/harness/config/*）：参考 OpenCode 官方桌面端的 Server 组和它的配置文件结构（opencode.ai/config.json），
// 只放用户级、和 Litch 有关的项。键就是配置里的路径（permission.edit、provider.<id>.blacklist）。
// 主题、快捷键在 OpenCode 自己的 tui.json 里，不管。

const GROUPS: HarnessSettingGroup[] = [
  { id: 'defaults', title: text('默认', 'Defaults'), description: null },
  {
    id: 'permissions',
    title: text('权限', 'Permissions'),
    description: text(
      'OpenCode 没有沙箱，权限决定各类工具是直接用、先问你还是不许用。这是 Litch “项目内”这一档照着走的规则；“只读”“完全访问”两档由 Litch 自己控制',
      'OpenCode has no sandbox: permissions decide whether each kind of tool runs directly, asks you first or is denied. Litch’s “workspace” preset follows these rules; the “read-only” and “full access” presets are handled by Litch itself',
    ),
  },
  {
    id: 'models',
    title: text('模型可见性', 'Model visibility'),
    description: text(
      '按 provider 列出不想看到的模型，它们不会出现在模型列表里',
      'Per provider, models you don’t want to see; they are left out of the model list',
    ),
  },
  { id: 'behavior', title: text('行为', 'Behavior'), description: null },
  { id: 'advanced', title: text('其他', 'Advanced'), description: null },
]

const ACTIONS: HarnessSettingOption[] = [
  { value: 'allow', title: text('直接用', 'Allow') },
  { value: 'ask', title: text('先问', 'Ask') },
  { value: 'deny', title: text('不许用', 'Deny') },
]

/** 权限里单列出来的工具：[工具名, 中文, 英文, 没写时 OpenCode 的默认] */
const PERMISSION_TOOLS: Array<[string, string, string, string | null]> = [
  ['*', '所有工具的默认', 'Default for every tool', 'allow'],
  ['read', '读文件', 'Read files', null],
  ['edit', '改文件', 'Edit files', null],
  ['bash', '运行命令', 'Run commands', null],
  ['task', '开子代理', 'Start subagents', null],
  ['webfetch', '联网取网页', 'Fetch web pages', null],
  ['websearch', '联网搜索', 'Web search', null],
  ['external_directory', '碰项目外的目录', 'Directories outside the project', 'ask'],
  ['skill', '用技能', 'Use skills', null],
  ['doom_loop', '反复相同的调用', 'Repeated identical calls', 'ask'],
]

const BLACKLIST = /^provider\.(.+)\.blacklist$/

interface Catalogs {
  providers: any
  agents: any[]
  /** serve 合起来的配置（全局文件之上还有 OPENCODE_CONFIG、OPENCODE_CONFIG_CONTENT 等几层） */
  effective: any
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function catalogs(h: HarnessSettings): Promise<Catalogs> {
  const api = await h.server.api()
  const [providers, agents, effective] = await Promise.all([
    api.request('GET', '/provider', { timeoutMs: 30000 }),
    api.request('GET', '/agent', { timeoutMs: 30000 }).catch(() => []),
    api.request('GET', '/config', { timeoutMs: 30000 }).catch(() => ({})),
  ])
  return {
    providers: providers ?? {},
    agents: Array.isArray(agents) ? agents : [],
    effective: isRecord(effective) ? effective : {},
  }
}

/** 已连上的 provider，按 OpenCode 给的顺序 */
function connected(providers: any): any[] {
  const ids = new Set<string>(providers?.connected ?? [])
  return (providers?.all ?? []).filter((provider: any) => ids.has(provider.id))
}

function modelOptions(providers: any): HarnessSettingOption[] {
  return connected(providers).flatMap((provider: any) =>
    Object.values(provider.models ?? {})
      .filter((model: any) => model?.status !== 'deprecated')
      .map((model: any) => ({
        value: `${provider.id}/${model.id}`,
        title: text(String(model.name ?? model.id), String(model.name ?? model.id)),
        description: text(
          String(provider.name ?? provider.id),
          String(provider.name ?? provider.id),
        ),
      })),
  )
}

function spec(
  key: string,
  group: string,
  type: HarnessSettingSpec['type'],
  title: HarnessText,
  description: HarnessText | null,
  defaultValue: HarnessSettingValue | null,
  extra: Partial<HarnessSettingSpec> = {},
): HarnessSettingSpec {
  return { key, group, type, title, description, default: defaultValue, effect: 'none', ...extra }
}

function settingsFor(merged: Record<string, any>, catalogs: Catalogs): HarnessSettingSpec[] {
  const models = modelOptions(catalogs.providers)
  const agents: HarnessSettingOption[] = catalogs.agents
    .filter((agent) => agent?.mode !== 'subagent' && !agent?.hidden)
    .map((agent) => ({
      value: String(agent.name),
      title: text(String(agent.name), String(agent.name)),
      ...(agent.description
        ? { description: text(String(agent.description), String(agent.description)) }
        : {}),
    }))
  const permission = merged.permission
  const settings: HarnessSettingSpec[] = [
    spec(
      'model',
      'defaults',
      'enum',
      text('默认模型', 'Default model'),
      text(
        '新会话用的模型。不设就由 OpenCode 自己挑（头一个已连上的 provider 的推荐模型）',
        'Model for new sessions. When unset OpenCode picks one (the recommended model of the first connected provider)',
      ),
      null,
      { options: models, allowCustom: true, placeholder: 'provider/model' },
    ),
    spec(
      'small_model',
      'defaults',
      'enum',
      text('小模型', 'Small model'),
      text(
        '起标题这类杂活用的模型。不设就用当前 provider 里便宜的那个',
        'Model for chores like titles. When unset OpenCode uses a cheap model of the current provider',
      ),
      null,
      { options: models, allowCustom: true, placeholder: 'provider/model' },
    ),
    spec(
      'default_agent',
      'defaults',
      'enum',
      text('默认代理', 'Default agent'),
      text(
        '没指定代理时用哪个主代理。Litch 的计划模式固定用 plan',
        'Primary agent used when none is chosen. Litch’s plan mode always uses plan',
      ),
      'build',
      { options: agents, allowCustom: true },
    ),
  ]
  for (const [tool, zh, en, fallback] of PERMISSION_TOOLS) {
    const rule =
      typeof permission === 'string' ? (tool === '*' ? permission : undefined) : permission?.[tool]
    const patterned = isRecord(rule)
    settings.push(
      spec(
        `permission.${tool}`,
        'permissions',
        'enum',
        text(zh, en),
        tool === '*'
          ? text('下面没单独设的工具都照这一项', 'Applies to every tool not set separately below')
          : text('不设就跟随“所有工具的默认”', 'When unset, follows “Default for every tool”'),
        fallback,
        {
          options: ACTIONS,
          ...(patterned
            ? {
                readOnly: true,
                readOnlyReason: text(
                  '这一项按模式分别设了规则，请在“其他”里的完整权限设置里改',
                  'This one has per-pattern rules; edit it in the full permission setting under Advanced',
                ),
              }
            : {}),
        },
      ),
    )
  }
  const hidden = isRecord(merged.provider) ? merged.provider : {}
  for (const provider of connected(catalogs.providers)) {
    const listed = Object.keys(provider.models ?? {})
    const current: string[] = Array.isArray(hidden[provider.id]?.blacklist)
      ? hidden[provider.id].blacklist
      : []
    const name = String(provider.name ?? provider.id)
    settings.push(
      spec(
        `provider.${provider.id}.blacklist`,
        'models',
        'stringList',
        text(`${name}：不显示的模型`, `${name}: hidden models`),
        null,
        [],
        {
          options: [...new Set([...listed, ...current])].map((id) => ({
            value: id,
            title: text(
              String(provider.models?.[id]?.name ?? id),
              String(provider.models?.[id]?.name ?? id),
            ),
          })),
        },
      ),
    )
  }
  settings.push(
    spec(
      'share',
      'behavior',
      'enum',
      text('分享会话', 'Session sharing'),
      text(
        '会话分享到 opencode.ai 的方式：手动、自动或关掉',
        'How sessions are shared to opencode.ai: manually, automatically or never',
      ),
      'manual',
      {
        options: [
          { value: 'manual', title: text('手动', 'Manual') },
          { value: 'auto', title: text('自动', 'Automatic') },
          { value: 'disabled', title: text('关掉', 'Disabled') },
        ],
      },
    ),
    spec(
      'autoupdate',
      'behavior',
      'enum',
      text('自动更新', 'Auto update'),
      text(
        'OpenCode 自己的界面启动时要不要自动更新。Litch 起的 serve 不自己更新',
        'Whether OpenCode’s own interface updates itself on start. The serve started by Litch does not',
      ),
      'true',
      {
        options: [
          { value: 'true', title: text('自动更新', 'Update automatically') },
          { value: 'notify', title: text('只提醒', 'Notify only') },
          { value: 'false', title: text('不更新', 'Off') },
        ],
      },
    ),
    spec(
      'snapshot',
      'behavior',
      'boolean',
      text('快照', 'Snapshots'),
      text(
        '记录文件快照。关掉之后回退会话不再恢复文件，回合的差异也算不出来',
        'Record file snapshots. When off, reverting no longer restores files and turn diffs are unavailable',
      ),
      true,
    ),
    spec(
      'subagent_depth',
      'behavior',
      'integer',
      text('子代理嵌套层数', 'Subagent depth'),
      text('1 表示子代理不能再开子代理', '1 means subagents cannot start subagents'),
      1,
      { minimum: 0, maximum: 10 },
    ),
    spec(
      'username',
      'behavior',
      'string',
      text('显示的用户名', 'Username'),
      text(
        '对话里用这个名字代替系统用户名',
        'Shown in conversations instead of the system user name',
      ),
      null,
    ),
    spec(
      'disabled_providers',
      'advanced',
      'stringList',
      text('停用的 provider', 'Disabled providers'),
      text(
        '即使有凭据也不加载的 provider（填 provider 号）',
        'Providers not loaded even when credentials exist (provider IDs)',
      ),
      [],
    ),
    spec(
      'enabled_providers',
      'advanced',
      'stringList',
      text('只用这些 provider', 'Only these providers'),
      text(
        '设了之后只加载这里列的 provider，其余一概不管',
        'When set, only the listed providers are loaded',
      ),
      [],
    ),
    spec(
      'instructions',
      'advanced',
      'stringList',
      text('额外的指令文件', 'Extra instruction files'),
      text(
        '除了 AGENTS.md 之外还要读的文件（路径或通配，~/ 开头的相对于主目录）',
        'Files to read besides AGENTS.md (paths or globs; ~/ is the home directory)',
      ),
      [],
    ),
    spec(
      'permission',
      'advanced',
      'json',
      text('完整权限设置', 'Full permission setting'),
      text(
        'OpenCode 的 permission 原样：一个动作（allow、ask、deny），或者按工具（以及按命令、路径的模式）分别写',
        'OpenCode’s permission as is: one action (allow, ask, deny), or per tool (and per command or path pattern)',
      ),
      null,
    ),
  )
  return settings
}

function valuesFor(merged: Record<string, any>, settings: HarnessSettingSpec[]) {
  const values: Record<string, HarnessSettingValue> = {}
  for (const setting of settings) {
    const { key } = setting
    let value: unknown
    if (key.startsWith('permission.')) {
      const tool = key.slice('permission.'.length)
      const permission = merged.permission
      value =
        typeof permission === 'string'
          ? tool === '*'
            ? permission
            : undefined
          : permission?.[tool]
      if (isRecord(value)) value = undefined
    } else if (BLACKLIST.test(key)) {
      const id = (BLACKLIST.exec(key) as RegExpExecArray)[1] as string
      value = merged.provider?.[id]?.blacklist
    } else if (key === 'autoupdate') {
      value = merged.autoupdate === undefined ? undefined : String(merged.autoupdate)
    } else value = merged[key]
    if (value !== undefined && value !== null) values[key] = value as HarnessSettingValue
  }
  return values
}

// 单个值的项：serve 实际用的和全局文件里写的不一样（更高的几层盖住了），如实报出来
const SCALARS = [
  'model',
  'small_model',
  'default_agent',
  'share',
  'autoupdate',
  'snapshot',
  'subagent_depth',
  'username',
]

function overriddenFor(
  merged: Record<string, any>,
  effective: Record<string, any>,
): Record<string, { value: HarnessSettingValue; by: HarnessText }> {
  const out: Record<string, { value: HarnessSettingValue; by: HarnessText }> = {}
  for (const key of SCALARS) {
    const actual = effective[key]
    if (actual === undefined || actual === null || actual === merged[key]) continue
    out[key] = {
      value: key === 'autoupdate' ? String(actual) : actual,
      by: text(
        '环境变量（OPENCODE_CONFIG、OPENCODE_CONFIG_CONTENT）或组织下发的配置',
        'Environment (OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT) or organization-provided configuration',
      ),
    }
  }
  return out
}

export async function configRead(h: HarnessSettings): Promise<HarnessConfigReadResponse> {
  // 先让 serve 起来再读文件：OpenCode 读配置时会给缺 $schema 的文件补上一行，先读的话版本号马上就对不上了
  const known = await catalogs(h)
  const snapshot = readGlobalConfig(h.paths)
  const settings = settingsFor(snapshot.merged, known)
  return {
    groups: GROUPS,
    settings,
    values: valuesFor(snapshot.merged, settings),
    ...(h.reloadPending() ? {} : { overridden: overriddenFor(snapshot.merged, known.effective) }),
    actions: [
      {
        id: 'reload',
        group: 'advanced',
        title: text('让 OpenCode 重新读配置', 'Reload OpenCode configuration'),
        description: text(
          '在终端或编辑器里改过配置文件、凭据之后用',
          'Use after editing the configuration or credentials outside Litch',
        ),
        confirm: text(
          'OpenCode 重读配置时会停掉正在跑的回合，继续吗？',
          'Reloading stops turns that are running. Continue?',
        ),
      },
    ],
    version: snapshot.version,
    files: [
      { role: 'settings', path: snapshot.target },
      { role: 'credentials', path: authFile(h.paths) },
    ],
  }
}

/** 一项的值合不合规矩；合规的返回要写进配置的值（undefined 是删掉） */
function checked(setting: HarnessSettingSpec, value: HarnessSettingValue | null): unknown {
  const bad = () =>
    invalid(
      setting.key,
      `${setting.title['zh-CN']}的值不对`,
      `Invalid value for ${setting.title.en}`,
    )
  if (value === null) return undefined
  switch (setting.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw bad()
      return value
    case 'integer':
      if (!Number.isInteger(value)) throw bad()
      if (setting.minimum !== undefined && (value as number) < setting.minimum) throw bad()
      if (setting.maximum !== undefined && (value as number) > setting.maximum) throw bad()
      return value
    case 'string':
      if (typeof value !== 'string') throw bad()
      return value.trim() ? value : undefined
    case 'enum':
      if (typeof value !== 'string' || !value) throw bad()
      if (!setting.allowCustom && !setting.options?.some((option) => option.value === value))
        throw bad()
      return setting.key === 'autoupdate' ? (value === 'notify' ? value : value === 'true') : value
    case 'stringList':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw bad()
      return value.length ? value : undefined
    case 'json':
      if (setting.key === 'permission') {
        const ok =
          (typeof value === 'string' && ['allow', 'ask', 'deny'].includes(value)) || isRecord(value)
        if (!ok) throw bad()
      }
      return value
    default:
      throw bad()
  }
}

/** 把一项改进原文 */
function apply(source: string, key: string, value: unknown): string {
  if (key.startsWith('permission.')) {
    const tool = key.slice('permission.'.length)
    const current = parseJsonc(source || '{}', 'opencode.json').permission
    if (typeof current === 'string') {
      // 整体一档的写法：改“*”就还是一档；单改某个工具时摊成按工具写，原来那一档变成“*”
      if (tool === '*') return editJsonc(source, ['permission'], value)
      if (value === undefined) return source
      return editJsonc(source, ['permission'], { '*': current, [tool]: value })
    }
    if (value === undefined && !isRecord(current)) return source
    // “*” 放在最前：OpenCode 按书写顺序、后写的生效
    return editJsonc(source, ['permission', tool], value, tool === '*')
  }
  const blacklist = BLACKLIST.exec(key)
  if (blacklist) return editJsonc(source, ['provider', blacklist[1] as string, 'blacklist'], value)
  return editJsonc(source, [key], value)
}

export async function configWrite(h: HarnessSettings, p: any): Promise<HarnessConfigWriteResponse> {
  const edits: HarnessConfigEdit[] = Array.isArray(p.edits) ? p.edits : []
  const known = await catalogs(h)
  const snapshot = readGlobalConfig(h.paths)
  if (p.expectedVersion !== snapshot.version) throw conflict()
  const settings = settingsFor(snapshot.merged, known)
  let next = snapshot.text
  for (const edit of edits) {
    const setting = settings.find((entry) => entry.key === edit.key)
    if (!setting)
      throw invalid(String(edit.key), `没有配置项 ${edit.key}`, `Unknown setting ${edit.key}`)
    if (setting.readOnly)
      throw new HarnessError(
        'readOnly',
        setting.readOnlyReason ?? text('这一项不能在这里改', 'This setting cannot be changed here'),
        setting.key,
      )
    next = apply(next, setting.key, checked(setting, edit.value))
  }
  if (next === snapshot.text)
    return { version: snapshot.version, overriddenKeys: [], restartRequired: false }
  let restartRequired: boolean
  try {
    restartRequired = await h.commitConfig(
      snapshot.target,
      next,
      snapshot.files.some((file) => file.path === snapshot.target) ? snapshot.text : null,
    )
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new Error(`写 OpenCode 的配置失败：${opencodeMessage(error)}`)
  }
  h.changed('config')
  return { version: readGlobalConfig(h.paths).version, overriddenKeys: [], restartRequired }
}
