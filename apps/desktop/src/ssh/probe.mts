// 远程设备的探测和启动：看对面有什么、定下连哪一种、让它的服务常驻。
// 顺序是先设备服务、后 codex。那台机器上装了适配器就认定走设备服务：
// 它用不了（太旧、在跑的是不带聚合面的旧服务、起不来）就照实说出来，不悄悄退回去连 codex——
// 退回去的话用户看到的是“只有 codex”，装了的东西为什么没用上反而没处说。
// 这里什么都不替用户做：不停服务、不升级、不安装，只说明是哪一种情况。
import {
  type AbortSignalLike,
  type Clock,
  ConnectError,
  createRpc,
  type HarnessView,
  harnessFromInfo,
  isDeviceRuntime,
  phrase,
  type RemoteTarget,
  type Transport,
} from '@litch/core'
import { fields, runRemote, tailOf } from './run.mjs'
import { EXIT, MIN_ADAPTER, MIN_CODEX, type Peer, probeScript, startScript } from './script.mjs'

/** 各步最多等多久。登录 shell 的启动脚本可以很慢，所以都给得宽 */
const PROBE_TIMEOUT_MS = 45_000
/** device-start 自己最多等 45 秒就会说明原因退出，这里留得比它长 */
const START_TIMEOUT_MS = 75_000
/** 只是看一眼时，问对面有哪些 harness 最多等多久 */
const PEEK_TIMEOUT_MS = 10_000
/** 对面的原话最多留这么多字 */
const SAID_MAX = 2000

const VERSION = /(\d+)\.(\d+)\.(\d+)/
const FULL_VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/

