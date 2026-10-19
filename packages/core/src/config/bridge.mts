// litch_config 执行器和界面之间的那一条（config 主题，model-config.mts）：真的核心和模拟核心共用。
// - 要界面做的事（外观、语言、两个本地偏好、打开某一页、出码对话框）只交给一个窗口：最近订阅的那个。
//   它做完用 config.reply 回；它关掉了、到点没回，这件事就算没做成。一个窗口都没开着时当场没做成。
// - 放宽安全的那几项（E6）出确认卡：每个开着的窗口都有，谁先点算谁的；两分钟没人理当拒绝。
//   一个窗口都没开着时当场拒绝：没人看得到卡片。
import type { Clock } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type {
  ConfigConfirmView,
  ConfigTopicOp,
  ConfigTopicView,
  ConfigUiAsk,
  ConfigUiRequest,
} from '../model-config.mjs'

/** 确认卡等多久 */
export const CONFIRM_TIMEOUT_MS = 120_000
/** 要界面做的事等多久（都是点一下就成的事） */
export const ASK_TIMEOUT_MS = 15_000

export type ConfirmOutcome = 'allow' | 'decline' | 'timeout' | 'nowindow'

/** 界面没做成：reason 是给模型看的一句（英文），window 为真是因为没有开着的窗口 */
export class ConfigUiError extends Error {
  readonly window: boolean
  constructor(message: string, window = false) {
    super(message)
    this.name = 'ConfigUiError'
    this.window = window
  }
}

export interface ConfigBridge {
  /** config 主题的订阅 */
  subscribe(sink: HostSink): () => void
  /** 界面回话。对不上号返回 false */
  reply(id: string, ok: boolean, data: unknown, reason: string | null): boolean
  /** 确认卡上点了。对不上号返回 false */
  answer(id: string, allow: boolean): boolean
  /** 请界面做一件事，等它回话 */
  ask(request: ConfigUiRequest): Promise<unknown>
  /** 出一张确认卡，等人点 */
  confirm(card: Omit<ConfigConfirmView, 'id' | 'expiresAt'>): Promise<ConfirmOutcome>
  /** 现在开着几个窗口 */
  viewers(): number
}

interface PendingAsk {
  ask: ConfigUiAsk
  sink: HostSink
  resolve(data: unknown): void
  reject(error: ConfigUiError): void
  stopTimer(): void
}

interface PendingConfirm {
  view: ConfigConfirmView
  resolve(outcome: ConfirmOutcome): void
  stopTimer(): void
}

export function createConfigBridge(clock: Clock): ConfigBridge {
  /** 按订阅的先后：最后一个是要做事的那个窗口 */
  const sinks: HostSink[] = []
  const asks = new Map<string, PendingAsk>()
  const confirms = new Map<string, PendingConfirm>()
  let seq = 0

  const viewOf = (sink: HostSink): ConfigTopicView => ({
    asks: [...asks.values()].filter((entry) => entry.sink === sink).map((entry) => entry.ask),
    confirms: [...confirms.values()].map((entry) => entry.view),
  })

  const emit = () => {
    for (const sink of sinks) {
      const ops: ConfigTopicOp[] = [{ op: 'config.set', view: viewOf(sink) }]
      sink.delta(ops)
    }
  }

  const settleAsk = (id: string): PendingAsk | undefined => {
    const entry = asks.get(id)
    if (!entry) return undefined
    asks.delete(id)
    entry.stopTimer()
    return entry
  }

  const settleConfirm = (id: string, outcome: ConfirmOutcome): boolean => {
    const entry = confirms.get(id)
    if (!entry) return false
    confirms.delete(id)
    entry.stopTimer()
    entry.resolve(outcome)
    emit()
    return true
  }

  return {
    subscribe(sink) {
      sinks.push(sink)
      sink.snapshot(viewOf(sink))
      return () => {
        const at = sinks.indexOf(sink)
        if (at >= 0) sinks.splice(at, 1)
        // 交给它的事做不成了
        for (const entry of [...asks.values()]) {
          if (entry.sink !== sink) continue
          settleAsk(entry.ask.id)
          entry.reject(new ConfigUiError('The Litch window was closed before it finished.', true))
        }
      }
    },

    reply(id, ok, data, reason) {
      const entry = settleAsk(id)
      if (!entry) return false
      if (ok) entry.resolve(data)
      else entry.reject(new ConfigUiError(reason || 'The Litch window could not do it.'))
      emit()
      return true
    },

    answer: (id, allow) => settleConfirm(id, allow ? 'allow' : 'decline'),

    ask(request) {
      const sink = sinks.at(-1)
      if (!sink) {
        return Promise.reject(
          new ConfigUiError(
            'No Litch window is open. Ask the user to open the Litch window, then try again.',
            true,
          ),
        )
      }
      const id = `cfg-ask-${++seq}`
      return new Promise((resolve, reject) => {
        const stopTimer = clock.setTimer(() => {
          if (!settleAsk(id)) return
          reject(new ConfigUiError('The Litch window did not answer in time.'))
          emit()
        }, ASK_TIMEOUT_MS)
        asks.set(id, { ask: { id, request }, sink, resolve, reject, stopTimer })
        emit()
      })
    },

    confirm(card) {
      if (sinks.length === 0) return Promise.resolve('nowindow')
      const id = `cfg-confirm-${++seq}`
      return new Promise((resolve) => {
        const stopTimer = clock.setTimer(() => settleConfirm(id, 'timeout'), CONFIRM_TIMEOUT_MS)
        confirms.set(id, {
          view: { ...card, id, expiresAt: clock.now() + CONFIRM_TIMEOUT_MS },
          resolve,
          stopTimer,
        })
        emit()
      })
    },

    viewers: () => sinks.length,
  }
}
