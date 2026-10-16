// 设备详情里“设备服务”一节的判断：这次连接换版本的结果要不要说、说哪一种；不闲的原因各说成哪一句；
// 要用户自己动手时给哪几步、哪几条命令。只有逻辑，不引组件和样式，
// 能直接被测试引用（packages/ui/test/service-logic.test.mjs）。
// 这里只说明怎么办：应用自己从不按进程号去结束谁，也不替用户升级、重启服务。
import type {
  DeviceServiceView,
  DeviceView,
  ServiceBusyView,
  ServiceUpgradeView,
} from '@litch/core'
import type { Args, MessageKey } from '../i18n/index.ts'
import { type GuideStep, RESTART_SERVICE_BREW, UPGRADE_SERVICE_BREW } from './guide.ts'

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
