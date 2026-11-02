// 正式回报组件的隔离浏览器夹具，不连接真实设备或个人数据。
import { type CoreChannel, keys, type Replica, type SessionNoteView } from '@litch/core'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { SessionEventBar } from '../src/tree/EventBar.tsx'
import { TreeCard } from '../src/tree/TreeCards.tsx'
import '../src/styles/tree.css'

const long: SessionNoteView = {
  threadId: 'child',
  turnId: 'original',
  truncated: true,
  title: '报告',
  status: 'completed',
  excerpt: '摘录 [已截断]',
}
const short = { ...long, threadId: 'short', truncated: false, excerpt: '短回答' }
const full = `完整正文\n${'段落😀\n'.repeat(1000)}报告结尾`
const calls: unknown[] = []
const entries = new Map<string, unknown>([
  [
    keys.item('device', 'parent', 'spawn'),
    {
      kind: 'toolCall',
      spawned: { threadId: 'child', title: '报告' },
      status: 'completed',
      error: null,
    },
  ],
  [keys.notes('device', 'parent'), { child: long }],
])
const channel = {
  async command(name: string, params: unknown) {
    calls.push({ name, params })
    await new Promise((done) => setTimeout(done, 30))
    return { answer: full, error: null, pending: null }
  },
} as unknown as CoreChannel
const replica = {
  store: { get: (key: string) => entries.get(key), subscribe: () => () => {} },
} as unknown as Replica
Object.assign(window, { reportFixture: { calls, full } })
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <div style={{ width: 600 }}>
      <SessionEventBar
        deviceId="device"
        sessionId="parent"
        itemId="event"
        event={{ kind: 'notes', notes: [long, short] }}
      />
      <TreeCard deviceId="device" sessionId="parent" itemId="spawn" />
    </div>
  </ServicesProvider>,
)
