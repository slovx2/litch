// 模拟核心里的重启设备服务（侧栏设备行“⋯”里那一项）。平时都能成：停、重连、换上一个新的进程号；
// 在一台设备的会话里发下面的关键字，那台设备的下一次重启按这一出演：
//   重启时忙（restart is busy）          空闲时停那一下说不闲（设备上有一个终端在跑），等用户决定
//   重启会失败（restart fails）          停了之后没能重新连上
// 有会话在跑时，界面先列出它们问过才发 force；重启成了，这些会话的回合记成中断，对话末尾说一句“发消息继续”。
// 真的状态机在 device/service-restart.mts；这里只照它的样子摆出各步的显示数据。
import { ChannelError, type Clock } from '../channel/protocol.mjs'
import type { DeviceView } from '../model.mjs'
import type {
  ServiceRestartBlock,
  ServiceRestartPhase,
  ServiceRestartSession,
  ServiceRestartView,
} from '../model-service.mjs'
import { phrase } from '../phrase.mjs'

type Scene = 'busy' | 'fails'

const SCENES: readonly (readonly [RegExp, Scene])[] = [
  [/重启时忙|restart is busy/i, 'busy'],
  [/重启会失败|restart fails/i, 'fails'],
]

export interface MockRestartHost {
  clock: Clock
  stepMs: number
  device(deviceId: string): DeviceView | undefined
  patch(deviceId: string, patch: Partial<DeviceView>): void
  /** 这台设备上现在重启会打断的会话 */
  sessions(deviceId: string): ServiceRestartSession[]
  /** 服务停了：这几个会话在跑的回合记成中断 */
  interrupt(deviceId: string, sessionIds: string[]): void
  /** 重启成了：这几个会话的侧栏那一行记下重启的时刻 */
  mark(deviceId: string, sessionIds: string[], at: number): void
}

export interface MockRestart {
  /** 这台设备现在的样子：没在做的时候按连接状态算能不能做 */
  viewOf(device: DeviceView): ServiceRestartView
  stage(deviceId: string, text: string): void
  sessions(deviceId: string): ServiceRestartSession[]
  /** 设备行下面点了“重试”：停了没连回来的那一台重新连上。不是这种情况返回 false */
  reconnect(deviceId: string): boolean
  run(deviceId: string, mode: 'start' | 'force' | 'dismiss'): void
}

export function createMockRestart(host: MockRestartHost): MockRestart {
  const { clock } = host
  const phases = new Map<string, ServiceRestartPhase>()
  const scenes = new Map<string, Scene>()
  const later = (run: () => void, steps = 10) =>
    clock.setTimer(run, Math.max(host.stepMs * steps, 1))

  const blockedOf = (device: DeviceView): ServiceRestartBlock | null => {
    if (device.connection !== 'online') return 'offline'
    if (device.mode !== 'full') return 'single'
    if (device.service && !device.service.detached) return 'managed'
    const step = device.remoteUpgrade?.phase.step
    if (step === 'installing' || step === 'stopping' || step === 'reconnecting') return 'upgrading'
    return null
  }

  const set = (deviceId: string, phase: ServiceRestartPhase, patch: Partial<DeviceView> = {}) => {
    phases.set(deviceId, phase)
    host.patch(deviceId, patch)
  }

  const viewOf = (device: DeviceView): ServiceRestartView => {
    let phase = phases.get(device.id) ?? { step: 'idle' }
    // 断开了：“已重启”和等人决定的那一步都不再算数（和真的一样）
    if (device.connection !== 'online' && (phase.step === 'done' || phase.step === 'busy')) {
      phase = { step: 'idle' }
      phases.delete(device.id)
    }
    return { blocked: blockedOf(device), phase }
  }

  const stopped = (deviceId: string, caught: string[]) => {
    if (caught.length > 0) host.interrupt(deviceId, caught)
    set(
      deviceId,
      { step: 'starting' },
      {
        connection: 'reconnecting',
        note: phrase('connect.adapterStarting'),
      },
    )
    later(() => {
      const device = host.device(deviceId)
      if (!device) return
      if (scenes.get(deviceId) === 'fails') {
        scenes.delete(deviceId)
        const text = phrase('connect.adapterStartFailed')
        const detail = 'device-start: the service exited before the aggregate socket was ready'
        set(
          deviceId,
          { step: 'failed', at: clock.now(), reason: 'start', text, detail },
          {
            connection: 'error',
            note: text,
            failure: { stage: 'startFailed', text, detail, retrying: false },
          },
        )
        return
      }
      const at = clock.now()
      if (caught.length > 0) host.mark(deviceId, caught, at)
      set(
        deviceId,
        { step: 'done', at, interrupted: caught.length },
        {
          connection: 'online',
          note: null,
          failure: null,
          ...(device.service
            ? { service: { ...device.service, pid: device.service.pid + 1, startedAt: at } }
            : {}),
        },
      )
    }, 20)
  }

  return {
    viewOf,

    sessions: (deviceId) => host.sessions(deviceId),

    reconnect(deviceId) {
      const phase = phases.get(deviceId)
      const device = host.device(deviceId)
      if (phase?.step !== 'failed' || phase.reason !== 'start' || device?.connection !== 'error') {
        return false
      }
      host.patch(deviceId, { connection: 'online', note: null, failure: null })
      return true
    },

    stage(deviceId, text) {
      const scene = SCENES.find(([pattern]) => pattern.test(text))?.[1]
      if (scene) scenes.set(deviceId, scene)
    },

    run(deviceId, mode) {
      const device = host.device(deviceId)
      if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
      const phase = phases.get(deviceId) ?? { step: 'idle' }
      if (mode === 'dismiss') {
        if (phase.step === 'busy' || phase.step === 'done' || phase.step === 'failed') {
          set(deviceId, { step: 'idle' })
        }
        return
      }
      if (phase.step === 'stopping' || phase.step === 'starting') {
        throw new ChannelError('rejected', '上一次重启还没有做完')
      }
      const why = blockedOf(device)
      if (why !== null) throw new ChannelError('rejected', `现在不能重启设备服务：${why}`)
      const caught = mode === 'force' ? host.sessions(deviceId).map((entry) => entry.id) : []
      set(deviceId, { step: 'stopping' })
      later(() => {
        if (mode === 'start' && scenes.get(deviceId) === 'busy') {
          scenes.delete(deviceId)
          set(deviceId, {
            step: 'busy',
            busy: [{ reason: 'deviceProcesses', harnesses: [], count: 1 }],
          })
          return
        }
        stopped(deviceId, caught)
      })
    },
  }
}
