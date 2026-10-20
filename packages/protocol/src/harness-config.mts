// harness 详情设置（扩展名 harnessConfig）：每台设备上每个 harness 的配置项、账号与 provider、MCP、用户级指令文件。
// 定义的原文在仓库根目录 protocol/extensions/harness-config.json。
//
// 权威在 harness 自己的原生配置里（~/.codex/config.toml、~/.claude/settings.json、opencode.json、
// ~/.pi/agent/*、~/.dsh/…），和设备上的命令行共用；这里只是按统一的形状读写它们。
// OAuth 登录的凭据留在 harness 自己的存储（钥匙串、各家 auth.json）。API key 官方有地方存的存官方；
// 官方只认环境变量的（Codex 自定义 provider 的 env_key、Claude 的 API key 与网关 token），
// 存在设备设置的 `harness.<id>.env` 里（deviceSettings 扩展，密钥只写不读回），启动 harness 时注入。
//
// 路由：`litch/harness/*` 的请求都带 `harness` 参数，聚合面按它转给那个引擎（routes.mts 的 harness 路由）；
// 原生 codex 不认识这些方法，由设备进程翻译成它自己的 config/*、account/*、mcpServer/*、fs/* 等。
// `litch/device/instructions/*` 由设备进程自己处理（只是文件操作）。
//
// 能不能用：设备信息（`runtime/info` 的 `device.extensions`）里列了 harnessConfig，设备进程才认
// `litch/device/instructions/*` 并替原生 codex 翻译；某个 harness 自己支不支持，看它声明（HarnessDeclaration）
// 的 `extensions` 里有没有 harnessConfig。方法由客户端主动调用，不要求握手时声明；
// 通知只发给握手时在 `capabilities.litchExtensions` 里列了 harnessConfig 的连接。
//
// 这个文件不引用别的文件：设备进程、各引擎、客户端核心都直接引用它。

/** 给人看的字，中文和英文各一份（和 device-settings.mts 的 LocalizedText 同形，这里抄一份免得互相引用） */
export interface HarnessText {
  'zh-CN': string
  en: string
}

export const HARNESS_CONFIG_METHOD = {
  // ---- 配置项 ----
  /** 读这个 harness 的配置项：结构、当前值、版本。结构是动态的（模型列表、实验特性、技能等每次现读） */
  configRead: 'litch/harness/config/read',
  /** 写若干项，要么全写要么全不写。带 expectedVersion，对不上回 versionConflict */
  configWrite: 'litch/harness/config/write',
  /** 执行一个动作（清空记忆之类），动作列在 config/read 的 actions 里 */
  configAction: 'litch/harness/config/action',
  // ---- 账号与 provider ----
  /** 列 provider：每个的登录状态、可用的登录方式、是不是当前在用的 */
  providersRead: 'litch/harness/providers/read',
  /** 新增或修改一个自定义 provider（字段照 providers/read 里 templates 的声明） */
  providersUpsert: 'litch/harness/providers/upsert',
  /** 删掉一个自定义 provider */
  providersRemove: 'litch/harness/providers/remove',
  /** 切换当前在用的 provider（只有 switchable 为 true 的 harness 有） */
  providersActivate: 'litch/harness/providers/activate',
  /** 开始一次登录或设置 API key。应答是第一步；之后的进展也会经 auth/updated 通知 */
  authStart: 'litch/harness/auth/start',
  /** 交上一步要的东西（粘贴的授权码、表单） */
  authContinue: 'litch/harness/auth/continue',
  /** 取消进行中的登录 */
  authCancel: 'litch/harness/auth/cancel',
  /** 登出或清掉这个 provider 的凭据 */
  authLogout: 'litch/harness/auth/logout',
  // ---- MCP ----
  mcpRead: 'litch/harness/mcp/read',
  /** 新增或整条替换一个 MCP 服务 */
  mcpUpsert: 'litch/harness/mcp/upsert',
  mcpRemove: 'litch/harness/mcp/remove',
  /** MCP 服务的 OAuth 登录。应答和通知的形状同 auth/* */
  mcpLogin: 'litch/harness/mcp/login',
  // ---- 指令文件 ----
  /** 读这个 harness 的用户级指令文件（AGENTS.md / CLAUDE.md） */
  instructionsRead: 'litch/harness/instructions/read',
  /** 整个写进去。带 expectedHash，对不上回 versionConflict */
  instructionsWrite: 'litch/harness/instructions/write',
  // ---- 模型清单 ----
  /** 读这个 harness 的自定义模型清单（config/read 的 modelCatalog 为 true 才有） */
  modelsRead: 'litch/harness/models/read',
  /** 整份写入模型清单；entries 为 null 是不用自定义清单、回到 harness 自己的模型目录 */
  modelsWrite: 'litch/harness/models/write',
  // ---- 设备进程自己处理的：统一模式 ----
  /** 把一份正文写进 source，其余各份备份后改成指向它的软链 */
  instructionsUnify: 'litch/device/instructions/unify',
  /** 退出统一模式：软链换回各自的副本 */
  instructionsSeparate: 'litch/device/instructions/separate',
} as const

