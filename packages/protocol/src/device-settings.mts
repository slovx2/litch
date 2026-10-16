// 设备配置接口（扩展名 deviceSettings）：读写设备服务的设置、重启 harness、诊断、日志末尾、ssh 配置片段。
// 这里的东西都不是 codex 原有的。定义的原文在仓库根目录 protocol/extensions/device-settings.json，
// 设计见 design/harness-client/03-adapter-device-service.md 第十三节，规矩见第十五节。
//
// 这个文件不引用别的文件：设备进程（packages/device）和客户端核心（packages/core）都直接引用它。
//
// 只在聚合面上有。设备信息（`runtime/info` 的 `device.extensions`）里列了 deviceSettings 才能用：
// 没列说明这个设备服务没有带设置功能的适配器主进程在管它（旧版，或者设备进程是单独起的）。
// 方法由客户端主动调用，不要求握手时声明；通知和下面标了“只发给声明过的连接”的字段，
// 只发给握手时在 `capabilities.litchExtensions` 里列了 deviceSettings 的连接。

// 扩展名登记在 device.mts 的 EXTENSION.deviceSettings。

/** 给人看的字，中文和英文各一份，客户端按自己的语言取 */
export interface LocalizedText {
  'zh-CN': string
  en: string
}

// ---------- 设置的结构 ----------

/**
 * 设置项的类型，决定界面画什么控件、值是什么形状：
 * - boolean：开关，值是 true 或 false
 * - string：一行字
 * - integer：整数，范围看 minimum、maximum
 * - enum：单选，值是 options 里某一项的 value
 * - path：设备上的绝对路径；空串表示没填
 * - env：环境变量表，值是 EnvEntry 的数组
 * - secret：密钥。只能写、不能读回，读到的是 SecretState
 */
export type SettingType = 'boolean' | 'string' | 'integer' | 'enum' | 'path' | 'env' | 'secret'

/** 作用范围：整台设备，或者某一个 harness */
export type SettingScope = { kind: 'device' } | { kind: 'harness'; harness: string }

/**
 * 环境变量表里的一项。
 * 读到的：普通变量是 `{name, value}`；密钥是 `{name, secret: true}`，没有 value。
 * 写入的：`{name, value}` 或 `{name, value, secret: true}`；`{name, secret: true}` 不带 value 表示保留原来的值
 * （原来没有这个密钥就拒绝）。名字看着像密钥的（含 KEY、TOKEN、SECRET、PASSWORD 等），不标也按密钥处理。
 */
export interface EnvEntry {
  name: string
  value?: string
  secret?: boolean
}

/** 密钥读到的样子：只知道设没设过 */
export interface SecretState {
  set: boolean
}

/** 读到的值。类型和设置项的 type 对应 */
export type SettingValue = boolean | number | string | EnvEntry[] | SecretState

export interface SettingOption {
  value: string
  title: LocalizedText
}

export interface SettingSpec {
  /** 键。写入时用它 */
  key: string
  /** 属于哪个分组（SettingGroup.id） */
  group: string
  type: SettingType
  title: LocalizedText
  description: LocalizedText
  scope: SettingScope
  /** 设置里没写过时的值。启动参数（--ssh、--claude-port 等）决定的就是它 */
  default: SettingValue
  /**
   * 改了之后怎么生效。none：立刻；harness：要重启它所属的那个 harness
   * （它没有回合在跑时写入后自动重启，有的话标成待重启）。
   */
  restart: 'none' | 'harness'
  /**
   * 这一项在它的作用范围里担当的角色，没有就是普通的一项。
   * enable：它是所属 harness 的启用开关（scope 是 harness、type 是 boolean，一个 harness 至多一项），
   * 界面可以把它另外放在这个 harness 的标题行上。界面认这个标记，不认键名，也不按声明的先后猜。
   * 以后可能加别的值，不认识的按没有处理。
   */
  role?: 'enable'
  /** integer：取值范围（含两端） */
  minimum?: number
  maximum?: number
  /** enum：可选的值 */
  options?: SettingOption[]
}

export interface SettingGroup {
  id: string
  title: LocalizedText
  description: LocalizedText | null
  scope: SettingScope
}

export interface DeviceSettingsSchema {
  /** 顺序就是显示的顺序 */
  groups: SettingGroup[]
  settings: SettingSpec[]
}

// ---------- 当前值 ----------

