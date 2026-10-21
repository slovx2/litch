// 回合进行中发消息怎么处理（设置页“对话”一组）：立即发送是插进正在进行的回合（核心 session.send 带 now，
// 对面是 turn/steer），排队是等这个回合结束再发（排着的仍可以点“现在就说”）。全局一份，不分设备和 harness。
// 这里只放判断，记在哪、怎么变在 send-mode.ts。

export type SendMode = 'now' | 'queue'
export const SEND_MODES: readonly SendMode[] = ['now', 'queue']
export const DEFAULT_SEND_MODE: SendMode = 'now'

/** 本机存着的那一份（`{"mode":"queue"}`）：读不懂的、没有的都按默认 */
export function readSendMode(raw: string | null): SendMode {
  if (!raw) return DEFAULT_SEND_MODE
  try {
    const mode = (JSON.parse(raw) as { mode?: unknown } | null)?.mode
    return SEND_MODES.find((entry) => entry === mode) ?? DEFAULT_SEND_MODE
  } catch {
    return DEFAULT_SEND_MODE
  }
}

/**
 * 回合进行中按下发送会怎样：steer 插进去；queue 排队（选的就是排队）；
 * fallback 选的是立即发送，可这个会话插不了话（harness 声明了不会，或者试过对面不认识），只好排队
 */
export type RunningSend = 'steer' | 'queue' | 'fallback'

export function runningSend(mode: SendMode, canSteer: boolean): RunningSend {
  if (mode === 'queue') return 'queue'
  return canSteer ? 'steer' : 'fallback'
}

/** 回合进行中输入框里的提示用哪一句 */
export function runningPlaceholder(
  send: RunningSend,
): 'composer.placeholderSteer' | 'composer.placeholderRunning' | 'composer.placeholderNoSteer' {
  if (send === 'steer') return 'composer.placeholderSteer'
  if (send === 'fallback') return 'composer.placeholderNoSteer'
  return 'composer.placeholderRunning'
}
