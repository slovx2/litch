import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { Toasts } from '../src/app/toasts.tsx'
import { HarnessBlock } from '../src/devices/manage/HarnessBlock.tsx'
import { recoveryChannel, recoveryDevice, recoveryHarnesses } from './fixtures/harness-recovery.ts'
import '../src/styles/index.css'

const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const core = createMockCore({ clock })
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
let restored = (_id: string) => {}
const fixture = recoveryChannel(connectChannel(client), (id) => restored(id))
const replica = createReplica(fixture.channel)
replica.start()
const deviceId = new URLSearchParams(location.search).get('device') ?? 'local'
Object.assign(window, { __harnessRecovery: { calls: fixture.calls } })

function Settings() {
  const [harnesses, setHarnesses] = useState(recoveryHarnesses)
  restored = (id) =>
    setHarnesses((rows) =>
      rows.map((row) =>
        row.id === id ? { ...row, state: 'ready', down: null, detail: null } : row,
      ),
    )
  const device = recoveryDevice(deviceId, harnesses)
  return (
    <main className="mng" style={{ maxWidth: 720, margin: '48px auto', padding: 24 }}>
      <h1>{device.id === 'local' ? '本机' : '隔离远程设备'}</h1>
      {harnesses.map((harness) => (
        <HarnessBlock
          key={harness.id}
          device={device}
          harnessId={harness.id}
          harness={harness}
          install={undefined}
          pending={false}
          settings={() => {}}
        >
          {null}
        </HarnessBlock>
      ))}
      <Toasts />
    </main>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具根节点')
createRoot(root).render(
  <ServicesProvider value={{ channel: fixture.channel, replica, shell: 'browser' }}>
    <Settings />
  </ServicesProvider>,
)
