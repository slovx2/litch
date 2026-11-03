// 与生产共用 App、核心通道和副本，只替换隔离看板数据来源。
import '../src/styles/index.css'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  keys,
  type ManagerBoardTopicView,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { managerBoardFixture } from '../../core/test/manager-board-fixture.mts'
import { App } from '../src/app/App.tsx'
import { ServicesProvider } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'

const data = await fetch('/__manager_board_data').then((r) => r.json())
const factory = data.coreUrl
  ? (await import(/* @vite-ignore */ data.coreUrl)).createManagers
  : undefined
const fixture = managerBoardFixture(
  createMockCore({ clock: browserClock, lang: 'zh-CN' }),
  data,
  factory,
)
Object.assign(window, { __managerBoardFixture: fixture.state })
const [ui, core] = createPortPair()
serveChannel(core, fixture.core, { clock: browserClock })
const channel = connectChannel(ui)
const replica = createReplica(channel)
replica.start()
replica.store.subscribe(keys.managerBoard('local', 'm1'), () => {
  const board = replica.store.get<ManagerBoardTopicView>(keys.managerBoard('local', 'm1'))?.board
  if (
    !fixture.state.startedAt ||
    board?.decisions.find((d) => d.id === 'D-20')?.status !== 'answered'
  )
    return
  const full = board.changes.length > data.board.changes.length
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      fixture.state.statusPaintAt ||= performance.now()
      if (full) fixture.state.fullPaintAt ||= performance.now()
    }),
  )
})
const root = document.getElementById('root')
if (!root) throw new Error('缺少隔离界面挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <App />
  </ServicesProvider>,
)
