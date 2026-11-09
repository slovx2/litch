// 界面验收夹具：只延迟建议开始，其余命令仍走模拟核心。
import type { CoreHost } from '../src/channel/server.mjs'

export function proposalStartFixture(core: CoreHost) {
  const calls: unknown[] = []
  let resolve: (() => void) | null = null
  let reject: ((reason: Error) => void) | null = null
  const state = {
    calls,
    ack: () => resolve?.(),
    fail: () => reject?.(new Error('隔离设备启动失败')),
  }
  const wrapped: CoreHost = {
    subscribe: (topic, sink) => core.subscribe(topic, sink),
    async command(name, args, signal) {
      if (name === 'session.proposal.accept') {
        calls.push(args)
        await new Promise<void>((yes, no) => {
          resolve = yes
          reject = no
        })
      }
      return core.command(name, args, signal)
    },
  }
  return { core: wrapped, state }
}
