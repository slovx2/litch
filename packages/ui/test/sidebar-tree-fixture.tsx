// 侧栏会话树的对齐夹具：正式 App 与正式侧栏，只有数据属于夹具。
// 最近区混着带子会话（有箭头）、不带子会话、有状态记号、没有状态记号的行；设备树的项目里也有带子会话的会话。
// 用法见 scripts/check-sidebar-tree-align.mjs。
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

localStorage.setItem('litch.onboarding', 'done')
const [ui, core] = createPortPair()
serveChannel(core, createMockCore({ clock: browserClock, lang: 'zh-CN' }), { clock: browserClock })
// 最近区的顺序：s1 在跑且有子会话，s9 空闲无记号，s3 未读，s2 等审批，s4 空闲
const recent = ['s1', 's9', 's3', 's2', 's4', 's6']
const activity = createSidebarActivity(connectChannel(ui), browserClock, {
  load: () =>
    recent.map((sessionId, index) => ({
      deviceId: 'local',
      sessionId,
      at: Date.now() - 1000 - index * 1000,
    })),
  save() {},
})
const channel = activity.channel
const replica = createReplica(channel, activity)
replica.start()

/** 给 s1、s4 各派几个子会话，s4 的第一个子会话下面再派一个 */
async function seed(): Promise<void> {
  const spawn = (parentId: string, title: string) =>
    channel
      .command('session.spawn', {
        deviceId: 'local',
        parentId,
        kind: 'fresh',
        title,
        prompt: title,
        wakeParent: false,
      })
      .then((result) => result.sessionId)
  await spawn('s1', '整理连接层的重试')
  await spawn('s1', '补上断线提示的文案')
  const first = await spawn('s4', '拆分设备进程的日志')
  await spawn('s4', '核对日志轮转的上限')
  await spawn(first, '按大小切分日志文件')
}
const seeded = seed()
Object.assign(window, {
  __sidebarTree: { store: replica.store, keys, seeded, open: requestOpenSession },
})

const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <App />
  </ServicesProvider>,
)
