// harness 详情设置在界面这一头的样子（设备的 harnessConfig 扩展投影过来的，15 号设计）。
// 一台设备上一个 harness 一份：配置项、账号与 provider、MCP、用户级指令文件，外加进行中的登录。
// 结构都是对面声明的，核心不认识哪一项是干什么的，只做转运和校形；形状和协议的差不多是一对一的，差别是：
// - 给人看的字一律是两种语言的 Bilingual（对面给的 HarnessText 同形），可选的都补成 null；
// - 列表、布尔这些可能缺的都补上默认值，界面不用再判断“有没有给”；
// - 每一块（config、providers、mcp、instructions，有模型清单的 harness 还有 models）各自有“正在读、读不成、被别处改过几次”。
import type { ChannelErrorShape } from './channel/protocol.mjs'
import type { Bilingual } from './model.mjs'

/** 配置项的类型。界面不认识的（以后对面加的）按只读画 */
export type HcSettingType =
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

/** 密钥读到的样子：只知道设没设过 */
export interface HcSecretState {
  set: boolean
}

/** 一项的值。密钥是 HcSecretState；json 是任意可以写成 JSON 的值 */
export type HcValue = boolean | number | string | string[] | HcSecretState | unknown

export interface HcOption {
  value: string
  title: Bilingual
  description: Bilingual | null
}

/** none：下一个回合起；newSession：新开的会话才生效；harness：要重启这个 harness */
export type HcEffect = 'none' | 'newSession' | 'harness'

export interface HcSettingSpec {
  key: string
  group: string
  /** 对面声明的类型，原样（不认识的也照给，界面按只读画） */
  type: string
  title: Bilingual
  description: Bilingual | null
  /** 原生配置里没写时实际用的值；不知道是 null */
  default: HcValue | null
  effect: HcEffect
  clearable: boolean
  readOnly: boolean
  readOnlyReason: Bilingual | null
  minimum: number | null
  maximum: number | null
  options: HcOption[]
  allowCustom: boolean
  placeholder: string | null
}

export interface HcGroup {
  id: string
  title: Bilingual
  description: Bilingual | null
}

export interface HcAction {
  id: string
  group: string
  title: Bilingual
  description: Bilingual | null
  /** 要先确认的话；不用确认是 null */
  confirm: Bilingual | null
  danger: boolean
}

export interface HcFile {
  role: string
  path: string
}

export interface HcConfigView {
  groups: HcGroup[]
  settings: HcSettingSpec[]
  /** 原生配置里写了的才有 */
  values: Record<string, HcValue>
  /** 写了但被更高一层盖住的：实际生效的值和盖住它的是谁 */
  overridden: Record<string, { value: HcValue; by: Bilingual }>
  actions: HcAction[]
  version: string
  files: HcFile[]
  /** 这个 harness 有模型清单（models 那一块）。没有时 models 那一块一直是空的 */
  modelCatalog: boolean
}

/** 一次写入的一项。value 是 null：删掉这个键回到默认 */
export interface HcEdit {
  key: string
  value: HcValue | null
}

// ---------- 账号与 provider ----------

export type HcAuthKind = 'oauthBrowser' | 'oauthDeviceCode' | 'oauthPaste' | 'apiKey' | 'env'

export interface HcAuthField {
  id: string
  title: Bilingual
  secret: boolean
  optional: boolean
  placeholder: string | null
  options: HcOption[]
}

export interface HcAuthMethod {
  id: string
  /** 对面声明的种类，原样（不认识的界面不给入口） */
  kind: string
  title: Bilingual
  description: Bilingual | null
  fields: HcAuthField[]
  /** env：写进设备设置 harness.<id>.env 的变量名；别的种类是 null */
  envName: string | null
  effect: HcEffect
}

export interface HcAuthState {
  signedIn: boolean
  kind: 'oauth' | 'apiKey' | 'env' | 'none'
  label: string | null
  detail: Bilingual | null
}

export interface HcProvider {
  id: string
  title: Bilingual
  kind: 'builtin' | 'custom'
  auth: HcAuthState
  methods: HcAuthMethod[]
  active: boolean
  /** custom：当前的定义（密钥字段是 {set}） */
  definition: Record<string, HcValue> | null
  templateId: string | null
  canLogout: boolean
}

export interface HcTemplate {
  id: string
  title: Bilingual
  description: Bilingual | null
  fields: HcSettingSpec[]
}

export interface HcProvidersView {
  providers: HcProvider[]
  switchable: boolean
  templates: HcTemplate[]
  version: string
}

/** 登录的一步（和协议的 HarnessAuthStep 同形，字补成两种语言） */
export type HcAuthStep =
  | {
      kind: 'openUrl'
      url: string
      callbackPort: number | null
      message: Bilingual | null
      /** 授权完也可以把授权码粘贴回来：要填的字段，没有是空的 */
      prompt: HcAuthField[]
    }
  | { kind: 'deviceCode'; url: string; userCode: string; message: Bilingual | null }
  | { kind: 'prompt'; fields: HcAuthField[]; message: Bilingual | null }
  | { kind: 'done'; auth: HcAuthState }
  | { kind: 'failed'; message: Bilingual }

