// 模拟核心里远程设备服务的一键升级。平时远程设备上的服务和应用是同一版，没什么可说的；
// 在远程设备的会话里发下面的关键字，那台设备上的服务就变成比应用旧，点“升级”之后按这一出往下演：
//   远程服务旧（remote service is old）            装好了马上换上：安装、请它空闲时停、重连，换上新版
//   远程服务旧而忙（remote service is busy）        装好了等空闲：它不闲；“立即重试”时本机这台设备上还有回合在跑就照旧等，
//                                                  都闲了才换上；“立即换上”不等
//   远程下载失败（remote download fails）           下载安装脚本失败（连不上 GitHub）
//   远程配方没跟上（remote formula is behind）      Homebrew 装的，brew upgrade 之后还是旧的
// 真的状态机在 device/service-upgrade.mts；这里只照它的样子摆出各步的显示数据。
import { ChannelError, type Clock } from '../channel/protocol.mjs'
import type { DeviceView } from '../model.mjs'
import type { RemoteUpgradePhase, RemoteUpgradeView, ServiceBusyView } from '../model-service.mjs'
import { phrase } from '../phrase.mjs'
import { SERVICE_VERSIONS } from './sample-service.mjs'

export type RemoteScene = 'swap' | 'busy' | 'download' | 'behind'

/** 话里带哪些字样演哪一出。“旧而忙”要排在“旧”前面 */
const SCENES: readonly (readonly [RegExp, RemoteScene])[] = [
  [/远程服务旧而忙|remote service is busy/i, 'busy'],
  [/远程服务旧|remote service is old/i, 'swap'],
  [/远程下载失败|remote download fails/i, 'download'],
  [/远程配方没跟上|remote formula is behind/i, 'behind'],
]

/** “配方没跟上”那一出里 brew 装上的版本：比在跑的新，仍比应用旧 */
const BREW_BEHIND = '0.6.1'

/** 远端的原话，照它们真的会说的样子编的（curl 和 brew 只说英文） */
const SAID = {
  download: 'curl: (6) Could not resolve host: github.com',
  behind: `Warning: codex-harness-adapter ${BREW_BEHIND} already installed`,
}

export interface MockRemoteUpgradeHost {
  clock: Clock
  stepMs: number
  device(deviceId: string): DeviceView | undefined
  patch(deviceId: string, patch: Partial<DeviceView>): void
  /** 这台设备上有回合在跑、或者有请求停着等人的那几个 harness（标识） */
  engaged(deviceId: string): string[]
}

export interface MockRemoteUpgrade {
  /** 话里带着哪一出的关键字就演哪一出。只在连着的远程设备上演 */
  stage(deviceId: string, text: string): void
  run(deviceId: string, mode: 'start' | 'retry' | 'force'): void
}

const ROOTS = {
  script: (version: string) => `/home/dev/.local/share/codex-harness-adapter/${version}/libexec`,
  brew: (version: string) =>
    `/home/linuxbrew/.linuxbrew/Cellar/codex-harness-adapter/${version}/libexec`,
}

export function createMockRemoteUpgrade(host: MockRemoteUpgradeHost): MockRemoteUpgrade {
  const { clock } = host
  const scenes = new Map<string, RemoteScene>()
  /** 每一步之间隔多久 */
  const later = (run: () => void, steps = 10) =>
    clock.setTimer(run, Math.max(host.stepMs * steps, 1))

  const remote = (deviceId: string): DeviceView | null => {
    const device = host.device(deviceId)
    return device?.kind === 'ssh' ? device : null
  }

  const set = (
    deviceId: string,
    phase: RemoteUpgradePhase,
    patch: Partial<RemoteUpgradeView> = {},
  ) => {
    const view = remote(deviceId)?.remoteUpgrade
    if (view) host.patch(deviceId, { remoteUpgrade: { ...view, ...patch, phase } })
  }

  /** 演到“它不闲”时逐条的原因：本机这台设备上在跑的回合之外，再编上一个终端 */
  const busyOf = (deviceId: string): ServiceBusyView[] => {
    const turns = host.engaged(deviceId)
    return [
      ...(turns.length > 0 ? [{ reason: 'activeTurns', harnesses: turns, count: 0 }] : []),
      { reason: 'deviceProcesses', harnesses: [], count: 1 },
    ]
  }

  /** 停了、重连上来就是新版 */
  const swapIn = (deviceId: string) => {
    const from = remote(deviceId)?.service?.version ?? null
    set(deviceId, { step: 'reconnecting' })
    host.patch(deviceId, { connection: 'reconnecting', note: phrase('connect.adapterStarting') })
    later(() => {
      const device = remote(deviceId)
      if (!device?.service || !device.remoteUpgrade) return
      const to = SERVICE_VERSIONS.bundled
      host.patch(deviceId, {
        connection: 'online',
        note: null,
        service: {
          ...device.service,
          version: to,
          root: device.service.root.replace(/\/[^/]+\/libexec$/, `/${to}/libexec`),
          pid: device.service.pid + 1,
          startedAt: clock.now(),
        },
        remoteUpgrade: { ...device.remoteUpgrade, running: to, phase: { step: 'done', from, to } },
      })
    })
  }

  return {
    stage(deviceId, text) {
      const scene = SCENES.find(([pattern]) => pattern.test(text))?.[1]
      const device = remote(deviceId)
      if (!scene || !device || device.connection !== 'online' || !device.service) return
      scenes.set(deviceId, scene)
      const method = scene === 'behind' ? 'brew' : 'script'
      const running = SERVICE_VERSIONS.older
      host.patch(deviceId, {
        service: {
          ...device.service,
          version: running,
          root: ROOTS[method](running),
          detached: true,
        },
        remoteUpgrade: {
          target: SERVICE_VERSIONS.bundled,
          running,
          installed: running,
          method,
          managed: false,
          action: 'upgrade',
          capable: true,
          phase: { step: 'idle' },
        },
      })
    },

    run(deviceId, mode) {
      const view = remote(deviceId)?.remoteUpgrade
      if (!view) throw new ChannelError('rejected', '在跑的服务不比应用旧')
      const scene = scenes.get(deviceId) ?? 'swap'
      if (mode !== 'start') {
        if (view.phase.step !== 'waiting') throw new ChannelError('rejected', '没有在等服务空闲')
        if (mode === 'force') {
          set(deviceId, { step: 'stopping', force: true })
          later(() => swapIn(deviceId))
          return
        }
        set(deviceId, { step: 'waiting', busy: view.phase.busy, checking: true })
        later(() => {
          // 那个终端这时已经关了，只看还有没有回合
          const turns = host.engaged(deviceId)
          if (turns.length > 0) {
            set(deviceId, {
              step: 'waiting',
              busy: [{ reason: 'activeTurns', harnesses: turns, count: 0 }],
              checking: false,
            })
          } else swapIn(deviceId)
        })
        return
      }
      set(deviceId, { step: 'installing' })
      later(() => {
        if (scene === 'download') {
          set(deviceId, { step: 'failed', at: 'download', text: null, detail: SAID.download })
          return
        }
        if (scene === 'behind') {
          const installed = BREW_BEHIND
          set(
            deviceId,
            { step: 'failed', at: 'behind', text: null, detail: SAID.behind },
            { installed },
          )
          return
        }
        set(
          deviceId,
          { step: 'stopping', force: false },
          { installed: SERVICE_VERSIONS.bundled, action: 'swap' },
        )
        later(() => {
          if (scene === 'busy') {
            set(deviceId, { step: 'waiting', busy: busyOf(deviceId), checking: false })
          } else swapIn(deviceId)
        })
      }, 20)
    },
  }
}
