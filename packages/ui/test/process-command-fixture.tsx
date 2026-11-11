// 虚构命令、真实步骤组件；不执行命令、不连接设备。
import '../src/styles/index.css'
import { type CommandItem, keys, type Replica } from '@litch/core'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { Steps } from '../src/transcript/activity.tsx'

const command =
  'cd /srv/nebula/workspace && npm run verify -- --project nebula-archive --report detailed-results.json'
const states = ['inProgress', 'completed', 'failed', 'declined'] as const
const data = new Map<string, unknown>()
const listeners = new Set<() => void>()
const items = states.map(
  (status, index): CommandItem => ({
    id: `cmd-${index}`,
    kind: 'command',
    status,
    command,
    cwd: '/srv/nebula',
    output:
      status === 'inProgress' || status === 'declined'
        ? ''
        : 'Nebula verification output\nCheck finished.\n',
    elided: null,
    exitCode: status === 'failed' ? 7 : status === 'completed' ? 0 : null,
    durationMs: status === 'inProgress' || status === 'declined' ? null : 104000,
    startedAt: Date.now() - 104000,
  }),
)
for (const item of items) data.set(keys.item('nebula', 'session', item.id), item)
data.set(keys.requests('nebula', 'session'), [])
const replica = {
  store: {
    get: (key: string) => data.get(key),
    subscribe: (_key: string, fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  },
} as unknown as Replica
Object.assign(window, {
  __processCommand: {
    waiting(on: boolean) {
      data.set(
        keys.requests('nebula', 'session'),
        on ? [{ kind: 'approval', itemId: items[0]!.id }] : [],
      )
      for (const fn of listeners) fn()
    },
    output() {
      const item = { ...items[0]!, output: 'Streaming nebula output\n' }
      data.set(keys.item('nebula', 'session', item.id), item)
      for (const fn of listeners) fn()
    },
  },
})
createRoot(document.getElementById('root')!).render(
  <ServicesProvider value={{ replica, channel: {} as never, shell: 'browser' }}>
    <main style={{ width: 320, margin: '24px auto' }}>
      <h3>星云 · 命令过程</h3>
      {items.map((item) => (
        <section key={item.id} data-case={item.status} style={{ marginBottom: 24 }}>
          <Steps
            deviceId="nebula"
            sessionId="session"
            groupKey={item.id}
            itemIds={[item.id]}
            live={item.status === 'inProgress'}
          />
        </section>
      ))}
    </main>
  </ServicesProvider>,
)