export const HARNESS_CONFIG_NOTIFICATION = {
  /** 某个 harness 的配置、provider、MCP 或指令文件经这套接口被改了，别的连接该重读。不保证覆盖命令行里的改动 */
  changed: 'litch/harness/config/changed',
  /** 一次登录（auth/start 或 mcp/login 开的）有了新进展 */
  authUpdated: 'litch/harness/auth/updated',
} as const

/** 错误的 data 里 `litch` 的取值。JSON-RPC 的 code 用 -32000 */
export const HARNESS_CONFIG_ERROR_CODE = -32000
export type HarnessConfigErrorReason =
  /** expectedVersion / expectedHash 对不上：重读再改 */
  | 'versionConflict'
  /** 这一项被更高一层（管理员、requirements）锁住了，或者这个 harness 不允许写 */
  | 'readOnly'
  /** 值不合法（类型不对、超范围、不在选项里），message 里说哪一项 */
  | 'invalidValue'
  /** 没有这个键、provider、MCP 服务、动作或登录 */
  | 'notFound'
  /** 登录失败、被取消、超时 */
  | 'authFailed'
  /** 这个 harness 没装或没在跑，读不了它的配置 */
  | 'unavailable'

export interface HarnessConfigErrorData {
  litch: HarnessConfigErrorReason
  /** litch/device/instructions/* 不属于哪个 harness，这时是空串 */
  harness: string
  /** invalidValue、readOnly：哪一项 */
  key?: string
  message?: HarnessText
}

/** 所有 litch/harness/* 请求共有的参数。设备进程转给引擎时 harness 原样带过去（引擎声明了这项扩展，认识它） */
export interface HarnessParams {
  harness: string
}

// ---------- 配置项 ----------

/**
 * 配置项的类型：
 * - boolean、integer、number、string：一个值
 * - text：多行字
 * - enum：单选，值是 options 里某一项的 value；options 可以是动态的（模型列表）
 * - stringList：一列字（权限规则、允许的目录）
 * - path：设备上的路径
 * - secret：密钥。只能写、不能读回，读到的是 `{set: boolean}`
 * - json：结构化的值，界面给一个 JSON 编辑框（少用，没有更合适的类型时才用）
 */
export type HarnessSettingType =
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string'
  | 'text'
  | 'enum'
  | 'stringList'
  | 'path'
  | 'secret'
  | 'json'

export interface HarnessSettingOption {
  value: string
  title: HarnessText
  description?: HarnessText
}

/**
 * 改了之后怎么生效：
 * - none：立刻（下一个回合起）
 * - newSession：新开的会话才生效，已开的不变
 * - harness：要重启这个 harness 才生效。写入应答里 restartRequired 为真，客户端提示后调
 *   deviceSettings 的 `litch/device/harness/restart`（引擎自己不重启自己）
 */
export type HarnessSettingEffect = 'none' | 'newSession' | 'harness'

