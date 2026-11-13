import '../src/styles/index.css'
import '../src/app/appearance.ts'
import {
  connectChannel,
  createCore,
  createPortPair,
  createReplica,
  serveChannel,
  type TransportHandlers,
  type TransportOpener,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { Transcript } from '../src/transcript/Transcript.tsx'

// 接本次隔离真实设备；不注入协议历史，也不补造图片字段。
const open: TransportOpener = async () => {
  const ws = new WebSocket(`ws://${location.host}/tool-image-probe`)
  let handlers: TransportHandlers | null = null
  const queued: string[] = []
  ws.onmessage = (event) => {
    if (handlers) handlers.message(String(event.data))
    else queued.push(String(event.data))
  }
  ws.onclose = () => handlers?.close(null)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('隔离设备连接失败'))
  })
  return {
    send: (text) => ws.send(text),
    listen(next) {
      handlers = next
      for (const text of queued.splice(0)) next.message(text)
    },
    close: () => ws.close(),
  }
}
const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const core = createCore({
  clock,
  version: '9.9.9',
  devices: [
    {
      id: 'local',
      name: '隔离 Codex',
      host: 'loopback',
      kind: 'local',
      target: null,
      wire: 'green',
      open,
    },
  ],
})
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
core.start()
const sessionId = new URLSearchParams(location.search).get('thread')
const root = document.getElementById('root')
if (!sessionId || !root) throw new Error('缺少隔离会话或挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <main
      style={{
        width: 760,
        height: 660,
        margin: '24px auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <h3>重开会话 · 工具结果图片</h3>
      <p>隔离 Codex · 恢复首屏 · 原图已在首次读取时保存</p>
      <Transcript deviceId="local" sessionId={sessionId} />
    </main>
  </ServicesProvider>,
)
