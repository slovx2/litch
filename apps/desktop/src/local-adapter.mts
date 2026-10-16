// 本机设备：没有另外指定入口时，它就是应用自带的那份适配器。
// 这里管四件事：找到那份适配器、让它的设备服务跑起来（已经在跑就直接用）、
// 在跑的比自带的旧而且闲着时把它换成自带的、接到聚合面的套接字上。
// 共存规则见设计文档 03 第 14.3 节，命令和退出码的约定见 04 第二节和
// cmd/codex-harness-adapter/device_start.go、device_stop.go。
//
// 换版本的规矩（版本怎么比在 adapter-upgrade.mts）：
//   - 在跑的和自带的一样、比自带的新、版本号比不出先后：直接用，绝不降级。
//   - 在跑的比自带的旧（或者它没报自己的来历）：请它闲着的话停下（device-stop --if-idle），停了就用自带的重新拉起；
//     不闲就照旧连它，下一次打开时再问。一次打开只试一回。
//   - 只替 device-start 拉起的服务换。前台运行的、brew services 或 systemd 管着的不动：
//     停了它，管它的那一方会把旧的再拉起来，或者用户终端里的服务平白没了。
//   - 重新拉起时，旧服务启动时带的参数（SSH 入口开没开、端口）原样带上，不替用户改主意。
//   - 做了什么、没换是因为什么，都记在 upgrade() 里交给调用方；换不成不妨碍连上旧的。
//     核心每次连上之后经 upgradeReport() 取走一份，放进设备的显示数据里，界面在设备详情的“设备服务”一节照着说。
//
// 这个模块不碰 Electron：路径、环境、语言都由调用方给，自检（adapter-check.mts）直接拿它跑。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as absolute, isAbsolute, join } from 'node:path'
import {
  type AbortSignalLike,
  ConnectError,
  phrase,
  type ServiceUpgradeReport,
  type TransportOpener,
} from '@litch/core'
import {
  type BusyReason,
  type CliFacts,
  compareService,
  type KeptReason,
  outdated,
  parseBusy,
  parseCliFacts,
  parseServiceFacts,
  type ServiceFacts,
  type UpgradeOutcome,
} from './adapter-upgrade.mjs'
import { type Environment, loginEnvironment } from './login-env.mjs'
import { unixSocketOpener } from './transport-unix.mjs'

export type { BusyReason, CliFacts, KeptReason, ServiceFacts, UpgradeOutcome }

/**
 * device-start 的退出码。0 是聚合面可以连了（不管是谁启动的），标准输出里有一行结果；
 * 3 是这个状态目录上有一份不带聚合面的服务在跑（多半是旧版）；别的都是没起来，原因在标准错误里。
 */
const EXIT_READY = 0
const EXIT_LEGACY = 3

/**
 * device-stop 的退出码。0 是这个状态目录上现在没有常驻服务了（停掉了，或者本来就没有）；
 * 4 是带了 --if-idle 而服务不闲，没有停，标准输出那一行的 busy 里是原因；
 * 5 是有服务在跑但没法请它停（它比这条命令出现得早，或者控制通道连不上）；别的都是没停成。
 */
const EXIT_STOPPED = 0
const EXIT_BUSY = 4
const EXIT_UNSUPPORTED = 5

/** 等这条命令最多等多久。它自己最多等 45 秒就会说明原因退出，这里留得比它长，到点还没退才由我们结束它 */
const START_TIMEOUT_MS = 60_000
/**
 * 等 device-stop 最多等多久。它自己先等服务答话（服务要问一圈忙不忙，最多 40 秒），
 * 再等服务退出（最多 45 秒），加起来到不了这个数；到点还没退才由我们结束它
 */
const STOP_TIMEOUT_MS = 100_000
/** 桌面端自己拉起服务时带的参数：不开内置的 SSH 入口，不占任何端口 */
const DEFAULT_OPTIONS: readonly string[] = ['--ssh=off']
/** 它的原话最多留这么多字：开头一句原因，后面可能附着服务输出的末尾两千字，两样都要留住 */
const DETAIL_MAX = 4000
/** 命令退出之后再等这么久，把它最后几句话读完 */
const EXIT_DRAIN_MS = 200

/** 命令行会说的两种语言 */
export type AdapterLang = 'zh-CN' | 'en'

