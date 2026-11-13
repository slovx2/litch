import '../src/styles/index.css'
import {
  connectChannel,
  createCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { SAMPLE_TOOL_IMAGES, sampleToolImage } from '../../core/src/mock/sample-tool-images.mts'
import { fakeOpener, type Handler } from '../../core/test/fake-server.mts'
import { agentText, thread, turn, userText } from '../../core/test/fixtures.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import type {} from '../src/boot/channel.ts'
import { Transcript } from '../src/transcript/Transcript.tsx'

const automatic = new URLSearchParams(location.search).get('mode') === 'auto'
const imageItem = {
  type: 'imageView' as const,
  id: 'image',
  path: '/work/nebula/capture.png',
  litchToolImages: SAMPLE_TOOL_IMAGES.slice(0, 1),
}
const active = turn(
  'working',
  [userText('request', '请检查星云项目的截图。'), imageItem, agentText('reply', '截图检查完成。')],
  { status: automatic ? 'inProgress' : 'completed' },
)
const session = thread({ id: 'nebula', name: '星云项目', turns: [active] })
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
  'thread/resume': () => ({ thread: session }),
  'model/list': () => ({ data: [], nextCursor: null }),
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
}
const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const peer = fakeOpener(handlers)
const core = createCore({
  clock,
  version: '9.9.9',
  devices: [
    {
      id: 'local',
      name: '星云设备',
      host: 'loopback',
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
const requests: unknown[] = []
channel.command = new Proxy(channel.command, {
  apply(target, receiver, args) {
    if (args[0] === 'media.image') {
      requests.push(args[1])
      return Promise.resolve(sampleToolImage(args[1].source))
    }
    return Reflect.apply(target, receiver, args)
  },
})
const replica = createReplica(channel)
replica.start()
core.start()
Object.assign(window, {
  toolImageFirstOpen: {
    requests,
    complete() {
      active.status = 'completed'
      peer.last().notify('turn/completed', { threadId: session.id, turn: active })
    },
  },
})
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <main
      style={{
        width: 760,
        height: 680,
        margin: '24px auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <h3>星云项目 · 工具图片首次查看</h3>
      <Transcript deviceId="local" sessionId="nebula" />
    </main>
  </ServicesProvider>,
)
