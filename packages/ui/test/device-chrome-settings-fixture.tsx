// 正式设备详情，带模拟核心的 Linux 设备。只注入 Chrome 状态，不调用真实 SSH、剪贴板或浏览器。
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/literata/400.css'
import '@fontsource/literata/600.css'
import '@fontsource/sometype-mono/400.css'
import '../src/styles/index.css'
import {
  type AppOp,
  type AppView,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type DeviceView,
  serveChannel,
} from '@litch/core'
import { createRoot } from 'react-dom/client'
import { ServicesProvider } from '../src/app/services.tsx'
import { Toasts } from '../src/app/toasts.tsx'
import { DeviceDetail } from '../src/devices/DeviceDetail.tsx'

const deviceId = 'build'
const base =
  "'/home/dev/.local/share/codex-harness-adapter/releases/stable/libexec/bin/codex-harness-adapter'"
const common = {
  hostLabel: 'build-01',
  storeUrl: 'https://chromewebstore.google.com/detail/ddnllmibgnhhiiaaidfamlknbnfjpnpo',
  prepareCommand: `${base} chrome prepare`,
  enableCommand: `${base} chrome enable`,
  disableCommand: `${base} chrome disable`,
}
type Status = NonNullable<DeviceView['remoteChrome']>
const states = {
  unprepared: { ...common, enabled: false, condition: 'unprepared' },
  waiting: { ...common, enabled: true, condition: 'waiting' },
  connected: { ...common, enabled: true, condition: 'connected' },
} as const satisfies Record<string, Status>
type State = keyof typeof states

const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
const core = createMockCore({ clock, version: 'test' })
const [client, server] = createPortPair()
let state: State =
  new URLSearchParams(location.search).get('state') === 'connected' ? 'connected' : 'unprepared'
let update: (() => void) | undefined
const withStatus = (device: DeviceView): DeviceView =>
  device.id === deviceId ? { ...device, remoteChrome: states[state] } : device
serveChannel(
  server,
  {
    ...core,
    subscribe(topic, sink) {
      if (topic.kind !== 'app') return core.subscribe(topic, sink)
      let remote: DeviceView | undefined
      update = () => {
        if (remote) sink.delta([{ op: 'device.upsert', device: withStatus(remote) }])
      }
      return core.subscribe(topic, {
        ...sink,
        snapshot(data) {
          const app = data as AppView
          remote = app.devices.find((device) => device.id === deviceId)
          sink.snapshot({ ...app, devices: app.devices.map(withStatus) })
        },
        delta(ops) {
          sink.delta(
            (ops as AppOp[]).map((op) => {
              if (op.op !== 'device.upsert') return op
              if (op.device.id === deviceId) remote = op.device
              return { ...op, device: withStatus(op.device) }
            }),
          )
        },
      })
    },
  },
  { clock },
)
const fixture = {
  common,
  copied: '',
  opened: '',
  denyClipboard: false,
  set(next: State) {
    state = next
    update?.()
  },
}
Object.assign(window, {
  deviceChromeFixture: fixture,
  open: (url: string) => {
    fixture.opened = url
    return null
  },
})
Object.defineProperty(navigator, 'clipboard', {
  value: {
    async writeText(text: string) {
      if (fixture.denyClipboard) throw new Error('验收用剪贴板拒绝')
      fixture.copied = text
    },
  },
})
const channel = connectChannel(client)
const replica = createReplica(channel)
const root = document.getElementById('root')
if (!root) throw new Error('缺少设备详情挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <div style={{ display: 'flex', height: '100%', position: 'relative' }}>
      <DeviceDetail deviceId={deviceId} onBack={() => {}} onClose={() => {}} />
      <Toasts />
    </div>
  </ServicesProvider>,
)
replica.start()
