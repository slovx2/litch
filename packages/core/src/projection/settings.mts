// 会话的设置（模型、强度、速度、权限预设）和可选项：协议里的形状 → 界面用的形状，以及反过来怎么发给对面。
import type {
  AskForApproval,
  Config,
  ConfigRequirements,
  Model,
  SandboxPolicy,
  TurnStartParams,
} from '../../../protocol/src/index.mjs'
import type {
  ComposeOptions,
  ModelOption,
  PermissionPreset,
  SessionDefaults,
  SessionMode,
  SessionSettings,
} from '../model.mjs'

const builtin = (id: string, risk: PermissionPreset['risk']): PermissionPreset => ({
  id,
  risk,
  // 标题和说明由界面按标识去说
  title: null,
  note: null,
  confirm: risk === 'high',
  switchable: true,
})

/**
 * 没有能力声明时用的权限预设：Codex 协议内置的三档。
 * harness 声明了自己的预设之后以它的为准。
 */
export const BUILTIN_PERMISSIONS: readonly PermissionPreset[] = [
  builtin(':read-only', 'low'),
  builtin(':workspace', 'medium'),
  builtin(':danger-full-access', 'high'),
]

const SANDBOX_PRESET: Record<string, string> = {
  readOnly: ':read-only',
  workspaceWrite: ':workspace',
  dangerFullAccess: ':danger-full-access',
}

/** thread/start、thread/resume 的应答里和设置有关的那几项 */
export interface SettingsSource {
  model?: string | null
  reasoningEffort?: string | null
  serviceTier?: string | null
  /** 协议里是对象，有的引擎直接给标识 */
  activePermissionProfile?: { id: string } | string | null
  sandbox?: SandboxPolicy | null
  /** 协作模式。这里只认 mode，里面的模型和强度以外面那两项为准 */
  collaborationMode?: { mode?: string | null } | null
}

export const NO_SETTINGS: SessionSettings = {
  model: null,
  effort: null,
  speed: null,
  permission: null,
  mode: null,
}

/** 对面报的协作模式。这一版只认这两种，别的（没报、以后新加的）当不知道 */
export const projectMode = (mode: unknown): SessionMode | null =>
  mode === 'plan' || mode === 'default' ? mode : null

/**
 * presets 是这个 harness 声明的权限预设（没有声明给 null，按内置的三档认）：
 * 对面报的现用权限档是其中一个才算数，否则按沙箱的种类猜是内置的哪一档，猜不出就是 null。
 */
export function projectSettings(
  source: SettingsSource,
  presets: readonly PermissionPreset[] | null = null,
): SessionSettings {
  const profile = source.activePermissionProfile
  const named = typeof profile === 'string' ? profile : profile?.id
  const known = presets ?? BUILTIN_PERMISSIONS
  // 按沙箱猜出来的也得是这个 harness 有的那一档
  const guessed = SANDBOX_PRESET[source.sandbox?.type ?? '']
  const has = (id: string | undefined): id is string =>
    id !== undefined && known.some((preset) => preset.id === id)
  return {
    model: source.model || null,
    effort: source.reasoningEffort || null,
    speed: source.serviceTier || null,
    permission: has(named) ? named : has(guessed) ? guessed : null,
    mode: projectMode(source.collaborationMode?.mode),
  }
}

export function projectModels(models: Model[]): ModelOption[] {
  return models
    .filter((model) => !model.hidden)
    .map((model) => ({
      id: model.model,
      title: model.displayName || model.model,
      efforts: model.supportedReasoningEfforts.map((option) => ({
        id: option.reasoningEffort,
        note: option.description,
      })),
      defaultEffort: model.defaultReasoningEffort || null,
      speeds: model.serviceTiers.map((tier) => ({
        id: tier.id,
        title: tier.name || tier.id,
        note: tier.description,
      })),
      defaultSpeed: model.defaultServiceTier || null,
      isDefault: model.isDefault,
      // 老一些的服务端不报这一项，按收图片算：真不收的话对面会在回合里报错
      acceptsImages: model.inputModalities?.includes('image') ?? true,
    }))
}

