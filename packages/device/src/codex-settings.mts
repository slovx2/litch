// 原生 codex 的配置项（litch/harness/config/read）：照官方桌面端的设置页挑的那几组，纯桌面外壳的不做。
// 每一项的键就是 config.toml 里的键路径；技能和 hooks 的信任是两个例外（见 SYNTHETIC），写的时候翻译。
// 结构每次现读：模型列表（model/list）、实验特性（experimentalFeature/list）、技能（skills/list）、
// 插件（plugin/list）、hooks（hooks/list）都是动态的；哪个问不到就不出那几项，不让整个读失败。
import type {
  HarnessConfigAction,
  HarnessConfigReadResponse,
  HarnessSettingGroup,
  HarnessSettingOption,
  HarnessSettingSpec,
  HarnessSettingValue,
} from '../../protocol/src/harness-config.mjs'
import {
  type Ask,
  type CodexSnapshot,
  layerTitle,
  overridingLayer,
  readSnapshot,
  segment,
  splitKey,
  valueAt,
} from './codex-config-io.mjs'
import { text } from './harness-config.mjs'
import { isObject } from './wire.mjs'

const GROUPS: HarnessSettingGroup[] = [
  {
    id: 'defaults',
    title: text('默认', 'Defaults'),
    description: text('新建会话时用的模型和强度', 'Model and effort for new sessions'),
  },
  {
    id: 'context',
    title: text('上下文', 'Context'),
    description: text(
      '对所有模型生效，盖过每个模型自己的设置（包括模型清单里改的）',
      'Applies to every model and overrides each model’s own settings, including the model list',
    ),
  },
  { id: 'permissions', title: text('权限与沙箱', 'Permissions & sandbox'), description: null },
  { id: 'behavior', title: text('行为与输出', 'Behavior & output'), description: null },
  {
    id: 'features',
    title: text('实验特性', 'Experimental features'),
    description: text('改了要重启 Codex 才生效', 'Restart Codex to apply changes'),
  },
  { id: 'tools', title: text('技能、插件与 hooks', 'Skills, plugins & hooks'), description: null },
  { id: 'memory', title: text('记忆', 'Memory'), description: null },
]

export const MEMORY_RESET = 'memory.reset'

const ACTIONS: HarnessConfigAction[] = [
  {
    id: MEMORY_RESET,
    group: 'memory',
    title: text('清空记忆', 'Reset memories'),
    description: text('删掉 Codex 记下的全部记忆', 'Delete everything Codex has remembered'),
    confirm: text(
      '确定清空 Codex 的全部记忆？清掉就找不回来了。',
      'Delete all of Codex’s memories? This cannot be undone.',
    ),
    danger: true,
  },
]

const option = (value: string, zh: string, en: string): HarnessSettingOption => ({
  value,
  title: text(zh, en),
})

type Spec = HarnessSettingSpec & {
  /** 写的时候怎么落：不给是 config.toml 里同名的键路径 */
  write?: { kind: 'skill'; path: string } | { kind: 'hookTrust'; hookKey: string; hash: string }
}

function enumSpec(
  key: string,
  group: string,
  title: [string, string],
  options: HarnessSettingOption[],
  fallback: string | null,
  allowed?: unknown,
): Spec {
  const permitted = Array.isArray(allowed)
    ? new Set(allowed.filter((v) => typeof v === 'string'))
    : null
  const shown = permitted ? options.filter((item) => permitted.has(item.value)) : options
  return {
    key,
    group,
    type: 'enum',
    title: text(...title),
    description: null,
    default: fallback,
    effect: 'newSession',
    options: shown,
    ...(permitted && shown.length <= 1
      ? {
          readOnly: true,
          readOnlyReason: text('管理员要求只能用这一种', 'Locked by managed requirements'),
        }
      : {}),
  }
}

function boolSpec(
  key: string,
  group: string,
  title: [string, string],
  fallback: boolean | null,
  description: [string, string] | null = null,
): Spec {
  return {
    key,
    group,
    type: 'boolean',
    title: text(...title),
    description: description ? text(...description) : null,
    default: fallback,
    effect: 'newSession',
  }
}

interface Catalog {
  models: Record<string, unknown>[]
  features: Record<string, unknown>[]
  skills: Record<string, unknown>[]
  plugins: Record<string, unknown>[]
  hooks: Record<string, unknown>[]
}

const items = (value: unknown, field = 'data'): Record<string, unknown>[] =>
  isObject(value) && Array.isArray(value[field])
    ? (value[field] as Record<string, unknown>[]).filter(isObject)
    : []