export interface HarnessSettingSpec {
  /** 键。写入时用它。建议用原生配置里的键路径（`model`、`permissions.defaultMode`），动态项也一样（`features.x`） */
  key: string
  /** 属于哪个分组（HarnessSettingGroup.id） */
  group: string
  type: HarnessSettingType
  title: HarnessText
  description: HarnessText | null
  /** 原生配置里没写时 harness 实际用的值；不知道是 null */
  default: HarnessSettingValue | null
  effect: HarnessSettingEffect
  /** 可以清掉（写 null，删掉这个键回到默认）。不给按 true */
  clearable?: boolean
  /** 只读：被管理员、requirements 锁住，或这一版的 harness 不让写。原因见 readOnlyReason */
  readOnly?: boolean
  readOnlyReason?: HarnessText
  /** integer、number：范围（含两端） */
  minimum?: number
  maximum?: number
  /** enum：可选的值 */
  options?: HarnessSettingOption[]
  /** enum：除了 options 还允许手填（模型名） */
  allowCustom?: boolean
  /** string、text：输入框里的提示 */
  placeholder?: string
}

export type HarnessSettingValue =
  | boolean
  | number
  | string
  | string[]
  | { set: boolean }
  | Record<string, unknown>
  | unknown[]

/**
 * 分组。为了几个 harness 的设置页长得像，常用的组 id 统一用这几个，没有就不出：
 * defaults（默认模型与强度）、permissions（权限与沙箱）、behavior（行为与输出）、tools（技能、插件、hooks）、
 * memory（记忆）、features（实验特性）、network（网络与代理）、advanced（其他）。
 * harness 特有的组自己起 id。
 */
export interface HarnessSettingGroup {
  id: string
  title: HarnessText
  description: HarnessText | null
}

export interface HarnessConfigAction {
  id: string
  group: string
  title: HarnessText
  description: HarnessText | null
  /** 要先确认的，给确认的话；不用确认是 null */
  confirm: HarnessText | null
  danger?: boolean
}

/** 这个 harness 的配置落在哪些文件上，给人看 */
export interface HarnessConfigFile {
  /** settings：主配置；credentials：凭据；mcp、models、instructions 等按 harness 自定 */
  role: string
  path: string
}

export interface HarnessConfigReadResponse {
  /** 顺序就是显示的顺序 */
  groups: HarnessSettingGroup[]
  settings: HarnessSettingSpec[]
  /** 当前值：原生配置里写了的才有；没写的不出现（界面显示 default） */
  values: Record<string, HarnessSettingValue>
  /** 某一项写了但被更高一层盖住，实际不是 values 里那个：这里给实际生效的值和盖住它的层 */
  overridden?: Record<string, { value: HarnessSettingValue; by: HarnessText }>
  actions: HarnessConfigAction[]
  /** 不透明的版本号（各文件内容的哈希之类），写的时候原样带回来 */
  version: string
  files: HarnessConfigFile[]
  /** 这个 harness 有没有模型清单（litch/harness/models/*）。没有这个字段当 false */
  modelCatalog?: boolean
}

export interface HarnessConfigEdit {
  key: string
  /** null：删掉这个键，回到默认 */
  value: HarnessSettingValue | null
}

export interface HarnessConfigWriteParams extends HarnessParams {
  edits: HarnessConfigEdit[]
  expectedVersion: string
}

export interface HarnessConfigWriteResponse {
  version: string
  /** 写进去了但被更高一层盖住的键 */
  overriddenKeys: string[]
  /** 有 effect 为 harness 的项被改了，要重启这个 harness 才生效 */
  restartRequired: boolean
}

export interface HarnessConfigActionParams extends HarnessParams {
  actionId: string
}

// ---------- 账号与 provider ----------

/**
 * 一个 provider 的一种登录方式。
 * - oauthBrowser：在浏览器里授权。远程设备上要回调到设备 127.0.0.1 的，auth 步骤里会给 callbackPort，
 *   客户端负责把它转发过去（ssh -L）；只有桌面端做
 * - oauthDeviceCode：设备码，客户端给用户看网址和码
 * - oauthPaste：在浏览器里授权后把授权码粘贴回来
 * - apiKey：填 key（以及 fields 里声明的别的字段）
 * - env：官方只认环境变量。客户端不经 auth/*，直接把 envName 写进设备设置的 `harness.<id>.env`
 *   （密钥，deviceSettings 扩展），再按 effect 重启；harness 从环境变量里读
 */
