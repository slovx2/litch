// 隔离验收：正式 Transcript、通道和副本，只注入模拟的长回合，不连接真实 harness。
import {
  type Clock,
  type CoreHost,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type HostSink,
  type ItemView,
  projectThread,
  reduceSession,
  type SessionOp,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import type { Thread } from '../../protocol/src/index.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { Transcript } from '../src/transcript/Transcript.tsx'
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
    id: 'live-process',
    name: '过程分段验收',
    cwd: '/',
    preview: '',
    turns: [{ id: 't', status: 'inProgress', items: [] }],
  } as unknown as Thread,
  { deviceId: 'local', harness: 'codex' },
)
view.can.finalOnStart = true
view.live = true
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
const apply = (...ops: SessionOp[]) => {
  for (const op of ops) reduceSession(view, op)
  sink?.delta(ops)
}
const add = (item: ItemView) => apply({ op: 'item.add', turnId: 't', item })
const message = (id: string, text: string, phase: 'commentary' | 'final' = 'commentary') =>
  add({
    id,
    kind: 'agentMessage',
    text,
    phase,
    status: 'completed',
  })
const user = (id: string) =>
  add({
    id,
    kind: 'userMessage',
    text: '继续检查',
    attachments: [],
    ...(id === 'u0'
      ? {}
      : { peer: { name: id === 'u1' ? '经理' : '父会话', session: null, bypass: false } }),
  })
const command = (id: string, status: 'completed' | 'inProgress') =>
  add({
    id,
    kind: 'command',
    command: 'npm test',
    cwd: '/',
    output: '',
    elided: null,
    exitCode: status === 'completed' ? 0 : null,
    durationMs: null,
    startedAt: null,
    status,
  })
Object.assign(window, {
  liveProcess: {
    start() {
      user('u0')
      message('n0', '第一段说明')
      command('c0', 'inProgress')
      message('a0', '第一段结论', 'final')
      user('u1')
      message('n1', '第二段说明')
      message('a1', '第二段结论', 'final')
      user('u2')
      message('before', `正在继续工作\n\n${'长回合已有的说明。\n\n'.repeat(40)}`)
      add({ id: 'compact', kind: 'compaction', status: 'inProgress', source: 'automatic' })
    },
    finishEarlier() {
      command('c0', 'completed')
    },
    compacted() {
      add({ id: 'compact', kind: 'compaction', status: 'completed', source: 'automatic' })
    },
    append(index: number) {
      if (index > 0) apply({ op: 'item.status', itemId: `note-${index - 1}`, status: 'completed' })
      add({
        id: `note-${index}`,
        kind: 'agentMessage',
        phase: 'commentary',
        status: 'inProgress',
        text: `新增说明 ${index}\n\n${'压缩后继续检查。\n\n'.repeat(5)}`,
      })
      command(`tool-${index}`, 'completed')
    },
    delta() {
      apply({ op: 'item.appendText', itemId: 'note-4', field: 'text', text: '\n\n流式增量可见' })
    },
    final() {
      apply({ op: 'item.status', itemId: 'note-4', status: 'completed' })
      message('final', '最终回答', 'final')
    },
    finish() {
      apply({ op: 'turn.status', turnId: 't', status: 'completed', durationMs: 7200000 })
    },
  },
})
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <div style={{ height: '100vh', display: 'flex' }}>
      <main className="main">
        <Transcript deviceId="local" sessionId={view.sessionId} footer={<span>隔离验收</span>} />
      </main>
    </div>
  </ServicesProvider>,
)
