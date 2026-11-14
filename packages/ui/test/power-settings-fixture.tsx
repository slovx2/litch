// 正式电源设置组件及通道；模拟核心只写内存，不连接真实设备或修改用户电源设置。
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  keys,
  type ManageSchema,
  type SettingsSnapshotView,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { useT } from '../src/app/appearance.ts'
import { ServicesProvider, useKey } from '../src/app/services.tsx'
import { PowerSettings } from '../src/devices/manage/PowerSettings.tsx'
import '../src/styles/index.css'

const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const core = createMockCore({ clock, version: 'test' })
const [client, server] = createPortPair()
serveChannel(server, core, { clock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
replica.openManage('local')
Object.assign(window, {
  powerFixture: {
    values: () => replica.store.get<SettingsSnapshotView>(keys.manageSnapshot('local'))?.values,
  },
})

function Settings() {
  const t = useT()
  const schema = useKey<ManageSchema>(keys.manage('local'))
  const snapshot = useKey<SettingsSnapshotView>(keys.manageSnapshot('local'))
  if (!schema || !snapshot) return null
  const group = schema.groups.find((entry) => entry.id === 'power')
  if (!group) throw new Error('模拟核心缺少电源设置')
  return (
    <main className="mng" style={{ maxWidth: 900, margin: '64px auto', padding: 24 }}>
      <h1>{t('device.local')}</h1>
      <h2>{t.said(group.title)}</h2>
      {group.description ? <p className="mng-sec-note">{t.said(group.description)}</p> : null}
      <PowerSettings
        deviceId="local"
        specs={schema.settings.filter((spec) => spec.group === 'power')}
        snapshot={snapshot}
      />
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具根节点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <Settings />
  </ServicesProvider>,
)