/** 版本号够不够。只比前三段数字，预发布的后缀不管 */
export function atLeast(version: string, min: string): boolean {
  const a = version.match(VERSION)?.slice(1).map(Number)
  const b = min.match(VERSION)?.slice(1).map(Number)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/** 对面两样都没有：给的是两条路的安装指引，不是一段报错 */
export const notInstalled = (): ConnectError =>
  new ConnectError('notInstalled', phrase('remote.notInstalled'), false, null, 'install')

const said = (text: string | undefined): string | null => text?.trim().slice(-SAID_MAX) || null

/** 探测的结果：对面要连的是哪一种 */
export type Found =
  | {
      peer: 'service'
      /** 适配器的版本 */
      version: string
      /** 它的服务现在在不在跑（聚合面连不连得上） */
      running: boolean
      system: string | null
    }
  | { peer: 'codex'; version: string; system: string | null }

/**
 * 按探测脚本报回来的那几行定下连哪一种。定不下来的抛一个有明确原因的错误。
 * 单独成一个函数：这几条规矩只看报回来的字，和 ssh 无关。
 */
export function decide(out: Record<string, string>, stderr = ''): Found {
  const system = out.system?.trim() || null
  if (out.adapter === 'yes') {
    const version = out.adapterVersion?.match(/^codex-harness-adapter\s+(\S+)/)?.[1]
    if (!version) {
      // 报不出版本：version 这条子命令是和设备服务一起加的，更早的适配器不认识它
      throw new ConnectError(
        'outdated',
        phrase('remote.serviceTooOld'),
        false,
        said(out.adapterSaid) ?? tailOf(stderr),
        'upgradeService',
      )
    }
    if (!atLeast(version, MIN_ADAPTER)) {
      throw new ConnectError(
        'outdated',
        phrase('remote.serviceOutdated', { version, min: MIN_ADAPTER }),
        false,
        null,
        'upgradeService',
      )
    }
    return { peer: 'service', version, running: out.adapterRunning === 'yes', system }
  }
  if (out.codex === 'yes') {
    const version = out.codexVersion?.match(FULL_VERSION)?.[0]
    if (!version) {
      throw new ConnectError(
        'notInstalled',
        phrase('remote.broken'),
        false,
        tailOf(stderr),
        'installCodex',
      )
    }
    if (!atLeast(version, MIN_CODEX)) {
      throw new ConnectError(
        'outdated',
        phrase('remote.outdated', { version, min: MIN_CODEX }),
        false,
        null,
        'upgradeCodex',
      )
    }
    return { peer: 'codex', version, system }
  }
  throw notInstalled()
}

/** 看一眼对面有什么。结果要么是“连这一种”，要么是一个有明确原因的错误。不启动任何东西 */
export async function probe(target: RemoteTarget, signal: AbortSignalLike): Promise<Found> {
  const result = await runRemote(target, probeScript(), { signal, timeoutMs: PROBE_TIMEOUT_MS })
  if (!result.marked) {
    // 内层脚本没跑起来：对面的登录 shell 半路退了之类。过一会儿再试可能就好了
    throw new ConnectError(
      'unreachable',
      phrase('ssh.failed', { code: result.code ?? '' }),
      true,
      tailOf(result.stderr),
    )
  }
  return decide(fields(result.out), result.stderr)
}

/** 让对面的服务常驻，等它能连上。没成的抛一个有明确原因的错误 */
export async function startPeer(
  target: RemoteTarget,
  peer: Peer,
  signal: AbortSignalLike,
): Promise<void> {
  const started = await runRemote(target, startScript(peer), {
    signal,
    timeoutMs: START_TIMEOUT_MS,
  })
  // 探测的时候还在，这会儿没了：照“没装”说
  if (started.code === EXIT.notFound) throw notInstalled()
  const out = fields(started.out)
  if (peer === 'codex') {
    if (started.code === 0) return
    // 服务自己的日志比 ssh 的报错更说明问题
    throw new ConnectError(
      'startFailed',
      phrase('remote.startFailed'),
      true,
      out.log?.trim() ? out.log.slice(-SAID_MAX) : tailOf(started.stderr),
    )
  }
  // 设备服务：device-start 的退出码在 code= 里，它说的话在 said= 里（见 script.mts）
  const lines = (out.said ?? '').split('\n')
  const ready = lines.some((line) => {
    try {
      return (JSON.parse(line) as { ready?: unknown }).ready === true
    } catch {
      return false
    }
  })
  if (out.code === '0' && ready) return
  if (out.code === '3') {
    // 有一份不带聚合面的旧服务在这个状态目录上跑。不停它、不替换它：上面可能有回合在跑，
    // 官方桌面端也可能正连着它。说明怎么办，等用户处理完再点“重试”
    throw new ConnectError(
      'outdated',
      phrase('remote.serviceLegacy'),
      false,
      said(out.said),
      'restartService',
    )
  }
  // 没起来、等聚合面超时，或者半路断了（连 code= 都没走到）。过一会儿自己再试
  throw new ConnectError(
    'startFailed',
    phrase('remote.serviceStartFailed'),
    true,
    said(out.said) ?? tailOf(started.stderr),
  )
}

/**
 * 在一条已经接到聚合面上的传输上问一句“上面有哪些 harness”，问完就断开。
 * 只给添加设备之前的那一眼用；问不出来（对面不是设备服务、超时、中途断了）就是 null。
 */
export function peekHarnesses(transport: Transport, clock: Clock): Promise<HarnessView[] | null> {
  return new Promise<HarnessView[] | null>((resolve) => {
    let settled = false
    const settle = (value: HarnessView[] | null) => {
      if (settled) return
      settled = true
      rpc.close()
      resolve(value)
    }
    const rpc = createRpc(transport, {
      clock,
      requestTimeoutMs: PEEK_TIMEOUT_MS,
      notification() {},
      close: () => settle(null),
    })
    const ask = async () => {
      await rpc.request('initialize', {
        clientInfo: { name: 'litch-desktop', title: 'Litch', version: '0.0.0' },
        // 聚合面只让声明了 harness 扩展的客户端连
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          litchExtensions: ['harness'],
        },
      })
      rpc.notify('initialized')
      const info = (await rpc.request('runtime/info', {})) as Parameters<typeof isDeviceRuntime>[0]
      return isDeviceRuntime(info) ? info.harnesses.map(harnessFromInfo) : null
    }
    ask().then(settle, () => settle(null))
  })
}
