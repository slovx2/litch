// 重启设备服务：侧栏设备行“⋯”里那一项背后的状态和步骤（界面看到的形状在 model-service.mts）。
// 做法和一键升级“换上新版”那一步相同：请服务停下（device-stop，它等服务完全退出才返回），停了就重连，
// 重连时服务被拉起来（本机由外壳的 device-start 拉起，远程由 ssh 的连接脚本拉起）。
// 重连上了、而且在跑的换了一份，才算重启成了；停了之后迟迟连不上，照连接的原因说没做成。
//   1. 没有会话在跑：带 ifIdle 请它停（只是有客户端连着不算忙，外壳那一头已经处理）。服务说不闲
//      （设备上的终端、这边看不到的回合）就停在 busy，界面列出原因再问一次；
//   2. 有会话在跑（回合、后台任务）：界面先列出这些会话问过，或者 busy 之后用户说仍然重启，不带 ifIdle 地停（force）。
//      这时在跑的会话记下来，重启成了交给设备，在这些会话的对话末尾说一句“回合被打断，发消息继续”。
//      不替用户自动续上：各 harness 被打断之后的样子不一样，自动发一句“继续”会在历史里多出一条用户没说过的话，
//      停在审批、提问上的回合也续不回原样；后台任务的进程已经随服务一起结束，续不回来。
// 服务由前台或者服务管理器管着的（detached 为 false）不替用户重启：停了它，管它的那一方或者用户的终端会怎样说不准。
// 在那台机器上动手的是外壳（stop）；用户没点过，这里不会叫它。

import { createCancel } from '../channel/cancel.mjs'
import type { Clock } from '../channel/protocol.mjs'
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import { toConnectError } from '../connection/transport.mjs'
import type { ConnectFailureView } from '../model.mjs'
import type {
  DeviceServiceView,
  RemoteStopResult,
  ServiceRestartBlock,
  ServiceRestartFailure,
  ServiceRestartPhase,
  ServiceRestartSession,
  ServiceRestartView,
} from '../model-service.mjs'
import type { Text } from '../phrase.mjs'

/** 停了之后最多等多久连回来。本机 device-start 自己最多等 60 秒，远程的连接脚本也差不多 */
export const RESTART_WAIT_MS = 120_000

/** 外壳给的那一步：请这台设备上的服务停下。ifIdle 为 false 时不等它闲，进行中的事会被打断 */
export type ServiceStopper = (ifIdle: boolean, signal: AbortSignalLike) => Promise<RemoteStopResult>

export interface ServiceRestarterOptions {
  clock: Clock
  stop: ServiceStopper
  /** 显示数据变了 */
  changed(): void
  /** 服务停了：丢掉现在这条连接重连一次（Device.retry） */
  reconnect(): void
  /** 现在重启会打断的会话 */
  sessions(): ServiceRestartSession[]
  /** 重启成了：这几个会话被打断了（force 时在跑的那些） */
  interrupted(sessionIds: string[]): void
  log?(line: string): void
}

/** 设备每次变了告诉它的现状 */
export interface ServiceRestartSeen {
  /** 连着，而且认过对面了 */
  online: boolean
  /** 对面是设备服务（完整模式） */
  full: boolean
  /** 对面报的在跑的那份服务。没报（旧版、还没给）是 null */
  service: DeviceServiceView | null
  /** 没连上的原因。连着、还没失败过是 null */
  failure: ConnectFailureView | null
  /** 一键升级正在进行（装、停、等重连）：这时不能重启 */
  upgrading: boolean
}

/** start：先带 ifIdle 停；force：用户确认过会打断什么，直接停；dismiss：收起 busy、done、failed */
export type RestartMode = 'start' | 'force' | 'dismiss'

export interface ServiceRestarter {
  view(): ServiceRestartView
  /** 设备的现状变了。这里不报 changed：设备紧接着自己会发一次显示数据 */
  seen(state: ServiceRestartSeen): void
  run(mode: RestartMode): void
  dispose(): void
}

const OFFLINE: ServiceRestartSeen = {
  online: false,
  full: false,
  service: null,
  failure: null,
  upgrading: false,
}

/** 认一份在跑的服务：进程号加启动时间 */
const keyOf = (service: DeviceServiceView | null): string | null =>
  service === null ? null : `${service.pid}@${service.startedAt ?? ''}`

