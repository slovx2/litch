// 设备与 harness 管理：界面看到的数据形状。
// 设置有哪些、各是什么类型，由设备服务声明；核心原样转给界面，界面按类型画控件，哪一项都不认识。
// 所以这里的形状和协议里的差不多是一对一的，差别只有两处：
// - 给人看的字是两种语言各一份（Bilingual），核心不挑，界面按当前的语言取；
// - 已保存的密钥在这里没有值，只有“设没设过”。对面本来就不读回，核心转的时候再剥一遍（projection/manage.mts）。
import type { Bilingual, HarnessId } from './model.mjs'

/** 一项设置管的是整台设备，还是某一个 harness */
export type SettingScopeView = { kind: 'device' } | { kind: 'harness'; harness: HarnessId }

/**
 * 环境变量表里的一项。
 * 读到的：普通变量有 value；密钥没有 value，secret 为真，这就是“已设置”。
 * 界面改完交回来的：新填的值放在 value 里；密钥不带 value 表示保留原来的值。
 */
export interface EnvEntryView {
  name: string
  value?: string
  secret?: boolean
}

/** 密钥类设置读到的样子：只知道设没设过 */
export interface SecretStateView {
  set: boolean
}

/**
 * 一项设置现在的值，形状跟着它的类型走：开关是真假，整数是数，一行字、单选、路径是字符串，
 * 环境变量表是 EnvEntryView 的数组，密钥是 SecretStateView。
 * 这一版客户端不认识的类型：是简单的值（真假、数、字符串）就照给，别的一律是 null，不往界面上放。
 */
export type SettingValueView = boolean | number | string | EnvEntryView[] | SecretStateView | null

export interface SettingOptionView {
  value: string
  title: Bilingual
}

export interface SettingSpecView {
  /** 键。写入时用它 */
  key: string
  /** 属于哪个分组（SettingGroupView.id） */
  group: string
  /**
   * 设备服务声明的类型，决定画什么控件：boolean、string、integer、enum、path、env、secret。
   * 以后设备服务可能加新的类型，界面不认识的按只读画并说明
   */
  type: string
  title: Bilingual
  description: Bilingual
  scope: SettingScopeView
  /** 设置里没写过时的值 */
  default: SettingValueView
  /** 改了之后怎么生效。none：立刻；harness：要重启它所属的那个 harness */
  restart: 'none' | 'harness'
  /**
   * 设备服务给这一项标的角色，没标就是 null。enable：它是所属 harness 的启用开关，
   * 界面把它另外放在那个 harness 的标题行上。这是界面认“哪一项是启用”的唯一依据：
   * 不认键名，也不看它排在第几。设备服务以后加的别的角色，这一版不认识的一律当作没标
   */
  role: 'enable' | null
  /** 整数的取值范围（含两端）。没有限制就是 null */
  minimum: number | null
  maximum: number | null
  /** 单选能选的值。别的类型是空的 */
  options: SettingOptionView[]
}

export interface SettingGroupView {
  id: string
  title: Bilingual
  description: Bilingual | null
  scope: SettingScopeView
}

/** 给官方 Codex 桌面端的一个 SSH 入口现在的状况 */
export interface SshEntryView {
  harness: HarnessId
  enabled: boolean
  port: number
  /**
   * off：关着；listening：在听；failed：开着但没起来（原因见 reason）；idle：这个 harness 的运行时没在跑，入口也就没起。
   * 设备服务以后加了新的状态，界面按“不知道”显示
   */
  state: string
  reason: {
    /** portUnavailable：端口被占；setupFailed：身份或主机密钥没备好；startFailed：别的原因 */
    kind: string
    text: Bilingual
    /** 系统给的原话 */
    detail: string
  } | null
}

/** 环境文件里的变量：对每个 harness 都生效，优先级在设置之下。只读 */
export interface InheritedEnvView {
  name: string
  /** 名字看着像密钥的没有值 */
  value?: string
  secret: boolean
}

