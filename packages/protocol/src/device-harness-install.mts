// 给设备装 harness（扩展名 harnessInstall）：查各 harness 装没装、装的哪一版、我们验证过的版本、最新版本，
// 按官方的方式在设备上装验证版或最新版。定义的原文在仓库根目录 protocol/extensions/harness-install.json。
//
// 装的动作在适配器的 Go 主进程里跑（它有登记表、用户的登录环境，装完接着重启那个 harness），设备进程只转发，
// 和 deviceSettings 那几个方法同一条控制通道。设备信息的 `extensions` 里列了 harnessInstall 才能用；
// 声明了它的连接才会收到安装进度的通知。
//
// 这个文件不引用别的文件：设备进程、客户端核心都直接引用它。

/** 给人看的字，中文和英文各一份（和 device-settings.mts 的 LocalizedText 同形，这里抄一份免得互相引用） */
export interface InstallText {
  'zh-CN': string
  en: string
}

/** 官方安装方式：官方脚本（Claude、OpenCode），或 npm 全局安装 */
export type HarnessInstallMethod = 'script' | 'npm'

/** 装哪个版本：我们验证过的，或 npm 注册表上的最新版 */
export type HarnessInstallTarget = 'verified' | 'latest'

export const HARNESS_INSTALL_METHOD = {
  /** 各 harness 的版本情况 */
  versions: 'litch/device/harness/versions',
  /** 开始装一个 harness。应答只带任务号，进度看通知 */
  install: 'litch/device/harness/install',
  /** 现在在跑的和每个 harness 最近一次的安装任务（重连后补状态） */
  read: 'litch/device/harness/install/read',
} as const

export const HARNESS_INSTALL_NOTIFICATION = {
  /** 安装任务的状态或日志变了。只发给握手时声明过 harnessInstall 的连接 */
  changed: 'litch/device/harness/install/changed',
} as const

export interface HarnessVersionsParams {
  /** 要不要现查最新版（联网，五秒超时）。不给或 false 时 latest 是上次查到的，没查过是 null */
  latest?: boolean
}

export interface HarnessVersionInfo {
  /** harness 标识（claude-code、pi、codex…） */
  harness: string
  /** 能不能由 Litch 装。自填命令的 acp、这个系统上没有官方方式的都是 false */
  installable: boolean
  method: HarnessInstallMethod | null
  /** 探测到的已装版本；没装、探测不出是 null */
  installed: string | null
  /** 适配器要求的最低版本；没有要求是 null */
  minimum: string | null
  /** 我们验证过的版本；没有记录是 null（界面上只给最新版并标“未验证”） */
  verified: string | null
  /** 最新版；没查、查不到是 null */
  latest: string | null
  /** 查最新版失败的原因 */
  latestError?: InstallText
  /** 官方安装说明的地址 */
  docsUrl: string
  /** 给人复制的官方安装命令（装验证版的那条；没有验证版时是装最新版的那条） */
  manual: string
}

export interface HarnessVersionsResponse {
  harnesses: HarnessVersionInfo[]
}

export interface HarnessInstallParams {
  harness: string
  version: HarnessInstallTarget
}

export interface HarnessInstallResponse {
  job: string
}

export type HarnessInstallState = 'running' | 'succeeded' | 'failed'

export interface HarnessInstallJob {
  job: string
  harness: string
  version: HarnessInstallTarget
  /** 实际要装的版本号（验证版或开始时查到的最新版） */
  resolved: string | null
  state: HarnessInstallState
  /** 真正跑的那条命令，给人看 */
  command: string
  /** 命令输出的末尾，最多 200 行 */
  log: string[]
  /** 开始、结束的时间（毫秒） */
  startedAt: number
  endedAt: number | null
  /** 装好后重新探测到的版本 */
  installed?: string | null
  /** 失败的原因一句话 */
  failure?: InstallText
}

export interface HarnessInstallReadResponse {
  jobs: HarnessInstallJob[]
}

export type HarnessInstallChangedNotification = HarnessInstallJob
