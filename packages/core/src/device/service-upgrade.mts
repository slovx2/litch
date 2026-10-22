// 远程设备服务的一键升级：设备详情里那个“升级”背后的状态和步骤（界面看到的形状在 model-service.mts）。
// 远程设备上跑的是那台机器自己装的适配器，应用自动更新换不到它。在跑的比应用旧时：
//   1. 用户点“升级”、确认之后，经 ssh 在那台机器上装应用的这一版（安装脚本 --version，或者 brew upgrade）；
//   2. 装好了马上请服务空闲时停下（device-stop --if-idle）。停了就重连，重连时 device-start 起的就是新版；
//   3. 不闲就留着旧的接着用，记下“装好了、等着换”：之后每次连上、以及连着时每 5 分钟再请一次，换上了就清掉；
//   4. 不闲时用户可以选“立即换上”，界面再确认一次（写明会打断什么）才不带 --if-idle 地停。
// 服务由前台或者服务管理器管着的（detached 为 false），只替用户装，不替用户换。认不出是怎么装的，不给按钮。
// “等着换”只记在应用里（这个对象里），不进设备；应用退出就不等了，下次打开时装着的已经不旧，按钮叫“换上新版”。
// 在那台机器上动手的是外壳（RemoteUpgradePlatform）；用户没确认过，这里不会叫 install 和 stop。

import { createCancel } from '../channel/cancel.mjs'
import type { Clock } from '../channel/protocol.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import { toConnectError } from '../connection/transport.mjs'
import type { ConnectGuide, RemoteTarget } from '../model.mjs'
import type {
  DeviceServiceView,
  RemoteAdapterFacts,
  RemoteUpgradePhase,
  RemoteUpgradeView,
} from '../model-service.mjs'
import { compareVersions, installMethodOf } from '../text/versions.mjs'
import type { RemoteUpgradePlatform } from './remote.mjs'

/** 等它闲下来时，连着的时候多久再请一次（决 466） */
export const SWAP_RETRY_MS = 5 * 60_000

export interface ServiceUpgraderOptions {
  clock: Clock
  /** 应用的版本：要装的就是这一版（决 461） */
  version: string
  target: RemoteTarget
  /** 外壳给的那份能力。没有（手机端）就只显示“比应用旧” */
  platform: RemoteUpgradePlatform | null
  /** 显示数据变了 */
  changed(): void
  /** 服务停了：丢掉现在这条连接重连一次（Device.retry） */
  reconnect(): void
  log?(line: string): void
}

/** 设备每次变了告诉它的现状 */
export interface ServiceUpgradeSeen {
  /** 连着，而且认过对面了 */
  online: boolean
  /** 对面是设备服务（完整模式） */
  full: boolean
  /** 对面报的在跑的那份服务 */
  service: DeviceServiceView | null
  /** 对面声明了会报服务的来历，只是还没给：这时还不知道在跑的是哪一版，不算旧 */
  serviceDue: boolean
  /** 没连上时该给哪一份“怎么办”：upgradeService 是适配器太旧、连不上，也给同一个按钮 */
  guide: ConnectGuide | null
}

/** 界面上的三种做法：start 升级（或者换上新版）；retry 现在再请一次空闲时停；force 立即换上（会打断） */
export type UpgradeMode = 'start' | 'retry' | 'force'

export interface ServiceUpgrader {
  view(): RemoteUpgradeView | null
  /** 设备的现状变了。这里不报 changed：设备紧接着自己会发一次显示数据 */
  seen(state: ServiceUpgradeSeen): void
  run(mode: UpgradeMode): void
  dispose(): void
}

const OFFLINE: ServiceUpgradeSeen = {
  online: false,
  full: false,
  service: null,
  serviceDue: false,
  guide: null,
}

