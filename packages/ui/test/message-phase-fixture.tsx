// 正式对话组件、模拟核心与隔离的协议回合；不连接用户的设备或会话。
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
import type { Thread, ThreadItem } from '../../protocol/src/index.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { Transcript } from '../src/transcript/Transcript.tsx'
import { setTranscriptView } from '../src/transcript/view.ts'
import '../src/styles/index.css'

const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = window.setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'claude'
const message = (id: string, text: string, phase: string | null) => ({
  id,
  type: 'agentMessage',
  text,
  phase,
})
const tool = (id: string) => ({
  id,
  type: 'dynamicToolCall',
  tool: 'inspect',
  arguments: { file: id },
  status: 'completed',
  success: true,
  contentItems: [{ type: 'inputText', text: `工具输出 ${id}` }],
})
const items = [
  {
    id: 'u',
    type: 'userMessage',
    content: [{ type: 'text', text: '检查回合结束后的文字与工具。' }],
  },
  message('before', '开始检查：这段文字必须保留。', 'commentary'),
  tool('one'),
  message(
    'finding',
    '重要结论：中间发现的信息必须一直可见。',
    scenario === 'mixed' ? null : 'commentary',
  ),
  tool('two'),
  message('end', '检查完成。', 'final_answer'),
] as ThreadItem[]
const source = {
  id: `message-phase-${scenario}`,
  cwd: '/',
  turns: [{ id: 't', status: 'inProgress', error: null, durationMs: 9000, items }],
} as unknown as Thread
const scope = { deviceId: 'local', harness: scenario === 'claude' ? 'claude' : 'codex' }
let view = projectThread(source, scope)
view.live = true
const mock = createMockCore({ clock })
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
  phaseFixture: {
    finish() {
      const turn = source.turns[0]
      if (!turn) throw new Error('验收回合缺失')
      turn.status = 'completed'
      view = projectThread(source, scope)
      view.live = true
      sink?.snapshot(view)
    },
    verbose(value: boolean) {
      setTranscriptView(`local:${view.sessionId}`, value ? 'verbose' : 'compact')
    },
  },
})
const root = document.getElementById('root')
if (!root) throw new Error('验收容器缺失')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <div style={{ height: '100vh', display: 'flex' }}>
      <main className="main">
        <Transcript deviceId="local" sessionId={view.sessionId} footer={<span>隔离验收</span>} />
      </main>
    </div>
  </ServicesProvider>,
)
