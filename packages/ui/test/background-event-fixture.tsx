import '../src/styles/index.css'
import {
  connectChannel,
  createCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { fakeOpener, type Handler } from '../../core/test/fake-server.mts'
import { agentText, thread, turn, userText } from '../../core/test/fixtures.mts'
import { formatBackgroundCompletion } from '../../protocol/src/native-background-wake.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import type {} from '../src/boot/channel.ts'
import { Transcript } from '../src/transcript/Transcript.tsx'

const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const text = formatBackgroundCompletion({
  batchId: 'nebula-build',
  events: [
    {
      taskId: 'nebula-job',
      originalTurnId: 'before',
      itemId: 'build',
      title: '星云项目构建',
      purpose: '读取构建结果',
      purposeTruncated: false,
      status: 'completed',
      exitCode: 0,
      signal: 'unknown',
      durationMs: 800,
      output: '构建完成，所有检查通过。',
      outputMayBeTruncated: false,
      truncated: false,
    },
  ],
})
const input = { ...userText('completion', text), litchOrigin: 'backgroundTask' }
const session = thread({
  id: 'nebula',
  name: '星云项目',
  turns: [
    turn(
      'working',
      [userText('request', '请检查星云项目的构建结果。'), agentText('reply', '正在检查构建结果。')],
      { status: 'inProgress' },
    ),
  ],
})
let resumes = 0
const handlers: Record<string, Handler> = {
  'runtime/info': () => ({
    engine: 'codex',
    protocolVersion: '0.166.0',
    capabilities: [],
    releaseReady: true,
  }),
  'project/list': () => ({ data: [], nextCursor: null }),
  'thread/list': () => ({ data: [session], nextCursor: null }),
  'thread/read': () => ({ thread: session }),
  'thread/resume': () => {
    resumes++
    return {
      thread: { ...session, turns: [] },
      initialTurnsPage: { data: [...session.turns].reverse(), nextCursor: null },
    }
  },
  'model/list': () => ({ data: [], nextCursor: null }),
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
}
const peer = fakeOpener(handlers)
const core = createCore({
  clock,
  version: '9.9.9',
  devices: [
    {
      id: 'local',
      name: '星云设备',
      host: 'dev@nebula',
      kind: 'local',
      target: null,
      wire: 'green',
      open: peer.open,
    },
  ],
})
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
core.start()
Object.assign(window, {
  backgroundFixture: {
    complete() {
      session.turns[0]?.items.push(input)
      peer.last().notify('item/started', { threadId: session.id, turnId: 'working', item: input })
      peer.last().notify('item/completed', { threadId: session.id, turnId: 'working', item: input })
    },
    reopen() {
      peer.last().drop()
    },
    resumes: () => resumes,
  },
})
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <main
      style={{
        width: 760,
        height: 720,
        margin: '24px auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <h3>星云项目 · 后台任务</h3>
      <Transcript deviceId="local" sessionId="nebula" />
    </main>
  </ServicesProvider>,
)