export function createServiceUpgrader(options: ServiceUpgraderOptions): ServiceUpgrader {
  const { clock, platform, target } = options
  const log = (line: string) => options.log?.(`一键升级：${line}`)
  let seen: ServiceUpgradeSeen = OFFLINE
  let phase: RemoteUpgradePhase = { step: 'idle' }
  /** 那台机器上装着的那一份。每次连上（或者连不上的原因换成“太旧”）问一遍；装完由安装的结果补上 */
  let facts: RemoteAdapterFacts | null = null
  /** 第几轮：每次连上、每次连不上的原因换成“太旧”加一。facts 每轮问一遍 */
  let round = 0
  /** 正在问（或者问过）facts 的是第几轮；这一轮还没问是 -1 */
  let inspecting = -1
  /** 动手之前在跑的是哪一版：换上之后说“从哪版换到哪版” */
  let before: string | null = null
  /** 正在做的那一步（装、停）。同一时刻只有一步 */
  let job: Promise<void> | null = null
  /** 等空闲时下一次再请的定时器 */
  let retryTimer: (() => void) | null = null
  const cancel = createCancel()

  const set = (next: RemoteUpgradePhase) => {
    phase = next
    options.changed()
  }

  /** 在跑的那一份比应用旧：比得出先后而且旧；在跑的没报来历（旧到不报）也算旧；连不上是因为太旧的也算 */
  const older = (): boolean => {
    if (!seen.online) return seen.guide === 'upgradeService'
    if (!seen.full) return false
    if (seen.service === null) return !seen.serviceDue
    return compareVersions(seen.service.version, options.version) === -1
  }

  const installed = (): string | null => facts?.version ?? null

  /** 装着的已经不旧：只差换上 */
  const swapOnly = (): boolean => {
    const have = installed()
    if (have === null) return false
    const order = compareVersions(have, options.version)
    return order !== null && order >= 0
  }

  /** 怎么装的：先看在跑的服务的根目录，没连上时看命令的位置 */
  const method = () => installMethodOf(seen.service?.root) ?? installMethodOf(facts?.path)

  /** 在跑的服务有别的东西管着：只装，不换（决 463） */
  const managed = (): boolean => seen.service !== null && !seen.service.detached

  const view = (): RemoteUpgradeView | null => {
    if (phase.step === 'idle' && !older()) return null
    return {
      target: options.version,
      running: seen.online ? (seen.service?.version ?? null) : null,
      installed: installed(),
      method: method(),
      managed: managed(),
      action: swapOnly() ? 'swap' : 'upgrade',
      capable: platform !== null,
      phase,
    }
  }

  const stopRetry = () => {
    retryTimer?.()
    retryTimer = null
  }

  /** 等空闲时：连着就过一阵再请一次 */
  const scheduleRetry = () => {
    stopRetry()
    if (!seen.online || phase.step !== 'waiting') return
    retryTimer = clock.setTimer(() => {
      retryTimer = null
      if (phase.step === 'waiting' && !job) begin(() => stop(true, true))
    }, SWAP_RETRY_MS)
  }

  /** 开一步。上一步还没完就不开 */
  const begin = (step: () => Promise<void>) => {
    job = step()
      .catch((error: unknown) => log(`意外的错误：${String(error)}`))
      .finally(() => {
        job = null
      })
  }

  const failed = (
    at: Extract<RemoteUpgradePhase, { step: 'failed' }>['at'],
    detail: string | null,
  ) => set({ step: 'failed', at, text: null, detail })

  /** ssh 没连上那台机器 */
  const unreachable = (error: unknown) => {
    const reason = toConnectError(error)
    set({ step: 'failed', at: 'connect', text: reason.text, detail: reason.detail })
  }

  /**
   * 请服务停下。ifIdle：只在它闲着时停。auto：是“等空闲”时自己再请的那一次，
   * 没连上那台机器、或者还是不闲，都接着等，不算失败
   */
  const stop = async (ifIdle: boolean, auto: boolean): Promise<void> => {
    if (!platform) return
    const waited = phase.step === 'waiting' ? phase.busy : []
    if (auto) set({ step: 'waiting', busy: waited, checking: true })
    else set({ step: 'stopping', force: !ifIdle })
    let result: Awaited<ReturnType<RemoteUpgradePlatform['stop']>>
    try {
      result = await platform.stop(target, ifIdle, cancel.signal)
    } catch (error) {
      if (cancel.signal.aborted) return
      if (auto) {
        log(`等空闲时再请一次没连上：${String(error)}`)
        set({ step: 'waiting', busy: waited, checking: false })
        scheduleRetry()
        return
      }
      unreachable(error)
      return
    }
    if (cancel.signal.aborted) return
    // 这期间已经重连上了新版（服务一停，连接断了，设备自己就会重连）
    if (phase.step === 'done') return
    switch (result.result) {
      case 'stopped':
        stopRetry()
        set({ step: 'reconnecting' })
        options.reconnect()
        return
      case 'busy':
        set({ step: 'waiting', busy: result.busy, checking: false })
        scheduleRetry()
        return
      case 'legacy':
        failed('legacy', result.said)
        return
      case 'unsupported':
        failed('unsupported', result.said)
        return
      case 'failed':
        failed('stop', result.said)
    }
  }

  /** 装新版，装好了接着请服务空闲时停下（有别的东西管着它的，只装不换） */
  const install = async (how: 'script' | 'brew'): Promise<void> => {
    if (!platform) return
    set({ step: 'installing' })
    let result: Awaited<ReturnType<RemoteUpgradePlatform['install']>>
    try {
      result = await platform.install(
        target,
        { method: how, version: options.version },
        cancel.signal,
      )
    } catch (error) {
      if (!cancel.signal.aborted) unreachable(error)
      return
    }
    if (cancel.signal.aborted) return
    if (!result.ok) {
      failed(result.at, result.said)
      return
    }
    facts = { version: result.installed, path: facts?.path ?? null }
    const order = compareVersions(result.installed, options.version)
    if (order === null || order < 0) {
      // Homebrew 装不了指定的版本：装完还是旧的，是配方还没跟上这一版
      failed(how === 'brew' && order !== null ? 'behind' : 'verify', result.said)
      return
    }
    if (managed()) {
      set({ step: 'restart' })
      return
    }
    await stop(true, false)
  }

  /** 问一遍那台机器上装着的那一份（只是看一眼）：按钮叫“升级”还是“换上新版”、没连上时认安装方式，都靠它 */
  const inspect = () => {
    if (!platform || inspecting === round) return
    const mine = round
    inspecting = mine
    // 问不出来就算了，这一轮不再问：按钮照“升级”给，装的时候安装脚本自己知道装过没有
    platform.inspect(target, cancel.signal).then(
      (found) => {
        if (cancel.signal.aborted || mine !== round) return
        facts = found
        options.changed()
      },
      (error: unknown) => {
        if (!cancel.signal.aborted) log(`问装着的版本没成：${String(error)}`)
      },
    )
  }

  return {
    view,

    seen(state) {
      const was = seen
      seen = state
      const linked = state.online && !was.online
      if (linked) {
        round++
        facts = null
      }
      if (!state.online) {
        stopRetry()
        // “换上了”那句只在换上的那一次连接里说：断了就不说了，免得没连着时还挂着一句过时的话
        if (phase.step === 'done') phase = { step: 'idle' }
      }
      if (!state.online && state.guide === 'upgradeService' && was.guide !== 'upgradeService') {
        // 没连上，原因是太旧：按命令的位置认安装方式。原因每换成一次“太旧”问一次
        round++
        facts = null
      }
      const old = older()
      if (state.online && !old && phase.step !== 'idle' && phase.step !== 'done') {
        // 在跑的已经不旧了：换上了（不管是这边停的，还是用户自己换的）。之前没做成的那句也不用再说
        stopRetry()
        if (phase.step === 'failed') phase = { step: 'idle' }
        else {
          phase = { step: 'done', from: before, to: state.service?.version ?? options.version }
        }
      } else if (linked && old) {
        if (phase.step === 'reconnecting') {
          // 停了、重连上来，在跑的还是旧的
          phase = { step: 'failed', at: 'stale', text: null, detail: null }
        } else if (phase.step === 'waiting' && !job) {
          // 每次连上都再请一次
          begin(() => stop(true, true))
        }
      }
      if (old) inspect()
    },

    run(mode) {
      if (!platform) throw new ChannelError('rejected', '这一端不能替用户升级远程设备的服务')
      if (job) throw new ChannelError('rejected', '上一步还没有做完')
      if (mode === 'retry' || mode === 'force') {
        if (phase.step !== 'waiting') throw new ChannelError('rejected', '没有在等服务空闲')
        stopRetry()
        begin(() => stop(mode === 'retry', mode === 'retry'))
        return
      }
      if (!older()) throw new ChannelError('rejected', '在跑的服务不比应用旧')
      before = seen.online ? (seen.service?.version ?? null) : null
      if (swapOnly()) {
        if (managed()) throw new ChannelError('rejected', '这份服务有别的方式管着，要用户自己重启')
        begin(() => stop(true, false))
        return
      }
      const how = method()
      if (how === null) throw new ChannelError('rejected', '认不出这台设备上的适配器是怎么装的')
      begin(() => install(how))
    },

    dispose() {
      stopRetry()
      cancel.abort()
    },
  }
}