export interface LocalDeviceOptions {
  /** 另外指定的入口（LITCH_ENTRY）：一个套接字的路径。给了就直接连它，不管内置的适配器 */
  entry?: string | undefined
  /**
   * 内置的适配器在哪：装好的应用里是 Resources/adapter，开发时用 LITCH_ADAPTER_ROOT 指到一份暂存好的目录
   * （scripts/stage-adapter.mjs）。没有就不给
   */
  adapterRoot?: string | undefined
  /** 状态目录（LITCH_ADAPTER_HOME）。不给就是 ~/.codex-harness-adapter，和独立安装的那一份共用，这是有意的 */
  adapterHome?: string | undefined
  /** 命令行用哪种语言说话。每次启动前现问：它的原话会原样显示在“详情”里，要跟界面的语言对上 */
  lang(): AdapterLang
  /**
   * 用户登录 shell 里的环境，问不到给 null。不给就现问（login-env.mts）。一次运行只问一遍。
   * 从访达打开的应用自己的 PATH 里只有系统目录，不问的话设备服务找不到用户装的 harness
   */
  environment?: (() => Promise<Environment | null>) | undefined
  /** 只给自检用：把等待的时间调短 */
  startTimeoutMs?: number | undefined
  /** 只给自检用：等 device-stop 最多等多久 */
  stopTimeoutMs?: number | undefined
}

/** 内置适配器里要用到的两个可执行文件 */
export interface BundledAdapter {
  root: string
  /** Go 写的命令行 */
  bin: string
  /** 应用自带的 Node，适配器的各个进程都用它跑 */
  node: string
}

/** 目录里的布局是 scripts/stage-adapter.mjs 摆的，两边要对得上。Windows 上两个可执行文件带 .exe */
export const bundledAdapter = (root: string): BundledAdapter => {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  return {
    root,
    bin: join(root, 'bin', `codex-harness-adapter${suffix}`),
    node: join(root, 'node', 'bin', `node${suffix}`),
  }
}

/** 默认的状态目录 */
export const defaultAdapterHome = (): string => join(homedir(), '.codex-harness-adapter')

/** device-start 成功时在标准输出里给的那一行 */
export interface DeviceStartResult {
  /** 聚合面套接字的绝对路径。连哪里以它为准，不自己拼 */
  socket: string
  /** true：服务是这次调用拉起来的；false：本来就在运行 */
  started: boolean
  /** 常驻服务的进程号。命令行拿不准的时候不给，那就是 null */
  pid: number | null
  /** 在跑的那份服务的来历。它没报（比这项功能出现得早）就是 null：不知道，多半更旧 */
  service: ServiceFacts | null
  /** 执行这条命令的这一份适配器，也就是应用自带的。读不懂是 null，那就没法比，照旧直接用 */
  cli: CliFacts | null
}

/** 读标准输出里的那一行。读不懂就是 null */
function parseResult(stdout: string): DeviceStartResult | null {
  try {
    const value = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>
    if (value.ready !== true || typeof value.socket !== 'string' || !isAbsolute(value.socket)) {
      return null
    }
    return {
      socket: value.socket,
      started: value.started === true,
      pid: typeof value.pid === 'number' ? value.pid : null,
      service: parseServiceFacts(value.service),
      cli: parseCliFacts(value.cli),
    }
  } catch {
    return null
  }
}

/**
 * 交给设备服务的环境。它是常驻的，之后用户在会话里跑的命令都从它这里继承环境：
 * 以用户登录 shell 里的那一份为准（login 是问到的结果，没问到就只有应用自己的），
 * 我们自己的变量和会让 Electron 换一种方式运行的那个变量不许漏过去。
 * 语言是固定下来的：不然命令行会按它自己猜的语言说话，和界面对不上。
 */
export function serviceEnv(lang: AdapterLang, login: Environment | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries({ ...process.env, ...login })) {
    if (name.startsWith('LITCH_') || name === 'ELECTRON_RUN_AS_NODE') continue
    env[name] = value
  }
  env.CHA_LANG = lang
  return env
}

const tailOf = (text: string): string | null => text.trim().slice(-DETAIL_MAX) || null

const cancelled = (): ConnectError => new ConnectError('unreachable', phrase('connect.cancelled'))

/** 内置命令行的一条命令是怎么结束的 */
interface CommandEnd {
  /** 退出码。没能执行、被信号结束、到点被这边结束时是 null */
  code: number | null
  stdout: string
  stderr: string
  /** 到时间还没退，被这边结束了 */
  timedOut: boolean
  /** 命令行本身执行不了（没有执行权限、被系统拦下）时系统的原话 */
  spawnError: string | null
}

