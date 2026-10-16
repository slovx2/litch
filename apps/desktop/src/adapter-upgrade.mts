// 本来就在跑的那份设备服务，和应用自带的那份适配器是不是同一版；不是的话算谁新。
// 这里只有规则，不碰进程：读 device-start 就绪行里的两份来历、比版本、读 device-stop 报的忙闲。
// 拿规则去停服务、重新拉起的是 local-adapter.mts；命令行那一头的约定见
// cmd/codex-harness-adapter/device_start.go、device_stop.go。
//
// 为什么要比：服务是常驻的，一旦起来跑的就一直是起它那一刻的那份程序。应用升级之后自带的适配器是新的，
// 后台的还是旧的；不换的话新界面配旧服务，没人知道。
//
// 版本怎么比（compareService）：
//   1. 在跑的没报自己的来历（它比这项功能出现得早）：unknown，按旧算。
//   2. 两边的版本号都按语义化版本读（主.次.修订，可以带 -预发布 和 +构建信息）。数字逐段比；
//      带预发布的比不带的旧（1.2.0-rc.1 < 1.2.0）；预发布按点分开逐段比，数字段按数值，别的按字符，
//      数字段比非数字段旧，前面都一样时段数少的旧；+ 后面的构建信息不参加比较。
//      拿不到版本号的构建报的是 0.0.0-unknown，照这套规则它比任何正式版本都旧。
//   3. 有一边读不成语义化版本：字面完全一样算 same，否则 incomparable，不换（不知道谁新就不动）。
//   4. 版本号一样时再看程序文件的戳：两边是同一个根目录、戳都有而且不一样，说明服务起来之后那份程序被换过了
//      （开发时反复构建版本号不变，应用原地升级而适配器版本号没动，都是这样），算 rebuilt，按旧算。
//      根目录不同的两份不比戳：戳只说明“是不是同一个文件”，说明不了谁新。

/** 正在运行的那份服务的来历：就绪行的 service */
export interface ServiceFacts {
  pid: number
  version: string
  /** 它是从哪份适配器起的 */
  root: string
  startedAt: string
  /** true：device-start 按需拉起、脱离出去的。false：前台运行，或者由服务管理器启动的 */
  detached: boolean
  /** 那份适配器的程序文件的戳，只用来比是不是同一个。没有就是 null */
  build: string | null
  /** 它启动时带的参数（SSH 入口开没开、端口）。换版本时原样带上，不替用户改主意 */
  options: string[]
}

/** 执行命令的这一份适配器（也就是应用自带的）：就绪行的 cli */
export interface CliFacts {
  version: string
  root: string
  build: string | null
}

/**
 * 在跑的相对于自带的：
 * older 旧、newer 新、same 一样、rebuilt 版本号一样但程序被换过、
 * unknown 在跑的没报来历、incomparable 版本号比不出先后
 */
export type VersionOrder = 'older' | 'newer' | 'same' | 'rebuilt' | 'unknown' | 'incomparable'

/** 这个结论是不是“在跑的该换成自带的” */
export const outdated = (order: VersionOrder): boolean =>
  order === 'older' || order === 'rebuilt' || order === 'unknown'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOr = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/** 读就绪行里的 service。没有、不成样子，都是 null：当作它没报 */
export function parseServiceFacts(value: unknown): ServiceFacts | null {
  if (!isRecord(value)) return null
  const { pid, version, root, startedAt, detached, options } = value
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    typeof version !== 'string' ||
    version === '' ||
    typeof root !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof detached !== 'boolean'
  ) {
    return null
  }
  const given = Array.isArray(options) ? options : []
  return {
    pid,
    version,
    root,
    startedAt,
    detached,
    build: textOr(value.build),
    options: given.filter((item): item is string => typeof item === 'string'),
  }
}

/** 读就绪行里的 cli。读不懂是 null */
export function parseCliFacts(value: unknown): CliFacts | null {
  if (!isRecord(value)) return null
  const { version, root } = value
  if (typeof version !== 'string' || version === '' || typeof root !== 'string') return null
  return { version, root, build: textOr(value.build) }
}

interface Version {
  core: [number, number, number]
  /** 预发布的各段。没有预发布是空的 */
  pre: string[]
}

const VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(text: string): Version | null {
  const found = VERSION.exec(text.trim())
  if (!found) return null
  return {
    core: [Number(found[1]), Number(found[2]), Number(found[3])],
    pre: found[4] ? found[4].split('.') : [],
  }
}

