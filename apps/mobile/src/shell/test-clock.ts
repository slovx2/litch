import type { Clock } from '@litch/core'

/** 只由测试启动链接启用；仅推进场景状态，回答流和 UI 仍使用真实计时器。 */
export function createTestClock(start: number) {
  let now = start
  const timers = new Map<() => void, number>()
  const clock: Clock = {
    now: () => now,
    setTimer(run, ms) {
      timers.set(run, now + ms)
      return () => timers.delete(run)
    },
  }
  return {
    clock,
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) throw new Error('无效的测试时钟步长')
      const end = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1] - b[1])[0]
        if (!next || next[1] > end) break
        now = next[1]
        timers.delete(next[0])
        next[0]()
      }
      now = end
    },
  }
}

export const testScenario = { controlled: false, terminalAudit: false }