/** 设置现在的值，整份 */
export interface SettingsSnapshotView {
  /** 每写入成功一次加一。写入时带上它，对不上就拒绝 */
  version: number
  /** 每个设置项现在的值，键是 SettingSpecView.key */
  values: Record<string, SettingValueView>
  /** 设置里写过的键。不在这里面的用的是默认值 */
  explicit: string[]
  /** 设置已经改了、但运行中的进程还是旧配置的 harness：重启它才生效 */
  pendingRestart: HarnessId[]
  sshEntries: SshEntryView[]
}

/** 一台设备的管理数据：设置的结构、现在的值、环境文件里的变量 */
export interface ManageView {
  deviceId: string
  /** 顺序就是显示的顺序 */
  groups: SettingGroupView[]
  settings: SettingSpecView[]
  snapshot: SettingsSnapshotView
  inheritedEnv: InheritedEnvView[]
}

/**
 * 要写入的一项。value 给 null 表示清掉，回到默认值。
 * 密钥类写字符串；环境变量表写整张表（EnvEntryView 的数组）；其余和读到的同形。
 */
export interface SettingEditView {
  key: string
  value: boolean | number | string | EnvEntryView[] | null
}

/** 一次写入的结果 */
export interface SettingsWriteResult {
  /** 这次写入真的改了的键 */
  changed: string[]
  /** 因为这次写入已经重新启动（或者启动、停掉）了的 harness */
  restarted: HarnessId[]
  /** 写完之后还等着重启的 harness：它们有回合在跑，没有去打断 */
  pendingRestart: HarnessId[]
}

/** 重启一个 harness 的结果 */
export interface HarnessRestartResult {
  /** 重启之后它在不在运行 */
  running: boolean
  /** 不在运行时设备服务的说明 */
  text: Bilingual | null
}

/** 诊断里的一项检查 */
export interface DiagnosticCheckView {
  /** 这一项查的是什么（runtime、terminal、sshEntry 等）。只用来区分，给人看的是 title */
  id: string
  scope: SettingScopeView
  /** ok：通过；failed：没过；skipped：前面的检查没过，或者这一项不适用。别的值按“不知道”显示 */
  status: string
  title: Bilingual
  /** 没过时的原因和该怎么办；通过时可能有补充说明 */
  detail: Bilingual | null
  /** 详细的输出在设备上的哪个文件里 */
  logPath: string | null
}

export interface DiagnosticsView {
  /** 毫秒时间戳。设备服务给的时间认不出来时是 null */
  ranAt: number | null
  checks: DiagnosticCheckView[]
}

/**
 * 读哪份日志。device：设备进程的输出；service：常驻服务的输出；control：控制通道的请求摘要；
 * requests：设备进程的连接和请求摘要。
 * 要说是哪个 harness 的：runtime（运行日志）、diagnostics（诊断日志）、rpc（入口的协议请求摘要）、
 * debug（Claude 入口的调试日志）、agent（ACP agent 的输出）
 */
export type LogSource =
  | 'device'
  | 'service'
  | 'control'
  | 'requests'
  | 'runtime'
  | 'diagnostics'
  | 'rpc'
  | 'debug'
  | 'agent'

/** 日志的末尾 */
export interface LogTailView {
  /** 日志文件在设备上的路径 */
  path: string
  /** 从整行开始。文件不存在时是空串 */
  text: string
  /** 前面还有没取的内容 */
  truncated: boolean
  /** 文件现在的大小（字节） */
  size: number
  /** 设备上的日志目录。旧版的设备服务不报，是 null */
  directory: string | null
}

/** 给官方 Codex 桌面端用的 ssh 配置片段 */
export interface SshConfigView {
  entries: {
    harness: HarnessId
    /** ssh 配置里的别名 */
    alias: string
    port: number
    /** 可以直接贴进 ~/.ssh/config 的一段。给不出来时是 null */
    config: string | null
    /** 给不出来的原因（入口关着、还没初始化过） */
    unavailable: Bilingual | null
  }[]
  /** 给得出来的各段拼在一起。一段都给不出来时是空串 */
  text: string
}
