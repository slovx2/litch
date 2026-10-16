// 界面看到的“设备服务”：设备上正在运行的那份适配器常驻服务是哪一版、从哪份适配器起的、
// 什么时候起的、怎么起的；本机设备另外有这一次连接时“换没换版本、为什么没换”。
// 为什么要给人看：服务一旦起来，跑的就一直是起它那一刻的那份程序。应用升级之后自带的适配器是新的，
// 后台的可能还是旧的；不摆出来就没人知道。
//
// 两样东西的来处不同：
// - DeviceServiceView 是对面自己报的（聚合面 runtime/info 的 device.service，协议扩展 deviceService），
//   本机、远程都一样读；单个 harness 的入口和原生 codex 不报，是 null。
// - ServiceUpgradeView 只有本机设备有：换版本是外壳连本机时做的事（应用自带的那份适配器对在跑的那份），
//   外壳每次连上之后把结果交进来（DeviceConfig.upgrade）。远程设备上应用不替用户换，没有这一项。

/** 设备上正在运行的那份设备服务的来历。服务启动时定下来，之后不变 */
export interface DeviceServiceView {
  /** 服务的版本。拿不到版本号的构建报的是 0.0.0-unknown */
  version: string
  /** 它是从哪份适配器起的：那份适配器的根目录，设备上的绝对路径 */
  root: string
  /** 什么时候起的，毫秒时间戳。对面给的时间读不懂就是 null */
  startedAt: number | null
  /** true：按需拉起、脱离出去的。false：在前台运行，或者由服务管理器（brew services、systemd）启动的 */
  detached: boolean
  /** 常驻进程的进程号 */
  pid: number
}

/**
 * 在跑的那一份相对于应用自带的那一份：
 * older 旧、newer 新、same 一样、rebuilt 版本号一样但程序被换过（按旧算）、
 * unknown 在跑的没报自己的来历（按旧算）、incomparable 版本号比不出先后
 */
export type ServiceOrder = 'older' | 'newer' | 'same' | 'rebuilt' | 'unknown' | 'incomparable'

/**
 * 照旧用在跑的那一份，是因为什么：
 * same 就是同一版；newer 在跑的更新，不降级；incomparable 版本号比不出先后；
 * foreground 它是前台运行的，或者有服务管理器管着，应用不替用户换；
 * busy 它不闲；unsupported 它不认识停止的请求（太旧），或者它的控制通道连不上；
 * failed 去停了，没停成
 */
export type ServiceKeptReason =
  | 'same'
  | 'newer'
  | 'incomparable'
  | 'foreground'
  | 'busy'
  | 'unsupported'
  | 'failed'

/** 服务不闲的一条原因 */
export interface ServiceBusyView {
  /**
   * activeTurns 这几个 harness 有回合在跑（或者判断不了）；deviceProcesses 有属于设备的终端在跑；
   * clients 有别的客户端连着；undetermined 设备进程没有应答，判断不了。以后可能有别的值，界面照原样说
   */
  reason: string
  /** 是哪几个 harness（标识）。和个数无关的原因是空的 */
  harnesses: string[]
  /** 几个终端、几个客户端。和个数无关的原因是 0 */
  count: number
}

/** 本机设备：这一次连接时，对“在跑的服务和应用自带的是不是同一版”做了什么 */
export interface ServiceUpgradeView {
  /**
   * launched 本来没有服务，这次拉起的就是应用自带的这一份；
   * replaced 在跑的比自带的旧而且闲着：停掉了，用自带的重新拉起了；
   * kept 照旧用在跑的那一份，原因在 reason 里
   */
  action: 'launched' | 'replaced' | 'kept'
  /** 应用自带的那份适配器：版本，和它在这台电脑上的位置 */
  bundled: { version: string; root: string }
  /**
   * 这次连接之前就在跑的那一份的版本：kept 时是现在连着的，replaced 时是被换掉的。
   * 它没报自己的来历就是 null；launched（之前没有服务）也是 null
   */
  previous: string | null
  /** 之前在跑的相对于自带的。launched 时是 same */
  order: ServiceOrder
  /** kept 的原因。别的情形是 null */
  reason: ServiceKeptReason | null
  /** reason 是 busy 时逐条的原因 */
  busy: ServiceBusyView[]
  /** 命令行的原话（给人看的那一句）。没有就是 null */
  detail: string | null
  /**
   * 现在连着的那份服务的进程号，命令行报的；它拿不准时是 null。
   * 只在要用户手工结束它的时候拿来给命令用，应用自己从不按它去结束谁
   */
  pid: number | null
}

/**
 * 外壳交进来的那一份：本机这次连接换版本的结果，形状照外壳自己记的那份
 * （apps/desktop/src/adapter-upgrade.mts 的 UpgradeOutcome），另加现在连着的服务的进程号。
 * 核心只挑界面用得着的放进 ServiceUpgradeView（projection/service.mts），启动参数、程序文件的戳这些不带过去
 */
export interface ServiceUpgradeReport {
  action: 'launched' | 'replaced' | 'kept'
  running: { version: string } | null
  bundled: { version: string; root: string }
  order: ServiceOrder
  reason: ServiceKeptReason | null
  busy: readonly { reason: string; harnesses: readonly string[]; count: number }[]
  detail: string | null
  pid: number | null
}