export type HarnessAuthMethodKind =
  | 'oauthBrowser'
  | 'oauthDeviceCode'
  | 'oauthPaste'
  | 'apiKey'
  | 'env'

export interface HarnessAuthField {
  id: string
  title: HarnessText
  /** 密钥类的字段，界面遮住、不回显 */
  secret: boolean
  optional?: boolean
  placeholder?: string
  /** 有选项的是下拉 */
  options?: HarnessSettingOption[]
}

export interface HarnessAuthMethod {
  /** 在这个 provider 里唯一，auth/start 时带上 */
  id: string
  kind: HarnessAuthMethodKind
  title: HarnessText
  description: HarnessText | null
  /** apiKey：要填的字段（第一个通常是 key） */
  fields?: HarnessAuthField[]
  /** env：写进 harness.<id>.env 的变量名 */
  envName?: string
  /** env：改了之后怎么生效 */
  effect?: HarnessSettingEffect
}

export interface HarnessProviderAuthState {
  /** 有没有可用的凭据 */
  signedIn: boolean
  /** 凭据是哪种：oauth、apiKey、env（环境变量里有）、none */
  kind: 'oauth' | 'apiKey' | 'env' | 'none'
  /** 给人看的：邮箱、套餐、key 的末四位之类；没有是 null */
  label: string | null
  /** 补充说明（过期了、额度用完了） */
  detail?: HarnessText
}

export interface HarnessProvider {
  id: string
  title: HarnessText
  /** builtin：harness 自带的；custom：用户加的（可以 upsert、remove） */
  kind: 'builtin' | 'custom'
  auth: HarnessProviderAuthState
  methods: HarnessAuthMethod[]
  /** switchable 的 harness 里，是不是当前在用的那个 */
  active: boolean
  /** custom：当前的定义，字段照它所属 template 的声明；密钥字段读到的是 `{set}` */
  definition?: Record<string, HarnessSettingValue>
  /** custom：用的哪个 template */
  templateId?: string
  /** 能不能登出、清凭据 */
  canLogout: boolean
}

/** 新增自定义 provider 的模板（OpenAI 兼容、Anthropic 兼容网关等） */
export interface HarnessProviderTemplate {
  id: string
  title: HarnessText
  description: HarnessText | null
  /** 定义里的字段，形状同配置项（type 只用 string、enum、secret、boolean、stringList） */
  fields: HarnessSettingSpec[]
}

export interface HarnessProvidersReadResponse {
  providers: HarnessProvider[]
  /**
   * 有没有“当前在用的 provider”这回事：Codex（model_provider）、Claude（订阅、API key、网关三选一）、
   * Pi（defaultProvider）是 true；OpenCode 按所选模型决定用哪个，是 false
   */
  switchable: boolean
  templates: HarnessProviderTemplate[]
  version: string
}

export interface HarnessProvidersUpsertParams extends HarnessParams {
  /** 新增时给新的 id（字母数字和 - _）；改已有的给原来的 */
  providerId: string
  templateId: string
  /** 密钥字段不给、或原样交回读到的 `{set}` 表示不改；给空串表示清掉 */
  definition: Record<string, HarnessSettingValue>
  expectedVersion: string
}

export interface HarnessProviderIdParams extends HarnessParams {
  providerId: string
  /** providers/remove：和别的写操作一样可以带上 providers/read 的版本，对不上回 versionConflict；不带不查 */
  expectedVersion?: string
}

export interface HarnessProvidersActivateParams extends HarnessProviderIdParams {
  expectedVersion: string
}

export interface HarnessProvidersWriteResponse {
  version: string
  restartRequired: boolean
}

export interface HarnessAuthStartParams extends HarnessProviderIdParams {
  methodId: string
  /** apiKey：fields 的值 */
  inputs?: Record<string, string>
}

