// 完整经理对话与看板共用模拟核心；详情延迟与状态变化只发生在隔离数据中。
import '../src/styles/index.css'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { managerLinkFixture } from '../../core/test/manager-link-fixture.mts'
import { App } from '../src/app/App.tsx'
import { ServicesProvider } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'

const mock = createMockCore({ clock: browserClock, lang: 'zh-CN' })
const { core: host, state } = managerLinkFixture(mock)
Object.assign(window, { __managerLinks: state })
const [ui, core] = createPortPair()
serveChannel(core, host as typeof mock, { clock: browserClock })
const channel = connectChannel(ui)
const replica = createReplica(channel)
replica.start()
const root = document.getElementById('root')
if (!root) throw new Error('缺少验收挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <App />
  </ServicesProvider>,
)