/** presets：这个 harness 声明的权限预设。没有声明给 null，用内置的三档。plan：它会不会计划模式 */
export const composeOptions = (
  models: Model[],
  presets: readonly PermissionPreset[] | null = null,
  plan = false,
): ComposeOptions => {
  const hidden = models.filter((model) => model.hidden && model.displayName)
  return {
    models: projectModels(models),
    permissions: [...(presets ?? BUILTIN_PERMISSIONS)],
    plan,
    ...(hidden.length
      ? {
          hiddenTitles: Object.fromEntries(hidden.map((model) => [model.model, model.displayName])),
        }
      : {}),
  }
}

/**
 * 底栏上显示哪一档强度。对面报了就是它；报的是 null 时它用的是这个模型自己的默认档，显示那一档。
 * 依据（原生 codex 0.160.0，隔离的数据目录加回环上的假模型实测）：配置里没写强度、也没人选过时，
 * thread/start、thread/resume 报的强度都是 null，发给模型的却是 model/list 里这个模型的默认档；
 * 某个回合选过强度之后，再载入报的就是选的那一档。上游的源码里也是这样补的（core/src/client.rs 的 build_reasoning）。
 * model：会话现在用的模型在可选项里的那一项，不在清单里就是 undefined（这时也不显示强度）
 */
export const shownEffort = (effort: string | null, model: ModelOption | undefined): string | null =>
  effort ?? model?.defaultEffort ?? null

/**
 * 显式选标准速度时发的值（上游 protocol/src/config_types.rs 的 SERVICE_TIER_DEFAULT_REQUEST_VALUE）。
 * 不能用“不发”或 null 表示标准：那样用的是模型自己的默认档，有的模型默认就是快速（model/list 的 defaultServiceTier）
 */
export const STANDARD_SPEED = 'default'

/**
 * 底栏上显示哪一档速度。对面报了就是它；报的是 null 时用的是模型自己的默认档，模型也没有默认档就是标准。
 * 依据（原生 codex 0.160.0 实测）：没选过速度时 thread/start 报的是 null，选了标准报 "default"，选了快速报 "priority"
 */
export const shownSpeed = (speed: string | null, model: ModelOption | undefined): string =>
  speed ?? model?.defaultSpeed ?? STANDARD_SPEED

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** 配置里的速度写成界面认的标识：上游还认老写法 fast，就是 priority（ServiceTier::from_request_value） */
const speedOf = (value: unknown): string | null => {
  const said = text(value)
  return said === 'fast' ? 'priority' : said
}

/** 两处都没说默认权限档时上游用的那一档 */
const FALLBACK_PERMISSION = ':workspace'

/**
 * 不带设置新建会话时对面会用的模型、强度、权限档，照上游（rust-v0.162.0-alpha.20）的取法：
 * - 模型、强度：管理方下发的新会话默认（requirements.models.newThread，上游由客户端自己套上，
 *   见 tui 的 managed_new_thread_defaults.rs）优先，然后是配置里的 model、model_reasoning_effort。
 * - 权限档：requirements.defaultPermissions，然后是配置里的 default_permissions（Config 摊平出来的一项）；
 *   两处都没说、:workspace 又许用（allowedPermissionProfiles 没给，或者给了而它是 true）时是 :workspace。
 * - 速度：管理方下发的，然后是配置里的 service_tier。都没写是 null，用模型自己的默认档。
 * config 是 null（对面不认识 config/read）时不知道，全是 null。
 */
export function projectDefaults(
  requirements: ConfigRequirements | null,
  config: Config | null,
): SessionDefaults {
  if (!config) return { model: null, effort: null, speed: null, permission: null }
  const managed = requirements?.models?.newThread ?? null
  const allowed = requirements?.allowedPermissionProfiles
  const fallback =
    allowed == null || allowed[FALLBACK_PERMISSION] === true ? FALLBACK_PERMISSION : null
  return {
    model: text(managed?.model) ?? text(config.model),
    effort: text(managed?.modelReasoningEffort) ?? text(config.model_reasoning_effort),
    speed: speedOf(managed?.serviceTier) ?? speedOf(config.service_tier),
    permission:
      text(requirements?.defaultPermissions) ?? text(config.default_permissions) ?? fallback,
  }
}

