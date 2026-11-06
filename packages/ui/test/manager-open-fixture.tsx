// 正式 App 与正式链接组件；仅数据、系统通知桥和可控的目录到达顺序属于夹具。
import '../src/styles/index.css'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  createSidebarActivity,
  keys,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { App } from '../src/app/App.tsx'
import { requestOpenSession } from '../src/app/actions.ts'
import { ServicesProvider } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'
import { ActionsProvider } from '../src/transcript/actions.tsx'
import { SessionPill } from '../src/transcript/SessionMentions.tsx'
import { SessionEventBar } from '../src/tree/EventBar.tsx'

localStorage.setItem('litch.onboarding', 'done')
const listeners = new Set<(id: string) => void>()
Object.assign(window, {
  litchShell: {
    setLanguage() {},
    setLook() {},
    notify() {},
    onNotifyClick(fn: (id: string) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    onForeground(fn: (foreground: boolean) => void) {
      fn(true)
      return () => {}
    },
  },
})
const [ui, core] = createPortPair()
serveChannel(core, createMockCore({ clock: browserClock, lang: 'zh-CN' }), { clock: browserClock })
const activity = createSidebarActivity(connectChannel(ui), browserClock, {
  load: () => [{ deviceId: 'local', sessionId: 'm1', at: Date.now() }],
  save() {},
})
const channel = activity.channel
const replica = createReplica(channel, activity)
replica.start()
Object.assign(window, {
  __managerOpen: {
    store: replica.store,
    keys,
    open: requestOpenSession,
    notify: (id: string) => {
      for (const listener of listeners) listener(id)
    },
  },
})
const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <App />
    <div data-open-links>
      <ActionsProvider value={{ busy: false, open: requestOpenSession }}>
        <SessionPill deviceId="local" mention={{ threadId: 'm1', title: '经理链接' }} />
        <SessionEventBar
          deviceId="local"
          sessionId="s2"
          itemId="manager-report"
          event={{
            kind: 'report',
            notes: [{ threadId: 'm1', title: '经理回报', status: 'completed', excerpt: '已完成' }],
            body: '',
          }}
        />
      </ActionsProvider>
    </div>
  </ServicesProvider>,
)
