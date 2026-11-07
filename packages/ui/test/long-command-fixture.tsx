import { connectChannel, createReplica, type Port } from '@litch/core'
import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { SessionComposer } from '../src/composer/Composer.tsx'
import { Transcript } from '../src/transcript/Transcript.tsx'
import '../src/styles/index.css'

const metrics: any[] = []
const tasks: any[] = []
new PerformanceObserver((list) => {
  for (const task of list.getEntries()) tasks.push({ start: task.startTime, ms: task.duration })
}).observe({ type: 'longtask', buffered: true })
const socket = await new Promise<MessagePort>((resolve) => {
  const listener = (e: MessageEvent) => {
    if (e.data === 'long-port') {
      const port = e.ports[0]
      if (!port) throw new Error('夹具缺少核心 MessagePort')
      window.removeEventListener('message', listener)
      resolve(port)
    }
  }
  window.addEventListener('message', listener)
  ;(window as any).longRequest()
})
const port: Port = {
  post(frame) {
    metrics.push({ stage: 'command-post', at: Date.now(), name: (frame as any).name })
    socket.postMessage(frame)
  },
  listen(fn) {
    socket.onmessage = (event) => {
      const at = Date.now(),
        start = performance.now()
      fn(event.data)
      metrics.push({
        stage: 'replica-dispatch',
        at,
        start,
        ms: performance.now() - start,
        type: event.data.t,
        ops: event.data.ops?.length,
      })
    }
    socket.start()
  },
  close() {
    socket.close()
  },
}
const channel = connectChannel(port)
const replica = createReplica(channel)
replica.start()
Object.assign(window, { longFixture: { metrics, tasks, channel, replica } })
const root = document.getElementById('root')
if (!root) throw new Error('夹具缺少挂载节点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'electron' }}>
    <Profiler
      id="transcript"
      onRender={(_id, phase, actual, base, start, commit) =>
        metrics.push({ stage: 'react', phase, actual, base, start, commit })
      }
    >
      <main className="main" style={{ height: '100vh' }}>
        <Transcript
          deviceId="local"
          sessionId="long-latency"
          footer={<SessionComposer deviceId="local" sessionId="long-latency" blocked={null} />}
        />
      </main>
    </Profiler>
  </ServicesProvider>,
)
