// 模拟核心里“设备服务”的样例：各台设备上在跑的是哪一份，和本机换版本的几种情形。全是编出来的。
// 哪句话演哪一出、“再试一次”怎么演在 mock-service.mts；界面看到的形状在 model-service.mts。
import type { DeviceServiceView, ServiceBusyView, ServiceUpgradeView } from '../model-service.mjs'
import type { SampleLang } from './sample-text.mjs'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 样例里的三个版本：应用自带的、比它旧的、比它新的 */
export const SERVICE_VERSIONS = { bundled: '0.7.0', older: '0.6.0', newer: '0.8.0' } as const

/** 应用自带的那份适配器在哪 */
const BUNDLED_ROOT = '/Applications/Litch.app/Contents/Resources/adapter'
/** Homebrew 装的那一份：演“前台运行或者服务管理器管着”时用 */
const BREW_ROOT = '/opt/homebrew/opt/codex-harness-adapter/libexec'
/** 另外装的、比应用带的新的那一份 */
const NEWER_ROOT = '/Users/dev/.local/share/codex-harness-adapter/0.8.0/libexec'
/** 远程那台机器上独立安装的那一份 */
const REMOTE_ROOT = '/home/dev/.local/share/codex-harness-adapter/0.7.0/libexec'
const LOCAL_PID = 4821

const BUNDLED = { version: SERVICE_VERSIONS.bundled, root: BUNDLED_ROOT }

/** 本机能演的几出。没有的那一种（一样的版本）就是一开始的样子 */
export type ServiceScene = 'replaced' | 'busy' | 'foreground' | 'unsupported' | 'failed' | 'newer'

/** 话里带哪些字样演哪一出，中文和英文各一种说法 */
export const SERVICE_SCENES: readonly (readonly [RegExp, ServiceScene])[] = [
  [/服务换了新版|service was replaced/i, 'replaced'],
  [/服务旧而忙|service is busy/i, 'busy'],
  [/服务是前台的|service in the foreground/i, 'foreground'],
  [/服务太旧|service is too old/i, 'unsupported'],
  [/服务没停成|service would not stop/i, 'failed'],
  [/服务比应用新|service is newer/i, 'newer'],
]

/** 命令行的原话，照它真的会说的样子编的。语言跟界面的（真的命令行也是） */
const SAID: Record<SampleLang, { unsupported: string; failed: string }> = {
  'zh-CN': {
    unsupported: `这个状态目录上有服务在运行，但这条命令停不了它：它不认识停止的请求（它比 device-stop 这条命令出现得早）；它自己记下的进程号是 ${LOCAL_PID}，确认是它之后可以直接结束这个进程`,
    failed: `常驻服务（进程 ${LOCAL_PID}）答应了停止，但 45s 内没有退出。可以再运行一次 device-stop 看它退了没有`,
  },
  en: {
    unsupported: `A service is running on this state directory, but this command cannot stop it: it does not understand the stop request (it predates the device-stop command); the process id it recorded is ${LOCAL_PID} — once you have confirmed that is the service, end that process directly`,
    failed: `the service (process ${LOCAL_PID}) agreed to stop but did not exit within 45s. Run device-stop again to see whether it has exited`,
  },
}

export interface SampleService {
  service: DeviceServiceView | null
  upgrade: ServiceUpgradeView | null
}

const running = (
  now: number,
  fields: Partial<DeviceServiceView> & { ageMs: number },
): DeviceServiceView => ({
  version: fields.version ?? SERVICE_VERSIONS.older,
  root: fields.root ?? BUNDLED_ROOT,
  startedAt: now - fields.ageMs,
  detached: fields.detached ?? true,
  pid: fields.pid ?? LOCAL_PID,
})

const kept = (fields: Partial<ServiceUpgradeView>): ServiceUpgradeView => ({
  action: 'kept',
  bundled: BUNDLED,
  previous: SERVICE_VERSIONS.older,
  order: 'older',
  reason: null,
  busy: [],
  detail: null,
  pid: LOCAL_PID,
  ...fields,
})

/** 本机一开始的样子：在跑的就是应用自带的那一份，三个小时前按需拉起的。没什么要对人说的 */
export function sampleLocalService(now: number): SampleService {
  return {
    service: running(now, { version: SERVICE_VERSIONS.bundled, ageMs: 3 * HOUR }),
    upgrade: kept({ previous: SERVICE_VERSIONS.bundled, order: 'same', reason: 'same' }),
  }
}

/** 远程那台设备上的：独立安装的一份，由服务管理器启动。远程设备没有“换版本”这回事 */
export function sampleRemoteService(now: number): DeviceServiceView {
  return running(now, {
    version: SERVICE_VERSIONS.bundled,
    root: REMOTE_ROOT,
    detached: false,
    pid: 1203,
    ageMs: 2 * DAY,
  })
}

/**
 * 本机上演的一出。busy 是“因为忙没换”时逐条的原因，别的情形用不着。
 * 每一出都把在跑的服务一起换成对得上的样子：换了新版的是刚起的，没换成的还是旧的那一份
 */
export function sampleScene(
  scene: ServiceScene,
  now: number,
  lang: SampleLang,
  busy: ServiceBusyView[] = [],
): SampleService {
  switch (scene) {
    case 'replaced':
      return {
        service: running(now, { version: SERVICE_VERSIONS.bundled, pid: LOCAL_PID + 86, ageMs: 0 }),
        upgrade: kept({ action: 'replaced', pid: LOCAL_PID + 86 }),
      }
    case 'busy':
      return {
        service: running(now, { ageMs: 26 * HOUR }),
        upgrade: kept({ reason: 'busy', busy }),
      }
    case 'foreground':
      return {
        service: running(now, { root: BREW_ROOT, detached: false, ageMs: 9 * DAY }),
        upgrade: kept({ reason: 'foreground' }),
      }
    case 'unsupported':
      // 太旧的服务连自己的来历都不报：版本不知道，只有命令行给的进程号和它的原话
      return {
        service: null,
        upgrade: kept({
          previous: null,
          order: 'unknown',
          reason: 'unsupported',
          detail: SAID[lang].unsupported,
        }),
      }
    case 'failed':
      return {
        service: running(now, { ageMs: 5 * DAY }),
        upgrade: kept({ reason: 'failed', detail: SAID[lang].failed }),
      }
    case 'newer':
      return {
        service: running(now, {
          version: SERVICE_VERSIONS.newer,
          root: NEWER_ROOT,
          ageMs: 40 * 60_000,
        }),
        upgrade: kept({ previous: SERVICE_VERSIONS.newer, order: 'newer', reason: 'newer' }),
      }
  }
}