/**
 * 登录的一步。
 * - openUrl：让用户在浏览器里打开 url。callbackPort 不为 null 时，授权完会回调到设备上这个端口，
 *   设备不是本机时客户端要先把本机同一端口转发到设备上
 * - deviceCode：给用户看 url 和 userCode
 * - prompt：要用户填 fields（粘贴授权码就是一个字段），之后调 auth/continue
 * - done：成功，auth 是新的状态
 * - failed：失败或被取消
 * openUrl、deviceCode 之后的进展经 auth/updated 通知（等回调、轮询完成）；也可以同时给 prompt 让用户粘贴
 */
export type HarnessAuthStep =
  | {
      kind: 'openUrl'
      url: string
      callbackPort: number | null
      message: HarnessText | null
      prompt?: HarnessAuthField[]
    }
  | { kind: 'deviceCode'; url: string; userCode: string; message: HarnessText | null }
  | { kind: 'prompt'; fields: HarnessAuthField[]; message: HarnessText | null }
  | { kind: 'done'; auth: HarnessProviderAuthState }
  | { kind: 'failed'; message: HarnessText }

export interface HarnessAuthStartResponse {
  attemptId: string
  step: HarnessAuthStep
}

export interface HarnessAuthContinueParams extends HarnessParams {
  attemptId: string
  inputs: Record<string, string>
}

export interface HarnessAuthAttemptParams extends HarnessParams {
  attemptId: string
}

export interface HarnessAuthUpdatedNotification {
  harness: string
  attemptId: string
  /** provider 登录是 providerId；MCP 登录是 mcp 服务名 */
  providerId?: string
  mcpServer?: string
  step: HarnessAuthStep
}

// ---------- MCP ----------

export type HarnessMcpTransport = 'stdio' | 'http' | 'sse'

export interface HarnessMcpServer {
  name: string
  transport: HarnessMcpTransport
  enabled: boolean
  /** stdio */
  command?: string
  args?: string[]
  cwd?: string
  /**
   * 环境变量。看着像密钥的值（env 和 headers 里都算）读到的是空串，名字列在 secretKeys 里；
   * 写回时这个名字给空串或不给，表示保留原值；要删掉它，从 env / headers 里去掉这个名字，同时也不列进 secretKeys
   */
  env?: Record<string, string>
  secretKeys?: string[]
  /** http、sse */
  url?: string
  headers?: Record<string, string>
  /** 从哪个环境变量取 Bearer token（Codex 的 bearer_token_env_var） */
  bearerTokenEnvVar?: string
  /** 超时、工具白名单黑名单等 harness 特有的字段，原样读写 */
  extra?: Record<string, unknown>
  /** 读到的：连接状态，不知道是 null */
  status?: {
    state: 'connected' | 'failed' | 'needsAuth' | 'disabled' | 'unknown'
    message: string | null
  } | null
}

export interface HarnessMcpReadResponse {
  servers: HarnessMcpServer[]
  transports: HarnessMcpTransport[]
  /** 支不支持 mcp/login */
  oauth: boolean
  /** extra 里可以有哪些字段，形状同配置项 */
  extraFields: HarnessSettingSpec[]
  version: string
  files: HarnessConfigFile[]
}

export interface HarnessMcpUpsertParams extends HarnessParams {
  /** 改名时给原来的名字；新增不给 */
  previousName?: string
  server: HarnessMcpServer
  expectedVersion: string
}

export interface HarnessMcpNameParams extends HarnessParams {
  name: string
}

export interface HarnessMcpRemoveParams extends HarnessMcpNameParams {
  expectedVersion: string
}

export interface HarnessMcpWriteResponse {
  version: string
  restartRequired: boolean
}

// ---------- 指令文件 ----------

export interface HarnessInstructionsInfo {
  /** 这个 harness 读的用户级指令文件（绝对路径） */
  path: string
  /** AGENTS.md 或 CLAUDE.md */
  fileName: string
  exists: boolean
  content: string
  /** 内容的哈希；不存在时是空串。写的时候作为 expectedHash 带回来 */
  hash: string
  /**
   * path 本身是软链时指向哪里：软链里写的目标按它所在的目录解析成绝对路径，不再往下解析一层（不做 realpath，
   * 不然 macOS 上 /var 会变成 /private/var，和统一模式给的 sourcePath 对不上）。不是软链是 null
   */
  linkTarget: string | null
  /** 有更高优先级的文件盖住它（Codex 的 AGENTS.override.md 非空）：那个文件的路径 */
  overriddenBy: string | null
}

