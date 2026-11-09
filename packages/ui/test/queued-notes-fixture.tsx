// 正式卡片和编辑弹窗，经消息端口到可延迟/拒绝的模拟核心。
import {
  type Clock,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { queuedNotesFixture } from '../../core/test/queued-notes-fixture.mts'
import { setAppearance } from '../src/app/appearance.ts'
import { ServicesProvider } from '../src/app/services.tsx'
import { QueuedNotesChip } from '../src/tree/EventBar.tsx'
import '../src/styles/index.css'

setAppearance({ lang: 'zh-CN' })
const clock: Clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const mock = createMockCore({ clock })
const fixture = queuedNotesFixture(mock)
const [client, server] = createPortPair()
serveChannel(server, fixture.core, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
const { sessionId } = await channel.command('session.create', {
  deviceId: 'local',
  cwd: '/',
  text: '短回答',
})
fixture.state.select(sessionId)
replica.openSession('local', sessionId)
Object.assign(window, { queuedFixture: fixture.state })
function Fixture() {
  const [visible, setVisible] = useState(true)
  const [count, setCount] = useState(0)
  return (
    <main style={{ width: 540, padding: 20 }}>
      <button id="other-action" type="button" onClick={() => setCount(count + 1)}>
        其他操作 {count}
      </button>
      <button id="toggle-card" type="button" onClick={() => setVisible(!visible)}>
        切页
      </button>
      <div style={{ marginTop: 350 }}>
        {visible ? <QueuedNotesChip deviceId="local" sessionId={sessionId} /> : null}
      </div>
    </main>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具根节点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <Fixture />
  </ServicesProvider>,
)
