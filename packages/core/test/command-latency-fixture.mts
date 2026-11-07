// 两端延迟应答验收：控制核心应答与终态各自到达的时机。

import type { Thread } from '../../protocol/src/index.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import type { CoreHost, HostSink } from '../src/channel/server.mjs'
import { projectThread } from '../src/projection/session.mjs'

export function commandLatencyFixture(mock: CoreHost) {
  const calls: string[] = []
  let resolve: ((value: object) => void) | undefined
  let reject: ((error: Error) => void) | undefined
  let running = true
  const sinks = new Map<string, HostSink>()
  const view = (deviceId: string, sessionId: string) => {
    const result = projectThread(
      {
        id: sessionId,
        cwd: '/',
        turns: [
          {
            id: 't0',
            status: running ? 'inProgress' : 'interrupted',
            error: null,
            items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '原消息' }] }],
          },
        ],
      } as unknown as Thread,
      { deviceId, harness: 'claude' },
    )
    result.live = true
    result.can.rollback = true
    return result
  }
  const state = {
    calls,
    ack: () => resolve?.({}),
    fail: (code: 'timeout' | 'internal' = 'internal') =>
      reject?.(new ChannelError(code, '延迟引擎拒绝')),
    end() {
      running = false
      for (const [key, receiver] of sinks) {
        const [deviceId, sessionId] = JSON.parse(key) as [string, string]
        receiver.snapshot(view(deviceId, sessionId))
      }
    },
  }
  const core: CoreHost = {
    command(name, args, signal) {
      if (name !== 'session.interrupt' && name !== 'session.edit')
        return mock.command(name, args, signal)
      calls.push(name)
      return new Promise((yes, no) => {
        resolve = yes
        reject = no
      })
    },
    subscribe(topic, receiver) {
      if (topic.kind !== 'session') return mock.subscribe(topic, receiver)
      const key = JSON.stringify([topic.deviceId, topic.sessionId])
      sinks.set(key, receiver)
      receiver.snapshot(view(topic.deviceId, topic.sessionId))
      return () => {
        sinks.delete(key)
      }
    },
  }
  return { core, state }
}