export interface HarnessInstructionsWriteParams extends HarnessParams {
  content: string
  expectedHash: string
}

export interface HarnessInstructionsWriteResponse {
  hash: string
}

/**
 * 统一模式：客户端先对每个要统一的 harness 调 instructions/read 拿到 path，再调这个。
 * 设备进程把 content 写进 sourcePath，linkPaths 里每个已经存在的文件（不是已经指向 sourcePath 的软链）
 * 先备份，再换成指向 sourcePath 的软链；父目录不存在的跳过（那个 harness 多半没装）。
 * 建软链失败（Windows 没有权限）的退回写一份副本，结果里标出来。
 */
export interface DeviceInstructionsUnifyParams {
  sourcePath: string
  content: string
  linkPaths: string[]
}

export interface DeviceInstructionsLinkResult {
  path: string
  /** linked：已是软链；copied：建软链失败，写了副本；skipped：父目录不存在 */
  outcome: 'linked' | 'copied' | 'skipped'
  /** 原来的文件备份到哪里；原来没有或原来就是指向 source 的软链是 null */
  backup: string | null
}

export interface DeviceInstructionsUnifyResponse {
  results: DeviceInstructionsLinkResult[]
}

/** 退出统一模式：linkPaths 里指向 sourcePath 的软链换成 sourcePath 当前内容的副本 */
export interface DeviceInstructionsSeparateParams {
  sourcePath: string
  linkPaths: string[]
}

export interface DeviceInstructionsSeparateResponse {
  /** 换掉了的路径 */
  separated: string[]
}

/** litch/harness/config/changed 的参数 */
export interface HarnessConfigChangedNotification {
  harness: string
  /** 哪一块变了 */
  part: 'config' | 'providers' | 'mcp' | 'instructions' | 'models'
}

// ---- 模型清单 ----
// 原生 codex：清单是 model_catalog_json 指向的 JSON 文件，整份替换 codex 自己的模型目录，codex 启动时才读。
// 每个模型在 codex 里有很多字段；这里只让改模型名、显示名和上下文窗口，其余字段照 base 那个模型原样带过去。

/** 模型清单里的一项 */
export interface HarnessModelEntry {
  /** 发给模型服务的模型名（codex 的 slug），清单里唯一 */
  id: string
  /** 显示名；null 用 base 的显示名（没有 base 时用 id） */
  displayName: string | null
  /** 上下文窗口（token）；null 照 base 的 */
  contextWindow: number | null
  /** 照着哪个模型的其余设置（bases 里的 id）；和 id 相同表示原样用那个模型 */
  base: string
}

/** 可以照着的模型 */
export interface HarnessModelBase {
  id: string
  displayName: string
  contextWindow: number | null
  description: string | null
}

export interface HarnessModelsReadResponse {
  /** 在用自定义清单；false 时 harness 用它自己的模型目录，entries 是空的 */
  custom: boolean
  entries: HarnessModelEntry[]
  /** 可以照着的模型（harness 自带的目录），顺序就是显示的顺序 */
  bases: HarnessModelBase[]
  /** 清单存在哪个文件；还没有时是会写到的地方 */
  path: string | null
  /** 不透明的版本号，写的时候原样带回来 */
  version: string
  /** 改了以后什么时候生效 */
  effect: HarnessSettingEffect
  /** 额外的说明（比如清单文件读不出来、被管理员的设置盖住了） */
  note: HarnessText | null
  /** 被更高一层锁住、不能写时给原因 */
  readOnlyReason: HarnessText | null
}

export interface HarnessModelsWriteParams extends HarnessParams {
  /** null 是不用自定义清单（回到 harness 自己的模型目录）；不能是空数组 */
  entries: HarnessModelEntry[] | null
  expectedVersion: string
}

export interface HarnessModelsWriteResponse {
  version: string
  /** effect 为 harness 时为 true，客户端提示后调 litch/device/harness/restart */
  restartRequired: boolean
}
