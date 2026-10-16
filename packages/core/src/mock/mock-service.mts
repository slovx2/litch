// 模拟核心里的“设备服务”：本机上在跑的是哪一份、这一次连接换没换版本。
// 平时本机的服务就是应用自带的那一份，没什么可说的。别的情形由对话里的关键字来演，和设置的那几出一样
// （见 mock-core.mts；只在本机的会话里发才演，远程设备上应用不替用户换版本）：
//   服务换了新版（service was replaced）       这次连接把旧服务换成了应用自带的
//   服务旧而忙（service is busy）               在跑的比应用带的旧，但它不闲，没换
//   服务是前台的（service in the foreground）   在跑的是前台运行的，或者服务管理器管着，应用不替用户换
//   服务太旧（service is too old）              在跑的不认识停止的请求，要手工结束一次
//   服务没停成（service would not stop）        去停了，没停成
//   服务比应用新（service is newer）            在跑的比应用带的新，不打扰
// “现在再试一次”就是重新连这台设备（device.reconnect）。和真的一样，只在它闲着时才换：
// 本机上还有回合在跑、有请求停着等人，就照旧没换；都闲了才换成应用自带的。
import type { Clock } from '../channel/protocol.mjs'
import type { DeviceView } from '../model.mjs'
import type { ServiceBusyView } from '../model-service.mjs'
import { phrase } from '../phrase.mjs'
import { SERVICE_SCENES, sampleScene } from './sample-service.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface MockServiceHost {
  clock: Clock
  /** 流式回答每一小块之间隔多久。这里的“过一会儿”是它的倍数；0 表示不拖时间 */
  stepMs: number
  lang: SampleLang
  device(deviceId: string): DeviceView | undefined
  patch(deviceId: string, patch: Partial<DeviceView>): void
  /** 这台设备上有回合在跑、或者有请求停着等人的那几个 harness（标识） */
  engaged(deviceId: string): string[]
}

export interface MockService {
  /** 话里带着哪一出的关键字就演哪一出。只在本机上演；没带关键字、不是本机，什么都不做 */
  stage(deviceId: string, text: string): void
  /**
   * “现在再试一次”：这台设备是因为忙没换版本的本机，就重新连一次、再问一遍它闲不闲，返回 true；
   * 别的设备、别的情形不归这里管，返回 false
   */
  retry(deviceId: string): boolean
}

const turnsOf = (harnesses: string[]): ServiceBusyView[] =>
  harnesses.length > 0 ? [{ reason: 'activeTurns', harnesses, count: 0 }] : []

export function createMockService(host: MockServiceHost): MockService {
  const { clock, lang } = host
  /** 正在走的那次重新连接：取消函数 */
  const retrying = new Map<string, () => void>()

  const local = (deviceId: string): DeviceView | null => {
    const device = host.device(deviceId)
    return device?.kind === 'local' && device.connection === 'online' ? device : null
  }

  return {
    stage(deviceId, text) {
      const scene = SERVICE_SCENES.find(([pattern]) => pattern.test(text))?.[1]
      if (!scene || !local(deviceId)) return
      // 头一回说它忙：正在跑的回合之外，再编上一个终端和一个别的客户端，几种原因的说法都看得到
      const busy: ServiceBusyView[] = [
        ...turnsOf(host.engaged(deviceId)),
        { reason: 'deviceProcesses', harnesses: [], count: 1 },
        { reason: 'clients', harnesses: [], count: 1 },
      ]
      host.patch(deviceId, sampleScene(scene, clock.now(), lang, busy))
    },

    retry(deviceId) {
      const upgrade = local(deviceId)?.upgrade
      if (upgrade?.reason !== 'busy') return false
      retrying.get(deviceId)?.()
      // 丢掉这条连接重新连：连上之前先让服务起来（它本来就在跑），再问一遍它闲不闲
      host.patch(deviceId, { connection: 'reconnecting', note: phrase('connect.adapterStarting') })
      const settle = () => {
        retrying.delete(deviceId)
        // 那个终端和别的客户端这时已经不在了，只看还有没有回合
        const turns = host.engaged(deviceId)
        host.patch(deviceId, {
          connection: 'online',
          note: null,
          // 还忙：在跑的还是那一份，只是原因换成现在的；闲了：换成应用自带的
          ...(turns.length > 0
            ? { upgrade: { ...upgrade, busy: turnsOf(turns) } }
            : sampleScene('replaced', clock.now(), lang)),
        })
      }
      retrying.set(deviceId, clock.setTimer(settle, Math.max(host.stepMs * 10, 1)))
      return true
    },
  }
}
