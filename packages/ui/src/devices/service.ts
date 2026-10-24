// 设备详情里“设备服务”一节的判断：这次连接换版本的结果要不要说、说哪一种；不闲的原因各说成哪一句；
// 要用户自己动手时给哪几步、哪几条命令。只有逻辑，不引组件和样式，
// 能直接被测试引用（packages/ui/test/service-logic.test.mjs）。
// 应用自己从不按进程号去结束谁。本机换版本由外壳在连接时做；远程设备只在用户点了“升级”、确认之后才替他装、换（见文件末尾）。
import type {
  DeviceServiceView,
  DeviceView,
  RemoteInstallMethod,
  RemoteUpgradeView,
  ServiceBusyView,
  ServiceUpgradeView,
} from '@litch/core'
import type { Args, MessageKey } from '../i18n/index.ts'
import { type GuideStep, RELEASES, RESTART_SERVICE_BREW, UPGRADE_SERVICE_BREW } from './guide.ts'

/**
 * 换版本的结果里值得说的几种：
 * replaced 这次换上了新版；busy 旧而忙，没换；foreground 前台的或者有服务管理器管着，不替用户换；
 * unsupported 太旧，停不了它；failed 去停了没停成。
 * 本来没有服务（launched）、同一版、在跑的更新、版本号比不出先后，都不打扰，只显示版本
 */
export type ServiceNotice = 'replaced' | 'busy' | 'foreground' | 'unsupported' | 'failed'

export function noticeOf(upgrade: ServiceUpgradeView | null): ServiceNotice | null {
  if (!upgrade) return null
  if (upgrade.action === 'replaced') return 'replaced'
  if (upgrade.action !== 'kept') return null
  switch (upgrade.reason) {
    case 'busy':
    case 'foreground':
    case 'unsupported':
    case 'failed':
      return upgrade.reason
    default:
      return null
  }
}

/**
 * 这台设备上在跑的服务比应用自带的旧，而且这次没换成。只有这一种会在设备列表的行上留一个记号。
 * 没连上的设备不算：那是上次连着时的情况，现在在跑的是哪一份不知道
 */
export function staleService(device: DeviceView): boolean {
  if (device.connection !== 'online') return false
  const notice = noticeOf(device.upgrade)
  return notice !== null && notice !== 'replaced'
}

const trimmed = (path: string): string => path.replace(/[/\\]+$/, '')

/**
 * 在跑的这一份是从哪份适配器起的，界面怎么说：
 * bundled 应用自带的那一份；
 * bundledBefore 也是应用自带的那个位置，但它启动之后那里的程序换过了（应用原地升级了，在跑的还是升级前起的）——
 * 只说“应用自带的”会和旁边那行“应用自带 0.7.0”对不上；
 * path 别处的，照实给路径。远程设备没有换版本这一项，说不上是不是自带的，也给路径
 */
export type ServiceOrigin = 'bundled' | 'bundledBefore' | 'path'

export function originOf(
  service: DeviceServiceView,
  upgrade: ServiceUpgradeView | null,
): ServiceOrigin {
  if (upgrade === null || trimmed(service.root) !== trimmed(upgrade.bundled.root)) return 'path'
  const changed =
    service.version !== upgrade.bundled.version ||
    (upgrade.action === 'kept' && upgrade.order === 'rebuilt')
  return changed ? 'bundledBefore' : 'bundled'
}

/** 一句话：哪一句，和里面要填的值 */
export interface Line {
  key: MessageKey
  args: Args
}

/**
 * 换上了新版的那一句：从哪版到哪版。
 * 原来那份没报版本、版本号一样但程序被换过的，各有各的说法——“从 0.7.0 到 0.7.0”不像话
 */
export function replacedLine(upgrade: ServiceUpgradeView): Line {
  const to = upgrade.bundled.version
  if (upgrade.order === 'rebuilt') return { key: 'service.replaced.rebuilt', args: { to } }
  if (upgrade.previous === null) return { key: 'service.replaced.unknown', args: { to } }
  return { key: 'service.replaced', args: { from: upgrade.previous, to } }
}

/**
 * 节标题后面的小标：收着的时候靠它知道有没有事。换上了新版的带上是从哪版换的，
 * 没换成的只说“比应用自带的旧”，原因点开看；没有要说的是 null
 */
export function pillOf(
  upgrade: ServiceUpgradeView | null,
): (Line & { tone: 'ok' | 'wait' }) | null {
  const notice = noticeOf(upgrade)
  if (upgrade === null || notice === null) return null
  if (notice !== 'replaced') return { tone: 'wait', key: 'service.sum.stale', args: {} }
  return upgrade.previous !== null && upgrade.order !== 'rebuilt'
    ? { tone: 'ok', key: 'service.sum.replaced', args: { from: upgrade.previous } }
    : { tone: 'ok', key: 'service.sum.replaced.plain', args: {} }
}