/**
 * 执行内置命令行的一条命令，等它结束。到点还没退、中途被取消，都把它结束掉：
 * 结束的只是这条等待中的命令，它拉起的服务是脱离出去的，不受影响。被取消时抛 ConnectError。
 */
function runCommand(
  adapter: BundledAdapter,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignalLike,
  timeoutMs: number,
): Promise<CommandEnd> {
  return new Promise<CommandEnd>((resolve, reject) => {
    // 问登录 shell、等上一条命令的那一会儿里可能已经被取消了
    if (signal.aborted) {
      reject(cancelled())
      return
    }
    // 服务会一直留着启动时的工作目录：给它用户的主目录，不要碰巧是应用当时所在的那个目录
    const child = spawn(adapter.bin, args, {
      cwd: homedir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 它拉起的服务万一还攥着这两条管道，不放手的话这边会一直留着读不完的流
      child.stdout.destroy()
      child.stderr.destroy()
      run()
    }
    const end = (more: Partial<CommandEnd>) =>
      settle(() =>
        resolve({ code: null, stdout, stderr, timedOut: false, spawnError: null, ...more }),
      )
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      end({ timedOut: true })
    }, timeoutMs)
    signal.addEventListener(
      'abort',
      () => {
        child.kill('SIGKILL')
        settle(() => reject(cancelled()))
      },
      { once: true },
    )
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-DETAIL_MAX * 2)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-DETAIL_MAX * 2)
    })
    child.on('error', (error) => end({ spawnError: error.message }))
    // 按“进程退出”算，不按“管道关闭”算：服务是这条命令拉起来的，要是它继承了这边的管道，
    // 管道要到服务退出才关。退出之后只再等一小会儿，把还在路上的话读完
    child.on('exit', (code) => {
      setTimeout(() => end({ code }), EXIT_DRAIN_MS)
    })
    child.on('close', (code) => end({ code }))
  })
}

/**
 * 让设备服务跑起来：执行内置命令行的 device-start。这条命令是幂等的，聚合面已经能连就直接成功。
 * 成功就返回它报的那一行；没成功抛 ConnectError，阶段和要不要再试按退出码分。
 * options 是要拉起服务时带给它的参数；服务已经在跑的话它们不起作用。
 */
export async function startDevice(
  adapter: BundledAdapter,
  home: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignalLike,
  timeoutMs: number = START_TIMEOUT_MS,
  options: readonly string[] = DEFAULT_OPTIONS,
): Promise<DeviceStartResult> {
  if (signal.aborted) throw cancelled()
  for (const path of [adapter.bin, adapter.node]) {
    // 装好的应用缺了东西，再试也是一样
    if (!existsSync(path)) {
      throw new ConnectError('notInstalled', phrase('connect.adapterBroken', { path }), false)
    }
  }
  const end = await runCommand(
    adapter,
    ['device-start', '--home', home, '--root', adapter.root, '--node', adapter.node, ...options],
    env,
    signal,
    timeoutMs,
  )
  const startFailed = (detail: string | null) =>
    new ConnectError('startFailed', phrase('connect.adapterStartFailed'), true, detail)
  if (end.spawnError !== null) {
    throw new ConnectError(
      'notInstalled',
      phrase('connect.adapterBroken', { path: adapter.bin }),
      false,
      end.spawnError,
    )
  }
  if (end.timedOut) {
    // 它拉起的服务不受影响，下一次再来时多半已经好了
    throw new ConnectError(
      'startFailed',
      phrase('connect.adapterTimeout', { seconds: Math.round(timeoutMs / 1000) }),
      true,
      tailOf(end.stderr),
    )
  }
  if (end.code === EXIT_READY) {
    const result = parseResult(end.stdout)
    // 说是成了，却没按约定报出聚合面在哪：不猜，当作没起来
    if (!result) throw startFailed(tailOf(end.stdout))
    return result
  }
  if (end.code === EXIT_LEGACY) {
    // 别人启动的旧版服务：不停它、不替换它，等用户升级完再点“重试”
    throw new ConnectError('outdated', phrase('connect.adapterLegacy'), false, tailOf(end.stderr))
  }
  throw startFailed(tailOf(end.stderr))
}

