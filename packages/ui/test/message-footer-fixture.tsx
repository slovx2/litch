// 隔离的消息收尾场景，只由无头浏览器验收入口加载。
import {
  type Clock,
  type CoreHost,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type HostSink,
  projectThread,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import type { Thread } from '../../protocol/src/index.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { Transcript } from '../src/transcript/Transcript.tsx'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/sometype-mono/400.css'
import '@fontsource/literata/400.css'
import '../src/styles/index.css'

const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = window.setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const mock = createMockCore({ clock })
const statuses = ['completed', 'failed', 'interrupted', 'completed', 'inProgress'] as const
const view = projectThread(
  {
    id: 'footer-fixture',
    cwd: '/',
    turns: statuses.map((status, index) => ({
      id: `t${index}`,
      status,
      error: status === 'failed' ? { message: '隔离失败示例' } : null,
      items:
        index === 3
          ? []
          : [
              { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '检查收尾' }] },
              // 同回合两条回答都应能复制各自原文，状态只出现一次。
              ...(index === 0
                ? [{ id: 'early', type: 'agentMessage', text: '较早回答', phase: 'final_answer' }]
                : []),
              {
                id: 'a',
                type: 'agentMessage',
                text: `回答 ${index}：**完整 Markdown**。`,
                phase: 'final_answer',
              },
            ],
    })),
  } as unknown as Thread,
  { deviceId: 'local', harness: 'claude' },
)
for (const turn of view.turns) {
  turn.startedAt = Date.now() - 447_000
  turn.durationMs = turn.status === 'running' ? null : 447_000
}
const liveAnswer = view.items['t4:a']
if (liveAnswer?.kind === 'agentMessage') liveAnswer.status = 'inProgress'
// 离线历史也必须能复制，不依赖会话可操作能力。
view.live = false
let sink: HostSink | null = null
const host: CoreHost = {
  command: (name, args, signal) => mock.command(name, args, signal),
  subscribe(topic, receiver) {
    if (topic.kind === 'session' && topic.sessionId === view.sessionId) {
      sink = receiver
      receiver.snapshot(view)
      return () => {
        sink = null
      }
    }
    return mock.subscribe(topic, receiver)
  },
}
const [client, server] = createPortPair()
serveChannel(server, host, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
Object.assign(window, {
  footerFixture: {
    older() {
      for (const turn of view.turns) turn.startedAt = Date.UTC(2025, 0, 1)
      sink?.snapshot(view)
    },
    finish() {
      const turn = view.turns.at(-1)!
      turn.status = 'completed'
      turn.durationMs = 447_000
      if (liveAnswer?.kind === 'agentMessage') liveAnswer.status = 'completed'
      sink?.snapshot(view)
    },
  },
})
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <div style={{ height: '100vh', display: 'flex' }}>
      <main className="main">
        <Transcript deviceId="local" sessionId="footer-fixture" footer={<span>隔离验收</span>} />
      </main>
    </div>
  </ServicesProvider>,
)
