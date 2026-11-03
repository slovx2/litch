// 隔离浏览器夹具：真实权限核心、通道、钩子和设置栏，不访问个人配置或 harness。
import {
  type ComposeOptions,
  type CoreHost,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  keys,
  type SessionSettings,
  serveChannel,
} from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcAbortError } from '../../core/src/connection/rpc.mts'
import { createProjectPermissions } from '../../core/src/device/project-permissions.mts'
import { setAppearance } from '../src/app/appearance.ts'
import { ServicesProvider } from '../src/app/services.tsx'
import { SettingsBar } from '../src/composer/SettingsBar.tsx'
import '../src/styles/index.css'

setAppearance({ lang: 'zh-CN' })
const params = new URLSearchParams(location.search)
const supported = params.get('device') !== 'old'
let failing = params.get('device') === 'timeout'
let requests = 0
const clock = {
  now: Date.now,
  setTimer(fn: () => void, ms: number) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
}
const permissions = createProjectPermissions({
  deviceId: 'local',
  online: () => true,
  supported: () => supported,
  async request() {
    requests++
    if (failing) throw new RpcAbortError('timeout', '隔离超时')
    return { cwd: '/fixture', harness: 'pi', permission: ':workspace', confirmedPermissions: [] }
  },
})
const base = createMockCore({ clock })
const host: CoreHost = {
  ...base,
  subscribe(topic, sink) {
    return topic.kind === 'projectPermission'
      ? permissions.open(topic.cwd, topic.harness, sink)
      : base.subscribe(topic, sink)
  },
}
const [ui, core] = createPortPair()
serveChannel(core, host, { clock })
const channel = connectChannel(ui)
const replica = createReplica(channel)
const options: ComposeOptions = {
  models: [
    {
      id: 'model',
      title: 'Model with a long title',
      efforts: [{ id: 'high', note: '' }],
      speeds: [{ id: 'priority', title: 'Fast', note: '' }],
      defaultEffort: 'high',
      defaultSpeed: null,
      isDefault: true,
      acceptsImages: true,
    },
  ],
  permissions: [
    { id: ':workspace', title: null, note: null, risk: 'medium', confirm: false, switchable: true },
    {
      id: ':danger-full-access',
      title: null,
      note: null,
      risk: 'high',
      confirm: true,
      switchable: true,
    },
  ],
  plan: true,
}
function Bar() {
  const [settings, setSettings] = useState<SessionSettings>({
    model: 'model',
    permission: ':danger-full-access',
    effort: null,
    speed: null,
    mode: 'default',
  })
  return (
    <div className="cmp" style={{ width: Number(params.get('width') ?? 500), margin: 20 }}>
      <div className="cmp-bar">
        <button type="button" className="ibtn">
          +
        </button>
        <SettingsBar
          options={options}
          settings={settings}
          onChange={(patch) => setSettings((previous) => ({ ...previous, ...patch }))}
          deviceId="local"
          cwd="/fixture"
          harness="pi"
        />
        <div className="cmp-send-actions">
          <button type="button" className="send">
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
Object.assign(window, {
  permissionProbe: {
    state: () => ({
      requests,
      view: replica.store.get(keys.projectPermission('local', '/fixture', 'pi')),
    }),
    reconnect: () => {
      failing = false
      permissions.resync()
    },
  },
})
const root = document.getElementById('root')
if (!root) throw new Error('权限夹具缺少根节点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <Bar />
  </ServicesProvider>,
)
