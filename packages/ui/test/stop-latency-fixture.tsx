import {
  ChannelError,
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
import { SessionComposer } from '../src/composer/Composer.tsx'
import { Transcript } from '../src/transcript/Transcript.tsx'
import '../src/styles/index.css'

const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const mock = createMockCore({ clock })
const view = projectThread(
  {
    id: 'latency',
    cwd: '/',
    turns: [
      {
        id: 't0',
        status: 'inProgress',
        error: null,
        items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '原消息' }] }],
      },
    ],
  } as unknown as Thread,
  { deviceId: 'local', harness: 'claude' },
)
view.live = true
view.can.rollback = true
let sink: HostSink | null = null
let resolve: ((value: object) => void) | undefined
let reject: ((error: Error) => void) | undefined
const calls: string[] = []
const host: CoreHost = {
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
  latency: {
    calls,
    ack: () => resolve?.({}),
    fail: (code: 'timeout' | 'internal' = 'internal') =>
      reject?.(new ChannelError(code, '延迟引擎拒绝')),
    end() {
      view.turns[0]!.status = 'interrupted'
      sink?.snapshot(structuredClone(view))
    },
  },
})
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <main className="main" style={{ height: '100vh' }}>
      <Transcript
        deviceId="local"
        sessionId="latency"
        footer={<SessionComposer deviceId="local" sessionId="latency" />}
      />
    </main>
  </ServicesProvider>,
)