/**
 * 新建页上显示、建会话时发出去的模型、强度、权限档（协作模式另说）。picks 是用户这次选的和上次记下的，
 * defaults 是对面不带设置新建时会用的（还没问到是 null）。
 * - 模型：选了的；没选是对面的默认（不在清单里也照样是它，会话就用它）；对面没说是清单里标了默认的，再没有是第一个。
 * - 强度：选了的、对面默认的，得是这个模型有的那一档；都不是就是这个模型自己的默认档。
 *   一档也没得选的模型是 null（不发）：它报的默认档不一定是对面认的值，DSH 没配推理档的模型报 off，发了整个选择被拒。
 *   不在清单里的模型不知道它有哪几档，选了的、默认的照用。
 * - 速度：选了的、对面默认的，得是标准或者这个模型有的那一档；都不是就是 null（不发，用模型自己的默认档）。
 *   不在清单里的模型不知道它有哪几档，不发。
 * - 权限档：选了的，然后是对面默认的，得是这个 harness 有的那一档；都不是就是 null（不显示哪一档，也不发）。
 */
export function newSessionSettings(
  picks: Partial<SessionSettings>,
  defaults: SessionDefaults | null,
  options: ComposeOptions,
): Omit<SessionSettings, 'mode'> {
  const listed = (id: string | null | undefined) =>
    id ? options.models.find((entry) => entry.id === id) : undefined
  const guessed = options.models.find((entry) => entry.isDefault) ?? options.models[0]
  const model = listed(picks.model)?.id ?? defaults?.model ?? guessed?.id ?? null
  const option = listed(model)
  const fits = (effort: string | null | undefined): effort is string =>
    Boolean(effort) && (!option || option.efforts.some((entry) => entry.id === effort))
  const effort =
    [picks.effort, defaults?.effort].find(fits) ??
    (option?.efforts.length ? option.defaultEffort : null)
  const offered = (speed: string | null | undefined): speed is string =>
    Boolean(option?.speeds.length) &&
    (speed === STANDARD_SPEED || Boolean(option?.speeds.some((entry) => entry.id === speed)))
  const speed = [picks.speed, defaults?.speed].find(offered) ?? null
  const has = (id: string | null | undefined): id is string =>
    Boolean(id) && options.permissions.some((preset) => preset.id === id)
  const permission = [picks.permission, defaults?.permission].find(has) ?? null
  return { model, effort, speed, permission }
}

/** 内置预设只切文件权限，审批策略要一起给，不然会沿用上一档的 */
const approvalFor = (preset: string): AskForApproval =>
  preset === ':danger-full-access' ? 'never' : 'on-request'

type TurnOverrides = Partial<
  Pick<
    TurnStartParams,
    'model' | 'effort' | 'serviceTier' | 'permissions' | 'approvalPolicy' | 'collaborationMode'
  >
>

/**
 * 用户改过、还没告诉对面的设置，写成 turn/start 的参数。没改的不带，对面沿用它自己的。
 * declared：这个 harness 声明了自己的权限预设。那样就只发预设的标识，配套的审批策略、沙箱由对面自己配
 * （适配器的引擎自己映射，原生 codex 由设备进程补）；没有声明时是内置的三档，审批策略要这边一起给。
 */
export function turnOverrides(
  pending: Partial<SessionSettings>,
  declared = false,
  current: SessionSettings = NO_SETTINGS,
): TurnOverrides {
  const overrides: TurnOverrides = {}
  if (pending.model) overrides.model = pending.model
  if (pending.effort) overrides.effort = pending.effort
  if (pending.speed) overrides.serviceTier = pending.speed
  if (pending.permission) {
    overrides.permissions = pending.permission
    if (!declared) overrides.approvalPolicy = approvalFor(pending.permission)
  }
  // 协作模式在协议里连着模型和强度一起给，原生 codex 上它们比外面那两项优先：带上会话现在用的，不能空着。
  // 还不知道模型的时候不带（留到知道了再发），免得把模型冲成空的
  const model = pending.model ?? current.model
  if (pending.mode && model) {
    overrides.collaborationMode = {
      mode: pending.mode,
      settings: {
        model,
        reasoning_effort: pending.effort ?? current.effort ?? null,
        developer_instructions: null,
      },
    }
  }
  return overrides
}

/** 想要的设置里，和对面现在的不一样的那几项 */
export function settingsDiff(
  wanted: Partial<SessionSettings>,
  actual: SessionSettings,
): Partial<SessionSettings> {
  const diff: Partial<SessionSettings> = {}
  for (const key of ['model', 'effort', 'speed', 'permission'] as const) {
    const value = wanted[key]
    if (value && value !== actual[key]) diff[key] = value
  }
  if (wanted.mode && wanted.mode !== actual.mode) diff.mode = wanted.mode
  return diff
}