/** 没换成时开头的那一句：在跑的是哪版，应用自带的是哪版 */
export function olderLine(upgrade: ServiceUpgradeView): Line {
  const to = upgrade.bundled.version
  if (upgrade.order === 'rebuilt') return { key: 'service.older.rebuilt', args: { to } }
  if (upgrade.previous === null) return { key: 'service.older.unknown', args: { to } }
  return { key: 'service.older', args: { from: upgrade.previous, to } }
}

/**
 * 不闲的一条原因说成哪一句。harness 的标识换成名字（nameOf），几个名字之间用 comma 隔开。
 * 不认识的原因照原样说出来，不藏
 */
export function busyLine(
  entry: ServiceBusyView,
  nameOf: (harness: string) => string,
  comma: string,
): Line {
  const names = entry.harnesses.map(nameOf).join(comma)
  switch (entry.reason) {
    case 'activeTurns':
      return names
        ? { key: 'service.busy.turns', args: { names } }
        : { key: 'service.busy.turnsUnnamed', args: {} }
    case 'deviceProcesses':
      return { key: 'service.busy.terminals', args: { count: entry.count } }
    case 'clients':
      return { key: 'service.busy.clients', args: { count: entry.count } }
    case 'undetermined':
      return names
        ? { key: 'service.busy.undetermined', args: { names } }
        : { key: 'service.busy.undeterminedUnnamed', args: {} }
    default:
      return { key: 'service.busy.other', args: { reason: entry.reason } }
  }
}

const step = (text: MessageKey, command: string | null = null): GuideStep => ({ text, command })

/**
 * 前台运行的、有服务管理器管着的：它是怎么起的，就照那个办法换。应用分不出是哪一种，三种都说。
 * 两条命令和远程设备“该升级了”时给的是同一份（guide.ts）
 */
export const FOREGROUND_STEPS: readonly GuideStep[] = [
  step('service.foreground.brew', UPGRADE_SERVICE_BREW),
  step('service.foreground.brew.restart', RESTART_SERVICE_BREW),
  step('service.foreground.terminal'),
  step('service.foreground.other'),
]

/**
 * 太旧、停不了的：要用户手工结束它一次。做法照命令行自己说的（device_stop.go：确认是它之后可以直接结束这个进程；
 * 安装脚本 install.sh：等手头的回合结束后 kill 进程号）——先看一眼那个进程号上是不是它，再结束。
 * 进程号是命令行报的；它拿不准（null）就不给命令，不编一个
 */
export function endSteps(pid: number | null): GuideStep[] {
  if (pid === null) return []
  return [
    step('service.unsupported.wait'),
    step('service.unsupported.check', `ps -p ${pid} -o command=`),
    step('service.unsupported.end', `kill ${pid}`),
    step('service.unsupported.after'),
  ]
}

// ---------- 远程设备：在跑的比应用旧时的一键升级 ----------
// 状态由核心记（DeviceView.remoteUpgrade），这里只定说哪一句、给不给按钮、给哪几条命令。

/** 远程那一段要说的是哪一种：older 还没动手；别的照 phase 的 step（stopping 里不等闲的那种是 forcing） */
export type RemoteNotice =
  | 'older'
  | 'installing'
  | 'stopping'
  | 'forcing'
  | 'reconnecting'
  | 'waiting'
  | 'restart'
  | 'failed'
  | 'done'

export function remoteNoticeOf(view: RemoteUpgradeView | null): RemoteNotice | null {
  if (!view) return null
  const { phase } = view
  switch (phase.step) {
    case 'idle':
      return 'older'
    case 'stopping':
      return phase.force ? 'forcing' : 'stopping'
    default:
      return phase.step
  }
}

/**
 * 给不给按钮、叫什么：upgrade 升级；swap 换上新版（装着的已经不旧）。没有按钮是 null：
 * 这一端做不了；正在做；认不出是怎么装的（决 462，只给命令）；只差换上而服务有别的东西管着（决 463）
 */
export function remoteButtonOf(view: RemoteUpgradeView | null): 'upgrade' | 'swap' | null {
  if (!view?.capable) return null
  if (view.phase.step !== 'idle' && view.phase.step !== 'failed') return null
  if (view.action === 'swap') return view.managed ? null : 'swap'
  return view.method === null ? null : 'upgrade'
}

/**
 * 这台设备那一行要不要留记号：远程设备在跑的比应用旧（还没换上，包括正在升级、等着换）。
 * 没连上的不算，和本机一样
 */
