// 远程设备的探测和启动：看对面有什么、定下连哪一种、让它的服务常驻。规矩和桌面端一样
// （apps/desktop/src/ssh/probe.mts）：先设备服务、后 codex；装了适配器就认定走设备服务，它用不了就照实说，
// 不悄悄退回去连 codex；这里什么都不替用户做（不停服务、不升级、不安装）。
import {
  type AbortSignalLike,
  type Clock,
  ConnectError,
  createRpc,
  type HarnessView,
  harnessFromInfo,
  isDeviceRuntime,
  phrase,
  type RemoteStopResult,
  type ServiceBusyView,
  type Transport,
} from '@litch/core'
import { ssh } from '../../modules/litch-ssh/src'
import { sshFailure } from './ssh-errors'
import {
  EXIT,
  MIN_ADAPTER,
  MIN_CODEX,
  type Peer,
  parsePairs,
  probeScript,
  type RemoteScript,
  type ScriptNames,
  startScript,
  stopScript,
} from './ssh-script'
import type { RemoteConfig } from './ssh-transport'

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

/** 交互式 shell 在没有终端时会抱怨这两句，和出了什么错没有关系 */
const NOISE = [/cannot set terminal process group/, /no job control in this shell/]

/** 报错的末尾，去掉那几句无关的 */
export function tailOf(stderr: string): string | null {
  const text = stderr
    .split('\n')
    .filter((line) => !NOISE.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim()
  return text ? text.slice(-SAID_MAX) : null
}

const said = (text: string | undefined): string | null => text?.trim().slice(-SAID_MAX) || null

/** 对面两样都没有：给的是两条路的安装指引，不是一段报错 */
export const notInstalled = (): ConnectError =>
  new ConnectError('notInstalled', phrase('remote.notInstalled'), false, null, 'install')

export type Found =
  | { peer: 'service'; version: string; running: boolean; system: string | null }
  | { peer: 'codex'; version: string; system: string | null }

/** 按探测脚本报回来的那几行定下连哪一种。定不下来的抛一个有明确原因的错误 */
export function decide(out: Record<string, string>, stderr = ''): Found {
  const system = out.system?.trim() || null
  if (out.adapter === 'yes') {
    const version = out.adapterVersion?.match(/^codex-harness-adapter\s+(\S+)/)?.[1]
    if (!version) {
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

/** 跑一段脚本。ssh 自己没连上的换成有明确原因的错误 */
async function run(config: RemoteConfig, script: RemoteScript) {
  try {
    return await ssh.runScript(config.target, script.text, script.marker)
  } catch (error) {
    throw sshFailure(error)
  }
}

const cancelled = () => new ConnectError('unreachable', phrase('connect.cancelled'), false)

export function checkAborted(signal: AbortSignalLike): void {
  if (signal.aborted) throw cancelled()
}

/** 看一眼对面有什么。不启动任何东西 */
export async function probe(
  config: RemoteConfig,
  names: ScriptNames,
  signal: AbortSignalLike,
): Promise<Found> {
  const result = await run(config, probeScript(names))
  checkAborted(signal)
  if (!result.marked) {
    // 内层脚本没跑起来：对面的登录 shell 半路退了之类。过一会儿再试可能就好了
    throw new ConnectError(
      'unreachable',
      phrase('ssh.failed', { code: result.code }),
      true,
      tailOf(result.stderr),
    )
  }
  return decide(parsePairs(result.output), result.stderr)
}

/** 让对面的服务常驻，等它能连上。没成的抛一个有明确原因的错误 */
export async function startPeer(
  config: RemoteConfig,
  names: ScriptNames,
  peer: Peer,
  signal: AbortSignalLike,
): Promise<void> {
  const started = await run(config, startScript(names, peer))
  checkAborted(signal)
  if (started.code === EXIT.notFound) throw notInstalled()
  const out = parsePairs(started.output)
  if (peer === 'codex') {
    if (started.code === 0) return
    throw new ConnectError(
      'startFailed',
      phrase('remote.startFailed'),
      true,
      out.log?.trim() ? out.log.slice(-SAID_MAX) : tailOf(started.stderr),
    )
  }
  const ready = (out.said ?? '').split('\n').some((line) => {
    try {
      return (JSON.parse(line) as { ready?: unknown }).ready === true
    } catch {
      return false
    }
  })
  if (out.code === '0' && ready) return
  if (out.code === '3') {
    // 有一份不带聚合面的旧服务在跑：不停它、不替换它，说明怎么办，等用户处理完点“重试”
    throw new ConnectError(
      'outdated',
      phrase('remote.serviceLegacy'),
      false,
      said(out.said),
      'restartService',
    )
  }
  throw new ConnectError(
    'startFailed',
    phrase('remote.serviceStartFailed'),
    true,
    said(out.said) ?? tailOf(started.stderr),
  )
}

/** device-stop 那一行里的 busy：逐条不闲的原因。读不懂是空的 */
function busyOf(line: string | undefined): ServiceBusyView[] {
  try {
    const value = JSON.parse(line?.trim().split('\n').at(-1) ?? '') as { busy?: unknown }
    if (!Array.isArray(value.busy)) return []
    return value.busy.flatMap((item: Record<string, unknown>) =>
      typeof item?.reason === 'string'
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
 * 请对面的设备服务停下（重启设备服务）。退出码的含义和桌面端一样（cmd/codex-harness-adapter/device_stop.go）。
 * ssh 自己没连上时抛 ConnectError；只是有客户端连着的不闲脚本里已经处理，不列出来
 */
export async function stopPeer(
  config: RemoteConfig,
  names: ScriptNames,
  ifIdle: boolean,
  signal: AbortSignalLike,
): Promise<RemoteStopResult> {
  const result = await run(config, stopScript(names, ifIdle))
  checkAborted(signal)
  if (result.code === EXIT.notFound) throw notInstalled()
  if (!result.marked) return { result: 'failed', said: tailOf(result.stderr) }
  const out = parsePairs(result.output)
  switch (out.code) {
    case '0':
      return { result: 'stopped' }
    case '4':
      return {
        result: 'busy',
        busy: busyOf(out.out).filter((entry) => entry.reason !== 'clients'),
      }
    case '3':
      return { result: 'legacy', said: said(out.said) }
    case '5':
      return { result: 'unsupported', said: said(out.said) }
    default:
      return { result: 'failed', said: said(out.said) ?? said(out.out) }
  }
}

/**
 * 在一条已经接到聚合面上的传输上问一句“上面有哪些 harness”，问完就断开。
 * 只给添加设备之前的那一眼用；问不出来就是 null
 */
export function peekHarnesses(
  transport: Transport,
  clock: Clock,
  version: string,
): Promise<HarnessView[] | null> {
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
        clientInfo: { name: 'litch-mobile', title: 'Litch', version },
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
