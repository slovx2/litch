import '../src/styles/index.css'
import { connectChannel, createPortPair, createReplica, serveChannel } from '@litch/core'
import { createRoot } from 'react-dom/client'
import { composeStateFixture } from '../../core/test/compose-state-fixture.mts'
import { ServicesProvider } from '../src/app/services.tsx'
import { Transcript } from '../src/transcript/Transcript.tsx'

const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const { core, controls } = composeStateFixture(clock)
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
Object.assign(window, { __composeState: controls })
function Fixture() {
  return (
    <main
      style={{
        width: 640,
        height: 760,
        margin: '24px auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <h3>星云 · 输入验收</h3>
      <Transcript deviceId="local" sessionId="nebula" />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <Fixture />
  </ServicesProvider>,
)