const sign = (value: number): -1 | 0 | 1 => (value < 0 ? -1 : value > 0 ? 1 : 0)

/** 预发布的一段和另一段比 */
function comparePart(left: string, right: string): -1 | 0 | 1 {
  const numeric = /^\d+$/
  const [a, b] = [numeric.test(left), numeric.test(right)]
  if (a && b) return sign(Number(left) - Number(right))
  // 数字段比非数字段旧
  if (a !== b) return a ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** 两个版本号比先后：-1 是前一个旧，1 是前一个新，0 一样。有一边读不成语义化版本就是 null */
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const [a, b] = [parseVersion(left), parseVersion(right)]
  if (!a || !b) return null
  for (const index of [0, 1, 2] as const) {
    const order = sign(a.core[index] - b.core[index])
    if (order !== 0) return order
  }
  // 带预发布的比不带的旧
  if (a.pre.length === 0 || b.pre.length === 0) return sign(b.pre.length - a.pre.length)
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const order = comparePart(a.pre[index] as string, b.pre[index] as string)
    if (order !== 0) return order
  }
  return sign(a.pre.length - b.pre.length)
}

/** 在跑的那一份（没报来历是 null）相对于自带的那一份。规则见文件开头 */
export function compareService(running: ServiceFacts | null, bundled: CliFacts): VersionOrder {
  if (!running) return 'unknown'
  const order = compareVersions(running.version, bundled.version)
  if (order === null && running.version.trim() !== bundled.version.trim()) return 'incomparable'
  if (order === -1) return 'older'
  if (order === 1) return 'newer'
  const replaced =
    running.root === bundled.root &&
    running.build !== null &&
    bundled.build !== null &&
    running.build !== bundled.build
  return replaced ? 'rebuilt' : 'same'
}

/** 服务不闲的一条原因，device-stop --if-idle 报的 */
export interface BusyReason {
  /**
   * activeTurns 这几个 harness 有回合在跑（或者判断不了）；deviceProcesses 有属于设备的终端在跑；
   * clients 有别的客户端连着；undetermined 设备进程没有应答，判断不了。以后可能有别的值
   */
  reason: string
  harnesses: string[]
  count: number
}

/** 读 device-stop 标准输出的那一行里的 busy。读不懂就是空的 */
export function parseBusy(stdout: string): BusyReason[] {
  try {
    const value: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
    if (!isRecord(value) || !Array.isArray(value.busy)) return []
    return value.busy.filter(isRecord).flatMap((item) =>
      typeof item.reason === 'string'
        ? [
            {
              reason: item.reason,
              harnesses: Array.isArray(item.harnesses)
                ? item.harnesses.filter((name): name is string => typeof name === 'string')
                : [],
              count: typeof item.count === 'number' ? item.count : 0,
            },
          ]
        : [],
    )
  } catch {
    return []
  }
}

/**
 * 照旧用在跑的那一份，是因为什么：
 * same 就是同一版；newer 在跑的更新，不降级；incomparable 版本号比不出先后；
 * foreground 它不是 device-start 拉起的，有别的东西管着它的生死（前台的终端、brew services、systemd），不替它换；
 * busy 它不闲（明细在 busy 里）；unsupported 它不认识停止的请求，或者它的控制通道连不上；
 * failed 去停了，没停成（详情里是命令行的原话）
 */
export type KeptReason =
  | 'same'
  | 'newer'
  | 'incomparable'
  | 'foreground'
  | 'busy'
  | 'unsupported'
  | 'failed'

/** 一次打开里，对“在跑的服务和自带的是不是同一版”做了什么 */
export interface UpgradeOutcome {
  /**
   * launched 本来没有服务，这次拉起的就是自带的这一份；
   * replaced 在跑的比自带的旧而且闲着：停掉了，用自带的重新拉起了；
   * kept 照旧用在跑的那一份，原因在 reason 里
   */
  action: 'launched' | 'replaced' | 'kept'
  /**
   * 打开之前就在跑的那一份：kept 时是现在连着的，replaced 时是被换掉的；launched 时是这次拉起的。
   * 它没报自己的来历就是 null
   */
  running: ServiceFacts | null
  /** 应用自带的这一份 */
  bundled: CliFacts
  /** running 相对于 bundled */
  order: VersionOrder
  /** kept 的原因。别的情形是 null */
  reason: KeptReason | null
  /** reason 是 busy 时逐条的原因 */
  busy: BusyReason[]
  /** 命令行说的话（给人看的那一句），没有就是 null */
  detail: string | null
}
