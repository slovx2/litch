// 正式 App、通道、副本和模拟核心；夹具仅提供可检查的存储及离线目录。
import '../src/styles/index.css'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  createSidebarActivity,
  emptyOrganizer,
  keys,
  memoryOrganizerStore,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { App } from '../src/app/App.tsx'
import { ServicesProvider } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'

localStorage.setItem('litch.onboarding', 'done')
const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh-CN'
const organizer = memoryOrganizerStore({
  kind: 'ok',
  file: {
    ...emptyOrganizer(),
    groups: [
      { id: 'one', name: lang === 'en' ? 'Development' : '开发', members: [] },
      { id: 'two', name: lang === 'en' ? 'Review' : '验收', members: [] },
    ],
  },
})
const host = createMockCore({ clock: browserClock, lang, organizer })
const commands: { name: string; params: unknown }[] = []
const [ui, core] = createPortPair()
serveChannel(
  core,
  {
    ...host,
    command(name, params, signal) {
      commands.push({ name, params })
      return host.command(name, params, signal)
    },
  },
  { clock: browserClock },
)
const activity = createSidebarActivity(connectChannel(ui), browserClock, {
  load: () => [],
  save() {},
})
if (new URLSearchParams(location.search).has('recent')) activity.setForeground(true)
const channel = activity.channel
const replica = createReplica(channel, activity)
replica.start()
Object.assign(window, {
  __localWorkspace: { channel, store: replica.store, keys, organizer, commands },
})
const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <App />
  </ServicesProvider>,
)