/** 动态的几样一起问；问不到的当没有 */
async function readCatalog(ask: Ask, home: string | null): Promise<Catalog> {
  const cwds = home ? [home] : []
  const [models, features, skills, plugins, hooks] = await Promise.all([
    ask('model/list', { limit: 200 }).catch(() => null),
    ask('experimentalFeature/list', { limit: 500 }).catch(() => null),
    ask('skills/list', { cwds, forceReload: true }).catch(() => null),
    ask('plugin/list', {}).catch(() => null),
    ask('hooks/list', { cwds }).catch(() => null),
  ])
  return {
    models: items(models).filter((model) => model.hidden !== true),
    features: items(features),
    skills: items(skills).flatMap((entry) => items(entry, 'skills')),
    plugins: items(plugins, 'marketplaces')
      .flatMap((market) => items(market, 'plugins'))
      .filter((plugin) => plugin.installed === true),
    hooks: items(hooks).flatMap((entry) => items(entry, 'hooks')),
  }
}

function defaultsSpecs(snapshot: CodexSnapshot, models: Record<string, unknown>[]): Spec[] {
  const fallback = models.find((model) => model.isDefault === true)
  const chosen = snapshot.config.model
  const current = models.find((model) => model.model === chosen) ?? fallback
  // 问不到模型列表（或者用的模型不在里面）时给 codex 认的那几档
  const efforts: Record<string, unknown>[] = Array.isArray(current?.supportedReasoningEfforts)
    ? (current.supportedReasoningEfforts as Record<string, unknown>[]).filter(isObject)
    : ['minimal', 'low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort }))
  const tiers = Array.isArray(current?.serviceTiers)
    ? (current.serviceTiers as Record<string, unknown>[]).filter(isObject)
    : []
  const specs: Spec[] = [
    {
      key: 'model',
      group: 'defaults',
      type: 'enum',
      title: text('模型', 'Model'),
      description: null,
      default: typeof fallback?.model === 'string' ? fallback.model : null,
      effect: 'newSession',
      allowCustom: true,
      options: models.map((model) => ({
        value: String(model.model),
        title: text(
          String(model.displayName ?? model.model),
          String(model.displayName ?? model.model),
        ),
        ...(typeof model.description === 'string' && model.description
          ? { description: text(model.description, model.description) }
          : {}),
      })),
    },
    {
      key: 'model_reasoning_effort',
      group: 'defaults',
      type: 'enum',
      title: text('推理强度', 'Reasoning effort'),
      description: null,
      default:
        typeof current?.defaultReasoningEffort === 'string' ? current.defaultReasoningEffort : null,
      effect: 'newSession',
      options: efforts.map((effort) => ({
        value: String(effort.reasoningEffort),
        title: text(String(effort.reasoningEffort), String(effort.reasoningEffort)),
        ...(typeof effort.description === 'string'
          ? { description: text(effort.description, effort.description) }
          : {}),
      })),
    },
  ]
  // 标准不在模型给的那几档里，要自己补一项：写 default 是明着选标准（上游 SERVICE_TIER_DEFAULT_REQUEST_VALUE）。
  // 不写时用的是模型自己的默认档，有的模型默认就是快速，所以“不选”不等于标准
  if (tiers.length)
    specs.push({
      key: 'service_tier',
      group: 'defaults',
      type: 'enum',
      title: text('速度', 'Speed'),
      description: text(
        '配置里没写时用这个模型自己的默认档，有的模型默认就是快速',
        'When unset, the model’s own default applies, which is Fast on some models',
      ),
      default:
        typeof current?.defaultServiceTier === 'string' ? current.defaultServiceTier : 'default',
      effect: 'newSession',
      options: [
        { value: 'default', title: text('标准', 'Standard') },
        ...tiers.map((tier) => ({
          value: String(tier.id),
          // 快速档（上游 ServiceTier::Fast 发的是 priority）按两种语言说；别的档用它给的名字
          title:
            tier.id === 'priority'
              ? text('快速', 'Fast')
              : text(String(tier.name ?? tier.id), String(tier.name ?? tier.id)),
          ...(typeof tier.description === 'string'
            ? { description: text(tier.description, tier.description) }
            : {}),
        })),
      ],
    })
  return specs
}

/**
 * 全局的上下文设置：config.toml 顶层的三个键（上游 config_toml.rs，0.160 与 0.162 都有）。
 * codex 给每个会话算模型参数时把它们盖在模型自己的设置上（models-manager 的 with_config_overrides）：
 *   - model_context_window 换掉模型的上下文窗口，但不超过模型的 max_context_window；
 *   - model_auto_compact_token_limit 换掉模型的自动压缩门槛，用的时候再压到上下文窗口的 90% 以内（ModelInfo::auto_compact_token_limit）；
 *   - model_auto_compact_token_limit_scope：门槛按整个上下文算（total，默认），还是只算压缩后带过来的那段之后新长的（body_after_prefix）。
 * 配置是建会话时读的，新开的会话就用新值。下限是我们定的：几百个 token 的窗口连系统提示都放不下
 */
const MIN_TOKENS = 1000

function contextSpecs(): Spec[] {
  return [
    {
      key: 'model_context_window',
      group: 'context',
      type: 'integer',
      title: text('上下文窗口（token）', 'Context window (tokens)'),
      description: text(
        '模型一次最多能看多少 token。填了就盖过每个模型自己的上下文窗口，所有模型都用这个数，但不会超过模型允许的上限。不填用各模型自己的。',
        'How many tokens the model can see at once. When set, it overrides every model’s own context window, capped at what each model allows. Leave empty to use each model’s own.',
      ),
      default: null,
      effect: 'newSession',
      minimum: MIN_TOKENS,
    },
    {
      key: 'model_auto_compact_token_limit',
      group: 'context',
      type: 'integer',
      title: text('自动压缩门槛（token）', 'Auto-compact threshold (tokens)'),
      description: text(
        '会话用到这么多 token 时自动压缩历史。填了就盖过每个模型自己的门槛，所有模型都用这个数；不会超过上下文窗口的 90%。不填是上下文窗口的 90%。',
        'Compact the conversation automatically once it uses this many tokens. When set, it overrides every model’s own threshold; it never exceeds 90% of the context window. Leave empty for 90% of the context window.',
      ),
      default: null,
      effect: 'newSession',
      minimum: MIN_TOKENS,
    },
    {
      ...enumSpec(
        'model_auto_compact_token_limit_scope',
        'context',
        ['自动压缩怎么算', 'Auto-compact counts'],
        [
          option('total', '整个上下文', 'The whole context'),
          option(
            'body_after_prefix',
            '只算上次压缩后新增的',
            'Only what grew since the last compaction',
          ),
        ],
        'total',
      ),
      description: text(
        '自动压缩门槛对比的是整个上下文，还是上次压缩后带过来的内容之后新增的部分',
        'Whether the threshold is compared with the whole context, or only with what was added after the carried-over part of the last compaction',
      ),
    },
  ]
}

function permissionSpecs(snapshot: CodexSnapshot): Spec[] {
  const required = snapshot.requirements ?? {}
  const approval = enumSpec(
    'approval_policy',
    'permissions',
    ['审批策略', 'Approval policy'],
    [
      option('untrusted', '不信任的命令先问', 'Ask for untrusted commands'),
      option('on-request', '模型要求时问', 'Ask when the model requests'),
      option('never', '从不问', 'Never ask'),
    ],
    'on-request',
    required.allowedApprovalPolicies,
  )
  // 细分的审批策略（granular）是一张表，这里只认三种整体的
  if (isObject(snapshot.user.approval_policy)) {
    approval.readOnly = true
    approval.readOnlyReason = text(
      '配置里写的是细分的审批策略，请直接改 config.toml',
      'Granular approval policy: edit config.toml directly',
    )
  }
  return [
    approval,
    enumSpec(
      'sandbox_mode',
      'permissions',
      ['沙箱', 'Sandbox'],
      [
        option('read-only', '只读', 'Read only'),
        option('workspace-write', '可写工作目录', 'Workspace write'),
        option('danger-full-access', '不设沙箱', 'Full access'),
      ],
      'read-only',
      required.allowedSandboxModes,
    ),
    boolSpec(
      'sandbox_workspace_write.network_access',
      'permissions',
      ['可写工作目录时允许联网', 'Network access in workspace-write'],
      false,
    ),
  ]
}

function behaviorSpecs(snapshot: CodexSnapshot): Spec[] {
  return [
    enumSpec(
      'web_search',
      'behavior',
      ['网页搜索', 'Web search'],
      [
        option('disabled', '关', 'Off'),
        option('cached', '用缓存的结果', 'Cached'),
        option('live', '实时搜索', 'Live'),
      ],
      null,
      snapshot.requirements?.allowedWebSearchModes,
    ),
    enumSpec(
      'model_verbosity',
      'behavior',
      ['输出详细度', 'Verbosity'],
      [
        option('low', '简短', 'Low'),
        option('medium', '适中', 'Medium'),
        option('high', '详细', 'High'),
      ],
      null,
    ),
    enumSpec(
      'model_reasoning_summary',
      'behavior',
      ['推理摘要', 'Reasoning summary'],
      [
        option('auto', '自动', 'Auto'),
        option('concise', '简要', 'Concise'),
        option('detailed', '详细', 'Detailed'),
        option('none', '不要', 'None'),
      ],
      'auto',
    ),
  ]
}

const FEATURE_MEMORIES = 'memories'

function featureSpec(
  feature: Record<string, unknown>,
  snapshot: CodexSnapshot,
  group: string,
): Spec {
  const name = String(feature.name)
  const title =
    typeof feature.displayName === 'string' && feature.displayName ? feature.displayName : name
  const locked = isObject(snapshot.requirements?.featureRequirements)
    ? (snapshot.requirements.featureRequirements as Record<string, unknown>)[name]
    : undefined
  return {
    key: `features.${segment(name)}`,
    group,
    type: 'boolean',
    title: text(title, title),
    description:
      typeof feature.description === 'string' && feature.description
        ? text(feature.description, feature.description)
        : null,
    default: feature.defaultEnabled === true,
    effect: 'harness',
    ...(typeof locked === 'boolean'
      ? {
          readOnly: true,
          readOnlyReason: text('管理员要求固定了这一项', 'Locked by managed requirements'),
        }
      : {}),
  }
}

const SKILL_SCOPES = new Set(['user', 'system', 'admin'])

function toolSpecs(catalog: Catalog): Spec[] {
  const specs: Spec[] = []
  // 技能：用户级的、codex 自带的、管理员装的（项目里的不管）。配置里是按路径记的 skills.config 列表，写走 skills/config/write
  for (const skill of catalog.skills) {
    if (!SKILL_SCOPES.has(String(skill.scope)) || typeof skill.path !== 'string') continue
    const face = isObject(skill.interface) ? skill.interface : {}
    const title = String(face.displayName ?? skill.name)
    const summary = String(
      face.shortDescription ?? skill.shortDescription ?? skill.description ?? '',
    )
    specs.push({
      key: `skills.${segment(skill.path)}`,
      group: 'tools',
      type: 'boolean',
      title: text(`技能：${title}`, `Skill: ${title}`),
      description: summary ? text(summary, summary) : null,
      default: true,
      effect: 'newSession',
      ...(skill.scope === 'admin'
        ? {
            readOnly: true,
            readOnlyReason: text('管理员装的技能', 'Installed by an administrator'),
          }
        : {}),
      write: { kind: 'skill', path: skill.path },
    })
  }
  for (const plugin of catalog.plugins) {
    const id = String(plugin.id)
    const face = isObject(plugin.interface) ? plugin.interface : {}
    const title = String(face.displayName ?? plugin.name ?? id)
    specs.push({
      key: `plugins.${segment(id)}.enabled`,
      group: 'tools',
      type: 'boolean',
      title: text(`插件：${title}`, `Plugin: ${title}`),
      description: null,
      default: true,
      effect: 'newSession',
    })
  }
  for (const hook of catalog.hooks) {
    if (typeof hook.key !== 'string') continue
    const what =
      hook.handlerType === 'command' ? String(hook.command ?? '') : String(hook.handlerType ?? '')
    const title = `${String(hook.eventName)} · ${what}`
    const managed = hook.isManaged === true
    const locked = managed
      ? { readOnly: true, readOnlyReason: text('管理员下发的 hook', 'Managed hook') }
      : {}
    const base = `hooks.state.${segment(hook.key)}`
    specs.push({
      key: `${base}.enabled`,
      group: 'tools',
      type: 'boolean',
      title: text(`Hook：${title}`, `Hook: ${title}`),
      description: text(String(hook.sourcePath ?? ''), String(hook.sourcePath ?? '')),
      default: true,
      effect: 'newSession',
      ...locked,
    })
    if (managed) continue
    // 信任：codex 只跑信任过的 hook，信任记的是那一刻 hook 内容的哈希（hooks.state.<key>.trusted_hash）
    specs.push({
      key: `${base}.trusted`,
      group: 'tools',
      type: 'boolean',
      title: text(`信任 Hook：${title}`, `Trust hook: ${title}`),
      description:
        hook.trustStatus === 'modified'
          ? text('信任之后内容改过了，要重新信任', 'Changed since it was trusted')
          : null,
      default: false,
      effect: 'newSession',
      write: { kind: 'hookTrust', hookKey: hook.key, hash: String(hook.currentHash ?? '') },
    })
  }
  return specs
}

function memorySpecs(catalog: Catalog, snapshot: CodexSnapshot): Spec[] {
  const specs: Spec[] = []
  const feature = catalog.features.find((item) => item.name === FEATURE_MEMORIES)
  if (feature) {
    const spec = featureSpec(feature, snapshot, 'memory')
    spec.title = text('启用记忆', 'Enable memories')
    specs.push(spec)
  }
  specs.push(
    boolSpec(
      'memories.generate_memories',
      'memory',
      ['从会话里生成记忆', 'Generate memories'],
      true,
    ),
    boolSpec('memories.use_memories', 'memory', ['回答时用记忆', 'Use memories'], true),
    boolSpec(
      'memories.disable_on_external_context',
      'memory',
      ['用了外部上下文时停用', 'Disable with external context'],
      false,
      ['会话里用过 MCP 或网页搜索就不再从它生成记忆', 'Skip threads that used MCP or web search'],
    ),
  )
  return specs
}

/** 实验特性：只列测试阶段（beta）的，和官方桌面端一样；记忆那一项归记忆组 */
function featureSpecs(catalog: Catalog, snapshot: CodexSnapshot): Spec[] {
  return catalog.features
    .filter((feature) => feature.stage === 'beta' && feature.name !== FEATURE_MEMORIES)
    .map((feature) => featureSpec(feature, snapshot, 'features'))
}

/** 原生配置里写了的值：普通的键按路径取用户层；技能、hooks 信任这两种翻译过来 */
function userValue(
  spec: Spec,
  snapshot: CodexSnapshot,
  catalog: Catalog,
): HarnessSettingValue | undefined {
  if (spec.write?.kind === 'skill') {
    const listed = valueAt(snapshot.user, ['skills', 'config'])
    const path = spec.write.path
    const entry = Array.isArray(listed)
      ? listed.find((item) => isObject(item) && item.path === path)
      : undefined
    return isObject(entry) && typeof entry.enabled === 'boolean' ? entry.enabled : undefined
  }
  if (spec.write?.kind === 'hookTrust') {
    const hookKey = spec.write.hookKey
    const hook = catalog.hooks.find((item) => item.key === hookKey)
    if (valueAt(snapshot.user, ['hooks', 'state', hookKey, 'trusted_hash']) === undefined)
      return undefined
    return hook?.trustStatus === 'trusted'
  }
  const value = valueAt(snapshot.user, splitKey(spec.key))
  // 特性在 config.toml 里可以写成表（features.x.enabled），读成开关
  if (spec.key.startsWith('features.') && isObject(value) && typeof value.enabled === 'boolean')
    return value.enabled
  return value === undefined || value === null ? undefined : (value as HarnessSettingValue)
}

export interface CodexSettings {
  snapshot: CodexSnapshot
  catalog: Catalog
  specs: Spec[]
  response: HarnessConfigReadResponse
}

/** litch/harness/config/read */
export async function readCodexSettings(
  ask: Ask,
  harness: string,
  home: string | null,
): Promise<CodexSettings> {
  const [snapshot, catalog] = await Promise.all([
    readSnapshot(ask, harness),
    readCatalog(ask, home),
  ])
  const specs: Spec[] = [
    ...defaultsSpecs(snapshot, catalog.models),
    ...contextSpecs(),
    ...permissionSpecs(snapshot),
    ...behaviorSpecs(snapshot),
    ...featureSpecs(catalog, snapshot),
    ...toolSpecs(catalog),
    ...memorySpecs(catalog, snapshot),
  ]
  const values: Record<string, HarnessSettingValue> = {}
  const overridden: NonNullable<HarnessConfigReadResponse['overridden']> = {}
  for (const spec of specs) {
    const value = userValue(spec, snapshot, catalog)
    if (value !== undefined) values[spec.key] = value
    if (spec.write) continue
    const path = splitKey(spec.key)
    const layer = overridingLayer(snapshot, path)
    const effective = valueAt(snapshot.config, path)
    if (layer && effective !== undefined && effective !== null)
      overridden[spec.key] = { value: effective as HarnessSettingValue, by: layerTitle(layer) }
  }
  const used = new Set(specs.map((spec) => spec.group))
  const files = [{ role: 'settings', path: snapshot.file }]
  if (home) files.push({ role: 'credentials', path: `${home}/auth.json` })
  return {
    snapshot,
    catalog,
    specs,
    response: {
      groups: GROUPS.filter((group) => used.has(group.id)),
      // 线上不带内部用的 write
      settings: specs.map(({ write: _write, ...spec }) => spec),
      values,
      ...(Object.keys(overridden).length ? { overridden } : {}),
      actions: ACTIONS,
      version: snapshot.version,
      files,
      // 模型清单由设备进程替它做（codex-models.mts）
      modelCatalog: true,
    },
  }
}
