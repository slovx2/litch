import type { Clock } from '../src/index.mjs'

/** 手动拨动的时钟：定时器只在 advance 时触发 */
export function fakeClock(start = 1_700_000_000_000) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: Clock = {
    now: () => now,
    setTimer(callback, delayMs) {
      const id = seq++
      timers.set(id, { at: now + delayMs, callback })
      return () => {
        timers.delete(id)
      }
    },
  }
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        let dueId: number | null = null
        let dueAt = Number.POSITIVE_INFINITY
        for (const [id, timer] of timers) {
          if (timer.at <= end && timer.at < dueAt) {
            dueId = id
            dueAt = timer.at
          }
        }
        if (dueId === null) break
        const timer = timers.get(dueId)
        timers.delete(dueId)
        now = dueAt
        timer?.callback()
      }
      now = end
    },
  }
}

/** 等同线程端口把积压的消息送完 */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** 建会话的参数去掉 dynamicTools：呈现风格（litch_presentation）每个会话都带，和只看别的参数的用例无关 */
export const withoutTools = (sent: unknown[]): unknown[] =>
  sent.map((params) => {
    const { dynamicTools: _tools, ...rest } = params as Record<string, unknown>
    return rest
  })