export function staleRemote(device: DeviceView): boolean {
  if (device.connection !== 'online') return false
  const notice = remoteNoticeOf(device.remoteUpgrade)
  return notice !== null && notice !== 'done'
}

/**
 * 设备列表的行、侧栏的设备行上那个记号：服务比应用的旧、还没换成（本机是这次没换成，远程是还没升级或者在等着换）。
 * 给的是记号的提示文字；不用留记号时是 null
 */
export function serviceFlagOf(device: DeviceView): MessageKey | null {
  if (staleService(device)) return 'service.flag'
  if (staleRemote(device)) return 'service.remote.flag'
  return null
}

/** 装应用这一版的那一句（确认卡上给人看、没做成时给人复制）。和核心让那台机器跑的是同一件事 */
export function installCommand(method: RemoteInstallMethod, version: string): string {
  return method === 'brew'
    ? UPGRADE_SERVICE_BREW
    : `curl -fsSL ${RELEASES}/download/v${version}/install.sh | sh -s -- --version ${version}`
}

/** 装好之后换上新版的那一句：只在服务闲着时停，下次连接时应用会用新版把它拉起来 */
export const STOP_IF_IDLE = 'codex-harness-adapter device-stop --if-idle'

/** 节标题后面的小标 */
export function remotePillOf(
  view: RemoteUpgradeView | null,
): (Line & { tone: 'ok' | 'wait' }) | null {
  const notice = remoteNoticeOf(view)
  if (view === null || notice === null) return null
  if (notice === 'done') {
    return view.phase.step === 'done' && view.phase.from !== null
      ? { tone: 'ok', key: 'service.sum.replaced', args: { from: view.phase.from } }
      : { tone: 'ok', key: 'service.sum.replaced.plain', args: {} }
  }
  if (notice === 'waiting') return { tone: 'wait', key: 'service.remote.sum.waiting', args: {} }
  return { tone: 'wait', key: 'service.remote.sum.stale', args: {} }
}

/** 开头那一句：在跑的是哪版、应用是哪版 */
export function remoteOlderLine(view: RemoteUpgradeView): Line {
  const to = view.target
  if (view.running === null) return { key: 'service.remote.older.unknown', args: { to } }
  return { key: 'service.remote.older', args: { from: view.running, to } }
}

/** 换上之后那一句 */
export function remoteDoneLine(view: RemoteUpgradeView): Line {
  const { phase } = view
  const to = phase.step === 'done' ? phase.to : view.target
  if (phase.step === 'done' && phase.from !== null) {
    return { key: 'service.remote.done', args: { from: phase.from, to } }
  }
  return { key: 'service.remote.done.plain', args: { to } }
}

/**
 * 要用户自己动手时的那几步：
 * 认不出安装方式：两种装法的命令都给，再给换上的那一句；
 * 装好了而服务有别的东西管着（restart，或者只差换上而有别的东西管着）：用他自己的方式重启；
 * 没做成：照停在哪一步给（装没装成给装的那一句；装成了没换上给换的那一句；太旧停不了给手工结束的几步）。
 * pid 是在跑的服务的进程号（太旧停不了时用），不知道是 null
 */
export function remoteSteps(view: RemoteUpgradeView, pid: number | null): GuideStep[] {
  // 知道是 Homebrew 装的就直说；两种都给的时候 Homebrew 那一条是“如果……”
  const install = (method: RemoteInstallMethod): GuideStep =>
    step(
      method === 'script'
        ? 'service.remote.step.script'
        : view.method === 'brew'
          ? 'service.remote.step.brew.known'
          : 'service.remote.step.brew',
      installCommand(method, view.target),
    )
  const swap = step('service.remote.step.stop', STOP_IF_IDLE)
  const after = step('service.remote.step.after')
  const { phase } = view
  if (
    phase.step === 'restart' ||
    (phase.step === 'idle' && view.action === 'swap' && view.managed)
  ) {
    return [...FOREGROUND_STEPS.filter((entry) => entry.text !== 'service.foreground.brew')]
  }
  if (phase.step === 'idle') {
    if (view.method !== null || !view.capable) return []
    return [install('script'), install('brew'), swap, after]
  }
  if (phase.step !== 'failed') return []
  const method = view.method ?? 'script'
  switch (phase.at) {
    case 'download':
      return [install(method), step('service.remote.step.from'), swap, after]
    case 'connect':
    case 'fetch':
    case 'install':
    case 'brew':
    case 'behind':
    case 'verify':
      return [install(method), swap, after]
    case 'unsupported':
      return endSteps(pid)
    case 'legacy':
      return [
        step('devices.guide.restartService', RESTART_SERVICE_BREW),
        step('devices.guide.restartService.manual'),
      ]
    case 'stop':
    case 'stale':
      return [swap, after]
  }
}