/** 给官方 Codex 桌面端的一个 SSH 入口现在的状况 */
export interface SshEntryState {
  harness: string
  /** 设置的现行值 */
  enabled: boolean
  port: number
  /**
   * off：关着；listening：在听；failed：开着但没起来（原因见 reason）；
   * idle：这个 harness 的运行时没在跑，入口也就没起。
   */
  state: 'off' | 'listening' | 'failed' | 'idle'
  reason: {
    /** portUnavailable：端口被占，空出来会自己接上；setupFailed：身份或主机密钥没备好；startFailed：别的原因 */
    kind: 'portUnavailable' | 'setupFailed' | 'startFailed'
    text: LocalizedText
    /** 系统给的原话 */
    detail: string
  } | null
}

/** 环境文件（<状态目录>/env）里的变量：对每个 harness 都生效，优先级在设置之下。只读，要改去改那个文件 */
export interface InheritedEnvEntry {
  name: string
  /** 名字看着像密钥的不给值 */
  value?: string
  secret: boolean
}

export interface DeviceSettingsSnapshot {
  /** 每写入成功一次加一。写入时带上它，对不上就拒绝 */
  version: number
  /** 每个设置项现在的值：设置里写过的，没写过就是默认值。键是 SettingSpec.key */
  values: Record<string, SettingValue>
  /** 设置里写过的键。不在这里面的用的是默认值 */
  explicit: string[]
  /** 设置已经改了、但运行中的进程还是旧配置的 harness。重启它才生效 */
  pendingRestart: string[]
  sshEntries: SshEntryState[]
}

// ---------- 方法 ----------

/** 读设置的结构和当前值 */
export const DEVICE_SETTINGS_READ = 'litch/device/settings/read'

export interface DeviceSettingsReadResponse {
  schema: DeviceSettingsSchema
  snapshot: DeviceSettingsSnapshot
  inheritedEnv: InheritedEnvEntry[]
}

/** 按键写入 */
export const DEVICE_SETTINGS_WRITE = 'litch/device/settings/write'

export interface SettingEdit {
  key: string
  /**
   * 新的值；null 表示清掉，回到默认值。
   * secret 类型写字符串；env 类型写整张表（EnvEntry 的数组）；其余和读到的同形。
   */
  value: boolean | number | string | EnvEntry[] | null
}

export interface DeviceSettingsWriteParams {
  /** 读到的那个版本号。和现在的对不上就整个拒绝，错误里带最新的快照 */
  expectedVersion: number
  /** 要么全部写入，要么一项都不写 */
  edits: SettingEdit[]
}

/**
 * 应答等事情定下来才回：要顺手重新起的 harness 等到它有了结果，SSH 入口等到它写下新的状况
 * （通常不到一秒到几秒，重新起 harness 最长约一分半钟）。
 */
export interface DeviceSettingsWriteResponse {
  /**
   * 定下来之后的现状，不用再等后面的通知来补；和这次写入发的那条 `litch/device/settings/changed` 里的是同一份。
   * 真的要等回合结束才能重启的 harness 照旧在 `pendingRestart` 里。
   */
  snapshot: DeviceSettingsSnapshot
  /** 这次写入真的改了的键 */
  changed: string[]
  /** 因为这次写入已经重新启动（或者启动、停掉）了的 harness：它们当时没有回合在跑 */
  restarted: string[]
}

/** 重启一个 harness，同时把它待重启的设置用上。等到它有了结果才应答，最长约一分半钟 */
export const DEVICE_HARNESS_RESTART = 'litch/device/harness/restart'

/** 适配器主进程眼里一个 harness 的状态。running 之外的同时是 `runtime/info` 里不可用原因的 kind */
export type ManagedHarnessState =
  | 'running'
  | 'starting'
  | 'disabled'
  | 'notInstalled'
  | 'versionTooLow'
  | 'startFailed'
  | 'stopped'

export interface DeviceHarnessRestartParams {
  harness: string
  /** true：有回合在跑也照做。不带时有回合在跑（或者判断不了）就拒绝，原因是 harnessBusy */
  force?: boolean
}

export interface DeviceHarnessRestartResponse {
  harness: string
  state: ManagedHarnessState
  /** 不在运行时的说明 */
  text: LocalizedText | null
  snapshot: DeviceSettingsSnapshot
}

/** 运行诊断。和命令行的 doctor 是同一套检查 */
export const DEVICE_DIAGNOSTICS_RUN = 'litch/device/diagnostics/run'

export interface DeviceDiagnosticsParams {
  /** 只查这一个 harness；不带就全查 */
  harness?: string
}

