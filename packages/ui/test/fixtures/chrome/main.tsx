// 只用于 headless 视觉预检：真实组件与样式，数据经模拟通道；不宣称验证了原生安装界面。
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/literata/400.css'
import '../../../src/styles/index.css'
import { type ChromeSettingsState, type ClientAskRequest, keys } from '@litch/core'
import { createRoot } from 'react-dom/client'
import { type Services, ServicesProvider } from '../../../src/app/services.tsx'
import { ClientAskCard } from '../../../src/composer/ClientAskCard.tsx'
import { ChromeSection } from '../../../src/settings/ChromeSection.tsx'
import '../../../src/app/appearance.ts'

let state: ChromeSettingsState = {
  supported: true,
  prepared: true,
  enabled: true,
  allowedDevices: ['remote'],
  extensionId: 'fakgembkgnmeknpaegnneneockbjhaai',
  expectedVersion: '0.25.0',
  extensionDirectory: '/Users/fixture/Library/Application Support/Litch/chrome/extension',
  instances: [
    {
      id: 'fixture-chrome-instance',
      epoch: 'fixture',
      name: 'Chrome',
      version: '0.25.0',
      compatible: true,
    },
  ],
  lastError: null,
}
const requested = new URLSearchParams(location.search).get('state')
if (requested === 'disconnected') state.instances = []
if (requested === 'mismatch') state.instances[0].compatible = false
if (requested === 'fresh') {
  state.prepared = false
  state.enabled = false
  state.instances = []
}
const values = new Map<string, unknown>([
  [keys.devices, ['local', 'remote']],
  [keys.device('remote'), { id: 'remote', name: 'Remote fixture', kind: 'ssh' }],
])
const services = {
  shell: 'electron',
  channel: {
    async command(name: string, request: Record<string, unknown>) {
      if (name !== 'chrome.settings') return {}
      if (request.kind === 'chrome.enable') state = { ...state, enabled: request.enabled === true }
      return structuredClone(state)
    },
  },
  replica: { store: { get: (key: string) => values.get(key), subscribe: () => () => {} } },
} as unknown as Services
const base = {
  id: 'fixture',
  kind: 'clientAsk',
  itemId: null,
  device: { name: 'Remote fixture', kind: 'ssh', host: 'Remote fixture' },
  tool: { namespace: 'litch_browser', name: 'claim' },
  options: [
    { id: 'once', role: 'accept' },
    { id: 'session', role: 'acceptSession' },
    { id: 'decline', role: 'decline' },
  ],
} as const
const request: ClientAskRequest = {
  ...base,
  options: base.options.map((option) => ({ ...option })),
  ask: { kind: 'chromeInstance', instanceId: 'fixture', name: 'Chrome · fixture' },
}
const signIn: ClientAskRequest = {
  ...request,
  id: 'signin',
  options: request.options.filter((option) => option.id !== 'session'),
  ask: { kind: 'chromeSignIn', origin: 'https://example.test', reason: '测试登录，仅包含夹具数据' },
}
document.documentElement.dataset.platform = 'mac'
document.documentElement.dataset.shell = 'browser'
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(
  <ServicesProvider value={services}>
    <div className="set-page" style={{ height: '100vh' }}>
      <div className="set-body">
        <header className="set-head">
          <h2>Chrome</h2>
        </header>
        <div className="set-content">
          <ChromeSection />
          <div className="set-block">
            <ClientAskCard deviceId="remote" sessionId="fixture" request={request} waiting={0} />
            <ClientAskCard deviceId="remote" sessionId="fixture" request={signIn} waiting={0} />
          </div>
        </div>
      </div>
    </div>
  </ServicesProvider>,
)