/** 请服务闲着的话停下，得到的结果 */
export type StopOutcome =
  /** 这个状态目录上现在没有常驻服务了：停掉了，或者它自己先没了 */
  | { kind: 'stopped' }
  /** 它不闲，没有停 */
  | { kind: 'busy'; busy: BusyReason[]; detail: string | null }
  /** 没法请它停：它不认识这个请求，或者它的控制通道连不上。没有动它 */
  | { kind: 'unsupported'; detail: string | null }
  /** 没停成：命令执行不了、报了错、到点还没返回。服务现在是什么样不知道 */
  | { kind: 'failed'; detail: string | null }

/**
 * 请这个状态目录上的服务闲着的话停下：执行内置命令行的 device-stop --if-idle，它会等服务退出才返回。
 * 忙不忙由服务自己说（有回合在跑、有属于设备的终端在跑、有别的客户端连着，都算忙）。
 * 这条命令从不按进程号去结束谁。被取消时抛 ConnectError，别的都落在返回值里。
 */
export async function stopIdleDevice(
  adapter: BundledAdapter,
  home: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignalLike,
  timeoutMs: number = STOP_TIMEOUT_MS,
): Promise<StopOutcome> {
  const end = await runCommand(
    adapter,
    ['device-stop', '--home', home, '--if-idle'],
    env,
    signal,
    timeoutMs,
  )
  if (end.spawnError !== null) return { kind: 'failed', detail: end.spawnError }
  if (end.timedOut) return { kind: 'failed', detail: tailOf(end.stderr) }
  const detail = tailOf(end.stderr)
  if (end.code === EXIT_STOPPED) return { kind: 'stopped' }
  if (end.code === EXIT_BUSY) return { kind: 'busy', busy: parseBusy(end.stdout), detail }
  if (end.code === EXIT_UNSUPPORTED) return { kind: 'unsupported', detail }
  return { kind: 'failed', detail }
}

export interface LocalDevice {
  /** 本机设备的传输怎么打开 */
  open: TransportOpener
  /** 最近一次 device-start 成功时报回来的那一行。还没成功过，或者本机走的是另外指定的入口，就是 null */
  last(): DeviceStartResult | null
  /**
   * 这次运行期间由这边拉起来的那份服务（报 started 的那一次）。没拉起过就是 null。
   * 应用退出时不停它：服务是常驻的，退出之后会话继续在（设计文档 03 第 14.3 节）。
   * 以后做“退出时一并停止”的选项时，要停的进程号从这里取；别人启动的服务不在这里，也不归我们停。
   */
  launched(): DeviceStartResult | null
  /**
   * 最近一次 device-start 成功之后，对“在跑的服务和自带的是不是同一版”做了什么：在跑的是哪一版、
   * 自带的是哪一版、换了没有、没换是因为什么。调用方拿它告诉用户“服务比应用旧，等它闲下来会换掉”之类的话。
   * 还没成功过、本机走的是另外指定的入口、自带的命令行没报自己是哪一份，都是 null。
   */
  upgrade(): UpgradeOutcome | null
}

/**
 * 交给核心的那一份：最近一次连接换版本的结果，另加现在连着的那份服务的进程号
 * （要用户手工结束它的时候，界面拿它给命令用；命令行拿不准进程号时是 null）。
 * 核心每次连上之后来取（core-host.mts 里接到本机设备的配置上），界面据此说“换了没有、为什么没换”。
 * 没有换版本这回事时是 null：还没连上过、本机走的是另外指定的入口、自带的命令行没报自己是哪一份
 */
export function upgradeReport(device: LocalDevice): ServiceUpgradeReport | null {
  const outcome = device.upgrade()
  if (!outcome) return null
  const last = device.last()
  return { ...outcome, pid: last?.service?.pid ?? last?.pid ?? null }
}

/** 认一份在跑的服务用的记号：进程号加启动时间。进程号都不知道就认不出来 */
function serviceKey(result: DeviceStartResult): string | null {
  const pid = result.service?.pid ?? result.pid
  return pid === null ? null : `${pid}@${result.service?.startedAt ?? ''}`
}