export interface DiagnosticCheck {
  /** runtime：引擎的命令行和运行环境；terminal：终端；sshEntry：给 Codex 桌面端的 SSH 入口；shell：Windows 上的 bash */
  id: string
  scope: SettingScope
  /** skipped：前面的检查没过，或者这一项不适用 */
  status: 'ok' | 'failed' | 'skipped'
  title: LocalizedText
  /** 没过时的原因和该怎么办；通过时可能有补充说明 */
  detail: LocalizedText | null
  /** 详细的输出在设备上的哪个文件里 */
  logPath: string | null
}

export interface DeviceDiagnosticsResponse {
  /** ISO 8601 */
  ranAt: string
  checks: DiagnosticCheck[]
}

/** 读日志的末尾 */
export const DEVICE_LOGS_READ = 'litch/device/logs/read'

export interface DeviceLogsReadParams {
  /**
   * device：设备进程的日志；service：常驻服务的输出（由客户端拉起时才有）；
   * runtime：某个 harness 的运行日志；diagnostics：某个 harness 的诊断日志。后两种要带 harness。
   */
  source: 'device' | 'service' | 'runtime' | 'diagnostics'
  harness?: string
  /** 最多取末尾这么多字节，默认 65536，最大 1048576 */
  maxBytes?: number
}

export interface DeviceLogsReadResponse {
  /** 日志文件在设备上的路径 */
  path: string
  /** 从整行开始。文件不存在时是空串 */
  text: string
  /** 前面还有没取的内容 */
  truncated: boolean
  /** 文件现在的大小（字节） */
  size: number
}

/** 取给官方 Codex 桌面端用的 ssh 配置片段 */
export const DEVICE_SSH_CONFIG_READ = 'litch/device/sshConfig/read'

export interface SshConfigEntry {
  harness: string
  /** ssh 配置里的别名，例如 codex-harness-adapter-claude */
  alias: string
  port: number
  /** 可以直接贴进 ~/.ssh/config 的一段。给不出来时是 null */
  config: string | null
  /** 给不出来的原因（入口关着、还没初始化过） */
  unavailable: LocalizedText | null
}

export interface DeviceSshConfigResponse {
  entries: SshConfigEntry[]
  /** 给得出来的各段拼在一起 */
  text: string
}

// ---------- 通知 ----------

/**
 * 设置或者 SSH 入口的状况变了。只发给声明过 deviceSettings 的连接。
 * 一次写入从头到尾只发一条：等它定下来、在写入的应答之前发，途中的样子（先标成待重启又摘掉）不发。
 */
export const DEVICE_SETTINGS_CHANGED = 'litch/device/settings/changed'

export interface DeviceSettingsChangedNotification {
  /** 这一次改了的键。只是待重启的名单或 SSH 入口的状况变了时是空数组 */
  keys: string[]
  snapshot: DeviceSettingsSnapshot
}

// `runtime/info` 上跟着这个扩展多出来的东西写在 device.mts 的 HarnessUnavailable 上：
// 不可用原因的 kind 多了适配器主进程给的那几种（就是 ManagedHarnessState 里 running 之外的），
// 声明过 deviceSettings 的连接还会在上面收到 `text`（说明的两种语言版本）。

// ---------- 错误 ----------

/** 这个扩展的方法自己回的错误，原因在 `error.data.litch` 里 */
export const DEVICE_SETTINGS_ERROR_CODE = {
  /** 设置功能现在用不了：没有适配器主进程在管，或者和它的控制通道断了 */
  settingsUnavailable: -32052,
  /** 版本号对不上。`data.snapshot` 是最新的 */
  settingsConflict: -32053,
  /** 键不认识，或者值不合规矩。`data.key` 是哪一项 */
  invalidSetting: -32602,
  /** 那个 harness 有回合在跑（或者判断不了），没有带 force */
  harnessBusy: -32054,
  /** 动作没做成（读不了日志、诊断跑不起来等） */
  deviceActionFailed: -32055,
} as const

export type DeviceSettingsErrorReason = keyof typeof DEVICE_SETTINGS_ERROR_CODE

export interface DeviceSettingsErrorData {
  litch: DeviceSettingsErrorReason
  /** 给人看的说明的两种语言版本；`error.message` 是中文那一份 */
  text?: LocalizedText
  /** invalidSetting：哪一项 */
  key?: string
  /** harnessBusy：哪个 harness */
  harness?: string
  /** settingsConflict：最新的快照 */
  snapshot?: DeviceSettingsSnapshot
}