/**
 * 回调转发：openUrl 带着 callbackPort、设备又不是本机时，授权完浏览器会回调到这台电脑的那个端口，
 * 核心先经 ssh -L 把它转到设备上同一个端口。opening：正在起；ready：转好了；failed：没转成（message 是原话）；
 * unavailable：这台桌面端转不了（没有外壳，比如浏览器里的开发预览）
 */
export interface HcForward {
  port: number
  state: 'opening' | 'ready' | 'failed' | 'unavailable'
  message: string | null
}

/** 一次进行中（或刚结束）的登录。provider 的登录有 providerId，MCP 的登录有 mcpServer */
export interface HcAttempt {
  attemptId: string
  providerId: string | null
  mcpServer: string | null
  step: HcAuthStep
  /** 本机设备、不用回调的步骤是 null */
  forward: HcForward | null
  /** 交了粘贴码、表单，正在等对面回下一步 */
  busy: boolean
}

// ---------- MCP ----------

export type HcMcpTransport = 'stdio' | 'http' | 'sse'

export interface HcMcpServer {
  name: string
  transport: HcMcpTransport
  enabled: boolean
  command: string | null
  args: string[]
  cwd: string | null
  /** 密钥类的值读到的是空串，名字在 secretKeys 里 */
  env: Record<string, string>
  secretKeys: string[]
  url: string | null
  headers: Record<string, string>
  bearerTokenEnvVar: string | null
  extra: Record<string, unknown>
  status: {
    state: 'connected' | 'failed' | 'needsAuth' | 'disabled' | 'unknown'
    message: string | null
  } | null
}

export interface HcMcpView {
  servers: HcMcpServer[]
  transports: HcMcpTransport[]
  oauth: boolean
  extraFields: HcSettingSpec[]
  version: string
  files: HcFile[]
}

// ---------- 指令文件 ----------

export interface HcInstructionsView {
  path: string
  fileName: string
  exists: boolean
  content: string
  hash: string
  linkTarget: string | null
  overriddenBy: string | null
}

/** 设备上各 harness 的指令文件一览（统一模式用） */
export interface InstructionsOverview {
  entries: {
    harness: string
    /** 给人看的名字 */
    name: string
    /** 读不到（没装、没在跑、不支持）时是 null，原因在 error */
    info: HcInstructionsView | null
    error: ChannelErrorShape | null
  }[]
  /**
   * 现在是不是统一模式：除了一份真文件，读得到的其余各份都是指向它的软链。是的话给那份真文件的路径和它属于哪个
   * harness；不是是 null
   */
  unified: { sourcePath: string; harness: string | null } | null
}

export interface InstructionsLinkResult {
  path: string
  outcome: 'linked' | 'copied' | 'skipped'
  backup: string | null
}

// ---------- 模型清单 ----------

/**
 * 清单里的一项。base 和 id 相同：原样用 harness 自带目录里的那个模型；不同：以 base 为底稿，
 * 只换模型名（id，发给模型服务的名字）、显示名、上下文窗口，其余照 base
 */
export interface HcModelEntry {
  id: string
  /** null 用底稿的显示名 */
  displayName: string | null
  /** 上下文窗口（token）；null 照底稿的 */
  contextWindow: number | null
  base: string
}

/** 可以照着的模型（harness 自带的目录里的一个） */
export interface HcModelBase {
  id: string
  displayName: string
  contextWindow: number | null
  /** 对面给的原话，不翻译 */
  description: string | null
}

export interface HcModelsView {
  /** 在用自定义清单；false 时用 harness 自带的目录，entries 是空的 */
  custom: boolean
  /** 顺序就是模型选择里的顺序 */
  entries: HcModelEntry[]
  bases: HcModelBase[]
  /** 清单存在哪个文件；还没有时是会写到的地方，说不出是 null */
  path: string | null
  version: string
  effect: HcEffect
  note: Bilingual | null
  /** 被更高一层锁住、不能写的原因；能写是 null */
  readOnlyReason: Bilingual | null
}

// ---------- 主题 ----------

/** 一块数据：读到的、正在读、读不成的原因、被别处改过（收到变化通知后重读）几次 */
export interface HcSlot<T> {
  data: T | null
  loading: boolean
  error: ChannelErrorShape | null
  /** 每次因为别处改了而重读，加一。界面据此知道“我正在改的那块被动过了” */
  revision: number
}

export type HcPart = 'config' | 'providers' | 'mcp' | 'instructions' | 'models'

/**
 * harnessConfig 主题的快照：一台设备上一个 harness 的详情设置。
 * supported：设备和这个 harness 都声明了 harnessConfig。还没连上过是 null；false 时界面说“这个 harness 还不支持”
 */
export interface HarnessConfigTopicView {
  deviceId: string
  harness: string
  supported: boolean | null
  config: HcSlot<HcConfigView>
  providers: HcSlot<HcProvidersView>
  mcp: HcSlot<HcMcpView>
  instructions: HcSlot<HcInstructionsView>
  /** 模型清单。config 的 modelCatalog 为真才去读，不然一直是空的 */
  models: HcSlot<HcModelsView>
  /** 这个 harness 进行中、刚结束的登录 */
  attempts: HcAttempt[]
  /** 经这里改过要重启才生效的东西，还没重启：界面提示并给“重启” */
  restartRequired: boolean
}