export function createServiceRestarter(options: ServiceRestarterOptions): ServiceRestarter {
  const { clock } = options
  const log = (line: string) => options.log?.(`重启设备服务：${line}`)
  let seen: ServiceRestartSeen = OFFLINE
  let phase: ServiceRestartPhase = { step: 'idle' }
  /** 停之前在跑的那一份：连回来时看换没换 */
  let before: string | null = null
  /** force 停的那一刻在跑的会话 */
  let caught: string[] = []
  /** 停了之后等连回来的定时器 */
  let waitTimer: (() => void) | null = null
  let job: Promise<void> | null = null
  const cancel = createCancel()

  const set = (next: ServiceRestartPhase) => {
    phase = next
    options.changed()
  }

  const stopWaiting = () => {
    waitTimer?.()
    waitTimer = null
  }

  const failed = (
    reason: ServiceRestartFailure,
    text: Text | null,
    detail: string | null,
  ): ServiceRestartPhase => ({ step: 'failed', at: clock.now(), reason, text, detail })

  const blocked = (): ServiceRestartBlock | null => {
    if (!seen.online) return 'offline'
    if (!seen.full) return 'single'
    if (seen.service !== null && !seen.service.detached) return 'managed'
    if (seen.upgrading) return 'upgrading'
    return null
  }

  /** 连回来了：在跑的换了一份就算成了 */
  const settle = () => {
    stopWaiting()
    const ids = caught
    caught = []
    if (ids.length > 0) options.interrupted(ids)
    phase = { step: 'done', at: clock.now(), interrupted: ids.length }
  }

  const stop = async (ifIdle: boolean): Promise<void> => {
    set({ step: 'stopping' })
    let result: RemoteStopResult
    try {
      result = await options.stop(ifIdle, cancel.signal)
    } catch (error) {
      if (cancel.signal.aborted) return
      const reason = toConnectError(error)
      set(failed('connect', reason.text, reason.detail))
      return
    }
    if (cancel.signal.aborted) return
    switch (result.result) {
      case 'stopped':
        set({ step: 'starting' })
        waitTimer = clock.setTimer(() => {
          waitTimer = null
          if (phase.step !== 'starting') return
          const failure = seen.online ? null : seen.failure
          set(
            failed(seen.online ? 'stale' : 'start', failure?.text ?? null, failure?.detail ?? null),
          )
        }, RESTART_WAIT_MS)
        options.reconnect()
        return
      case 'busy':
        caught = []
        set({ step: 'busy', busy: result.busy })
        return
      case 'legacy':
        set(failed('legacy', null, result.said))
        return
      case 'unsupported':
        set(failed('unsupported', null, result.said))
        return
      case 'failed':
        set(failed('stop', null, result.said))
    }
  }

  return {
    view: () => ({ blocked: blocked(), phase }),

    seen(state) {
      seen = state
      if (phase.step === 'starting') {
        if (state.online && state.full) {
          // 连回来的还是原来那一份：多半是旧的连接还没断干净，等它断开重连；到点还是它就算没成
          const now = keyOf(state.service)
          if (now === null || now !== before) settle()
        } else if (!state.online && state.failure && !state.failure.retrying) {
          stopWaiting()
          caught = []
          phase = failed('start', state.failure.text, state.failure.detail)
        }
        return
      }
      // 断开了：“已重启”和等人决定的那一步都不再算数
      if (!state.online && (phase.step === 'done' || phase.step === 'busy')) {
        phase = { step: 'idle' }
      }
    },

    run(mode) {
      if (mode === 'dismiss') {
        if (phase.step === 'busy' || phase.step === 'done' || phase.step === 'failed') {
          set({ step: 'idle' })
        }
        return
      }
      if (job || phase.step === 'stopping' || phase.step === 'starting') {
        throw new ChannelError('rejected', '上一次重启还没有做完')
      }
      const why = blocked()
      if (why !== null) throw new ChannelError('rejected', `现在不能重启设备服务：${why}`)
      before = keyOf(seen.service)
      caught = mode === 'force' ? options.sessions().map((entry) => entry.id) : []
      log(mode === 'force' ? `不等空闲，打断 ${caught.length} 个会话` : '空闲时停')
      job = stop(mode === 'start')
        .catch((error: unknown) => log(`意外的错误：${String(error)}`))
        .finally(() => {
          job = null
        })
    },

    dispose() {
      stopWaiting()
      cancel.abort()
    },
  }
}
