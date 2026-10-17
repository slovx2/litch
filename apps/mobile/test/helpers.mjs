// 单元测试共用的小东西：React Native 有、Node 没有的帧回调，接到模拟核心上的通道，等到某个条件成立。
import { connectChannel, createMockCore, createPortPair, serveChannel } from '@litch/core'

// 会话存储按帧交给界面（requestAnimationFrame），Node 里没有：拿 16 毫秒的定时器顶上
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(performance.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)

export const realClock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

/** 模拟核心加一对内存端口，和 src/shell/boot.ts 的 mock 装法一样。chunkMs 小一点让流式回答快点出完 */
export function mockChannel({ chunkMs = 2, lang = 'zh-CN' } = {}) {
  const [uiPort, corePort] = createPortPair()
  const unserve = serveChannel(corePort, createMockCore({ clock: realClock, chunkMs, lang }), {
    clock: realClock,
  })
  const channel = connectChannel(uiPort)
  return {
    channel,
    close() {
      channel.close()
      unserve()
    },
  }
}

/** 每 10 毫秒看一次，成立了返回它的值；超时报错并带上最后一次看到的东西 */
export async function until(check, { timeoutMs = 5000, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = check()
    if (last) return last
    if (Date.now() > deadline) throw new Error(`等不到${what}`)
    await new Promise((done) => setTimeout(done, 10))
  }
}