export function localDevice(options: LocalDeviceOptions): LocalDevice {
  let last: DeviceStartResult | null = null
  let launched: DeviceStartResult | null = null
  let upgrade: UpgradeOutcome | null = null
  const state = { last: () => last, launched: () => launched, upgrade: () => upgrade }
  if (options.entry) {
    return { open: unixSocketOpener(options.entry.replace(/^unix:\/\//, '')), ...state }
  }
  const root = options.adapterRoot
  if (!root) {
    // 没装成应用，也没用环境变量指：没有适配器可用
    const open: TransportOpener = async () => {
      throw new ConnectError('notInstalled', phrase('connect.noEntry'), false)
    }
    return { open, ...state }
  }
  // 环境变量里给的可以是相对路径：在这里按当前目录定下来，之后交给命令行的都是绝对路径
  const adapter = bundledAdapter(absolute(root))
  const home = options.adapterHome ? absolute(options.adapterHome) : defaultAdapterHome()
  // 登录 shell 只问一遍：问一次要起一个交互式的 shell，重连的时候不该每次都来
  let login: Promise<Environment | null> | null = null
  /**
   * 试过、换不了的那几份服务，和当时的原因。同一份服务不再去请它停：
   * 它不认识这个请求的话问多少遍都一样，停到一半卡住的再来一遍只会让每次重连都多等上一阵。
   * 不闲的不记：下一次打开时再问，闲了就换。
   */
  const gaveUp = new Map<string, { reason: KeptReason; detail: string | null }>()

  /**
   * 聚合面已经能连了。在跑的要是比自带的旧而且闲着，停掉它、用自带的重新拉起。
   * 返回最后要连的那一份，做了什么记在 upgrade 里。一次打开只试一回，不循环。
   */
  const reconcile = async (
    found: DeviceStartResult,
    env: NodeJS.ProcessEnv,
    signal: AbortSignalLike,
  ): Promise<DeviceStartResult> => {
    const bundled = found.cli
    // 自带的命令行没报自己是哪一份：没法比，照旧直接用
    if (!bundled) {
      upgrade = null
      return found
    }
    const outcome = (result: DeviceStartResult, more: Partial<UpgradeOutcome>) => {
      upgrade = {
        action: 'kept',
        running: result.service,
        bundled,
        order: compareService(result.service, bundled),
        reason: null,
        busy: [],
        detail: null,
        ...more,
      }
      return result
    }
    if (found.started) return outcome(found, { action: 'launched' })
    const order = compareService(found.service, bundled)
    if (order === 'same' || order === 'newer' || order === 'incomparable') {
      return outcome(found, { reason: order })
    }
    // 不是 device-start 拉起的：有别的东西管着它的生死，不替它换
    if (found.service && !found.service.detached) return outcome(found, { reason: 'foreground' })
    const key = serviceKey(found)
    const before = key === null ? undefined : gaveUp.get(key)
    if (before) return outcome(found, before)
    const stop = await stopIdleDevice(adapter, home, env, signal, options.stopTimeoutMs)
    if (stop.kind === 'busy') {
      return outcome(found, { reason: 'busy', busy: stop.busy, detail: stop.detail })
    }
    if (stop.kind === 'unsupported') {
      if (key !== null) gaveUp.set(key, { reason: 'unsupported', detail: stop.detail })
      return outcome(found, { reason: 'unsupported', detail: stop.detail })
    }
    // 停掉了，或者没停利索：再执行一次 device-start，现在是什么样以它说的为准。
    // 旧服务启动时带的参数原样带上；它没报过就用我们自己的默认
    const again = await startDevice(
      adapter,
      home,
      env,
      signal,
      options.startTimeoutMs,
      found.service?.options.length ? found.service.options : DEFAULT_OPTIONS,
    )
    if (again.started) {
      return outcome(again, { action: 'replaced', running: found.service, order })
    }
    // 没有轮到我们拉起：旧的还在（没停成），或者别人抢先起了一份。照旧用在跑的，这一次不再试
    const now = compareService(again.service, bundled)
    if (!outdated(now)) return outcome(again, { reason: now as KeptReason })
    const failure = {
      reason: 'failed' as const,
      detail: stop.kind === 'failed' ? stop.detail : null,
    }
    const stuck = serviceKey(again)
    if (stuck !== null) gaveUp.set(stuck, failure)
    return outcome(again, failure)
  }

  const open: TransportOpener = async (signal, report) => {
    report?.(phrase('connect.adapterStarting'))
    login ??= (options.environment ?? loginEnvironment)()
    const env = serviceEnv(options.lang(), await login)
    const found = await startDevice(adapter, home, env, signal, options.startTimeoutMs)
    const result = await reconcile(found, env, signal)
    last = result
    if (result.started) launched = result
    return unixSocketOpener(result.socket)(signal)
  }
  return { open, ...state }
}
