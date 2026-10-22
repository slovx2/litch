// 界面看到的“设备服务”：设备上正在运行的那份适配器常驻服务是哪一版、从哪份适配器起的、
// 什么时候起的、怎么起的；本机设备另外有这一次连接时“换没换版本、为什么没换”。
// 为什么要给人看：服务一旦起来，跑的就一直是起它那一刻的那份程序。应用升级之后自带的适配器是新的，
// 后台的可能还是旧的；不摆出来就没人知道。
//
// 三样东西的来处不同：
// - DeviceServiceView 是对面自己报的（聚合面 runtime/info 的 device.service，协议扩展 deviceService），
//   本机、远程都一样读；单个 harness 的入口和原生 codex 不报，是 null。
// - ServiceUpgradeView 只有本机设备有：换版本是外壳连本机时做的事（应用自带的那份适配器对在跑的那份），
//   外壳每次连上之后把结果交进来（DeviceConfig.upgrade）。
// - RemoteUpgradeView 只有远程设备有：在跑的比应用旧时的一键升级（见文件末尾）。
import type { Text } from './phrase.mjs'

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

// ---------- 远程设备的一键升级 ----------
// 远程设备上跑的是那台机器自己装的适配器，应用自动更新换不到它。在跑的比应用旧时，设备详情给一个“升级”：
// 用户确认之后，经 ssh 在那台机器上装应用的这一版，再请服务空闲时停下，重连时起的就是新版。
// 状态和重试由核心记（device/service-upgrade.mts），只在应用里，不进设备；在那台机器上动手的是外壳
// （RemoteUpgradePlatform，desktop 的 ssh/upgrade.mts）。手机端没有这份能力，只显示“比应用旧”。

/** 远程设备上那份适配器是怎么装的：script 安装脚本、brew Homebrew（text/versions.mts 的 installMethodOf） */
export type RemoteInstallMethod = 'script' | 'brew'

/**
 * 没做成的是哪一步：
 * connect 经 ssh 连不上那台机器（原因在 text 里）；fetch 那台机器上没有 curl 也没有 wget；
 * download 下载安装脚本失败（多半连不上 GitHub）；install 安装脚本失败；brew brew upgrade 失败；
 * behind 装完还是旧的（Homebrew 的配方还没跟上这一版）；verify 装完问不出版本，或者版本对不上；
 * unsupported 在跑的服务不认识停止的请求，或者它的控制通道连不上；legacy 在跑的是不带聚合面的旧服务；
 * stop 去停了，没停成；stale 停了、重连上来在跑的还是旧的
 */
export type RemoteUpgradeFailure =
  | 'connect'
  | 'fetch'
  | 'download'
  | 'install'
  | 'brew'
  | 'behind'
  | 'verify'
  | 'unsupported'
  | 'legacy'
  | 'stop'
  | 'stale'

/**
 * 走到了哪一步：
 * idle 还没动手；installing 正在那台机器上装；stopping 正在请服务停下（force：不等它闲，“立即换上”）；
 * reconnecting 服务停了，正在重连（重连时起的就是新版）；
 * waiting 新版装好了，服务不闲，等它闲下来自动换上（busy 是逐条原因，checking 是正在再问一次）；
 * restart 新版装好了，服务有别的东西管着（前台、brew services、systemd），要用户用自己的方式重启；
 * failed 没做成（at 是哪一步）；done 换上了
 */
export type RemoteUpgradePhase =
  | { step: 'idle' }
  | { step: 'installing' }
  | { step: 'stopping'; force: boolean }
  | { step: 'reconnecting' }
  | { step: 'waiting'; busy: ServiceBusyView[]; checking: boolean }
  | { step: 'restart' }
  | {
      step: 'failed'
      at: RemoteUpgradeFailure
      /** connect 时是连不上的原因；别的步骤由界面按 at 说，这里是 null */
      text: Text | null
      /** 远端的原话（安装脚本、brew、device-stop 说的），给“详情”用。没有就是 null */
      detail: string | null
    }
  | { step: 'done'; from: string | null; to: string }

/** 设备详情“设备服务”一节里远程设备那一行：在跑的比应用旧、能不能一键升级、进行到哪一步 */
export interface RemoteUpgradeView {
  /** 要装的版本：应用自己的版本 */
  target: string
  /** 在跑的那一份的版本。它没报（太旧的服务）、还没连上是 null */
  running: string | null
  /** 那台机器上装着的那一份（version 子命令报的）。还没问出来、问不出来是 null */
  installed: string | null
  /** 怎么装的。认不出是 null：不给按钮，只给可复制的命令 */
  method: RemoteInstallMethod | null
  /** 在跑的服务由前台或者服务管理器管着（不是 device-start 拉起的）：只替用户装，不替用户换 */
  managed: boolean
  /** 按钮做什么：upgrade 装新版再换上；swap 装着的已经不旧，只差换上 */
  action: 'upgrade' | 'swap'
  /** 这一端能不能替用户做（外壳给了这份能力）。手机端是 false，只显示“比应用旧” */
  capable: boolean
  phase: RemoteUpgradePhase
}

/** 问一遍那台机器上装着的适配器：在哪（解开链接之后）、报的是哪一版。问不出来的项是 null */
export interface RemoteAdapterFacts {
  version: string | null
  path: string | null
}

/** 在那台机器上装新版的结果。ssh 自己没连上时外壳抛 ConnectError */
export type RemoteInstallResult =
  | { ok: true; installed: string; said: string | null }
  | {
      ok: false
      at: 'fetch' | 'download' | 'install' | 'brew' | 'verify'
      code: number | null
      said: string | null
    }

/**
 * 请服务停下的结果（device-stop 的退出码，见 cmd/codex-harness-adapter/device_stop.go）：
 * stopped 现在没有服务了（停掉了，或者本来就没在跑）；busy 不闲，没停；legacy 在跑的是不带聚合面的旧服务；
 * unsupported 它不认识停止的请求、控制通道连不上；failed 别的（答应了却没退出、命令不认识……）
 */
export type RemoteStopResult =
  | { result: 'stopped' }
  | { result: 'busy'; busy: ServiceBusyView[] }
  | { result: 'legacy' | 'unsupported' | 'failed'; said: string | null }
