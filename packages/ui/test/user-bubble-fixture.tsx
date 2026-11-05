// 正式对话组件与模拟核心，所有状态仅在此页面内。
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
import { useState } from 'react'
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
const view = projectThread(
  {
    id: 'user-bubble-fixture',
    cwd: '/',
    turns: [
      {
        id: 't0',
        status: 'completed',
        error: null,
        items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '初始短消息' }] }],
      },
    ],
  } as unknown as Thread,
  { deviceId: 'local', harness: 'claude' },
)
view.live = true
view.can.rollback = true
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
const fixture = {
  text(text: string) {
    const item = view.items['t0:u']
    if (item?.kind === 'userMessage') item.text = text
    sink?.snapshot(view)
  },
  remount: () => {},
}
Object.assign(window, { userBubbleFixture: fixture })
function App() {
  const [generation, setGeneration] = useState(0)
  fixture.remount = () => setGeneration((value) => value + 1)
  return (
    <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
      <div style={{ height: '100vh', display: 'flex' }}>
        <main className="main">
          <Transcript
            key={generation}
            deviceId="local"
            sessionId={view.sessionId}
            footer={<span>隔离验收</span>}
          />
        </main>
      </div>
    </ServicesProvider>
  )
}
const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
