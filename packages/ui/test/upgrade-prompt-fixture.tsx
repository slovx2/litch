// 正式提示框、设备详情组件和通道；设备操作全部替身，不连接真实服务。
import '../src/styles/index.css'
import {
  type AppView,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type DeviceView,
  keys,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { ServicesProvider, useKey } from '../src/app/services.tsx'
import { Toasts } from '../src/app/toasts.tsx'
import { browserClock } from '../src/boot/channel.ts'
import { ServiceSection } from '../src/devices/ServiceSection.tsx'
import { UpgradeDevices } from '../src/devices/UpgradeDevices.tsx'
import '../src/app/appearance.ts'

const core = createMockCore({ clock: browserClock, lang: 'zh-CN' })
const calls: { name: string; params: unknown }[] = []
let devices: DeviceView[] = []
core.subscribe(
  { kind: 'app' },
  {
    snapshot: (app) => {
      devices = (app as AppView).devices
    },
    delta() {},
    error() {},
  },
)
const source = devices.find((device) => device.id === 'local')
if (!source) throw new Error('模拟核心缺少本机设备')
const local: DeviceView = {
  ...source,
  connection: 'online',
  mode: 'full',
  service: { version: '0.1.0', root: '/test', detached: true, pid: 1, startedAt: 1 },
  upgrade: {
    action: 'kept',
    bundled: { version: '1.0.0', root: '/test' },
    previous: '0.1.0',
    order: 'older',
    reason: 'busy',
    busy: [{ reason: 'tasks', count: 1, harnesses: [] }],
    detail: null,
    pid: 1,
  },
  restart: { blocked: null, phase: { step: 'idle' } },
  remoteUpgrade: null,
}
const remote = (id: string): DeviceView => ({
  ...local,
  id,
  kind: 'ssh',
  name: id,
  upgrade: null,
  remoteUpgrade: {
    target: '1.0.0',
    running: '0.1.0',
    installed: '0.1.0',
    method: 'script',
    managed: false,
    action: 'upgrade',
    capable: true,
    phase: { step: 'idle' },
  },
})
const rows = [
  local,
  remote('remote-idle'),
  remote('remote-busy'),
  remote('remote-fail'),
  {
    ...remote('offline'),
    connection: new URLSearchParams(location.search).has('pending')
      ? ('connecting' as const)
      : ('error' as const),
  },
  { ...remote('latest'), remoteUpgrade: null },
]
const [client, server] = createPortPair()
serveChannel(server, core, { clock: browserClock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.store.set(
  keys.devices,
  rows.map((device) => device.id),
)
for (const device of rows) replica.store.set(keys.device(device.id), device)
core.command = async (name, given) => {
  const params = given as { deviceId: string; mode?: string }
  calls.push({ name, params })
  const device = replica.store.get<DeviceView>(keys.device(params.deviceId))
  if (!device) throw new Error('模拟设备不存在')
  if (name === 'device.serviceActivity')
    return {
      busy: params.deviceId.includes('idle')
        ? []
        : [{ reason: 'backgroundTasks', harnesses: [], count: 1, details: ['npm run dev'] }],
    }
  if (name === 'device.upgradeService') {
    const phase =
      params.mode === 'cancel'
        ? { step: 'idle' as const }
        : params.deviceId === 'remote-fail'
          ? {
              step: 'failed' as const,
              at: 'download' as const,
              text: null,
              detail: 'fixture: download failed',
            }
          : {
              step: 'waiting' as const,
              busy: [
                { reason: 'backgroundTasks', harnesses: [], count: 1, details: ['npm run dev'] },
              ],
              checking: false,
            }
    replica.store.set(keys.device(device.id), {
      ...device,
      remoteUpgrade: { ...device.remoteUpgrade, phase },
    })
  }
  return {}
}
window.litchUpdate = {
  get: async () => ({ version: '1.0.0', supported: true, auto: true, state: { phase: 'idle' } }),
  check: async () => null,
  install: async () => false,
  setAuto: async () => null,
  onState: () => () => {},
}
Object.assign(window, {
  upgradeFixture: {
    calls,
    setOnline(online: boolean) {
      for (const device of rows)
        replica.store.set(
          keys.device(device.id),
          online ? device : { ...device, connection: 'error' },
        )
    },
  },
})
function Detail() {
  const device = useKey<DeviceView>(keys.device('remote-busy'))
  return device ? <ServiceSection device={device} /> : null
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <UpgradeDevices />
    <Detail />
    <Toasts />
  </ServicesProvider>,
)
