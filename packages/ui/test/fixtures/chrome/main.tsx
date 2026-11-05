// 隔离浏览器与隐藏 Electron 共用：真实组件和样式，数据经模拟通道；不读个人 Chrome 资料。
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
  sitePolicy: { trustAll: false, blocked: [] },
  savedSites: [{ origin: 'https://saved.example', at: 1_760_000_000_000 }],
  supported: true,
  platform: 'darwin',
  prepared: true,
  enabled: true,
  allowedDevices: ['remote'],
  extensionId: 'fakgembkgnmeknpaegnneneockbjhaai',
  allowedExtensionIds: ['fakgembkgnmeknpaegnneneockbjhaai'],
  bundledVersion: '0.25.0',
  extensionDirectory: '/Users/fixture/Library/Application Support/Litch/chrome/extension',
  storeUrl: null,
  instances: [
    {
      id: 'fixture-chrome-instance',
      epoch: 'fixture',
      name: 'Chrome',
      version: '0.25.0',
      protocol: 1,
      incompatible: null,
      source: 'unpacked',
      extensionId: 'fakgembkgnmeknpaegnneneockbjhaai',
    },
  ],
  lastError: null,
}
const requested = new URLSearchParams(location.search).get('state')
if (requested === 'disconnected') state.instances = []
if (requested === 'mismatch') {
  state.instances[0].incompatible = 'extensionOutdated'
  state.instances[0].protocol = null
}
if (requested === 'litch-outdated') {
  state.instances[0].incompatible = 'litchOutdated'
  state.instances[0].protocol = null
}
if (requested === 'reload') state.instances[0].version = '0.24.0'
if (requested === 'windows') state.platform = 'win32'
if (requested === 'store') {
  state.storeUrl = 'https://chromewebstore.google.com/detail/fixture'
  state.instances[0].source = 'store'
}
if (requested === 'fresh') {
  state.prepared = false
  state.enabled = false
  state.instances = []
}
const params = new URLSearchParams(location.search)
const platform = params.get('platform')
if (platform === 'darwin' || platform === 'win32' || platform === 'linux') state.platform = platform
if (params.get('store') === '1') {
  state.storeUrl = 'https://chromewebstore.google.com/detail/ddnllmibgnhhiiaaidfamlknbnfjpnpo'
  state.allowedExtensionIds.push('ddnllmibgnhhiiaaidfamlknbnfjpnpo')
  for (const instance of state.instances) instance.source = 'store'
}
const calls: string[] = []
let failNext = false
let holdNextStatus = false
let releaseStatus: (() => void) | null = null
Object.assign(window, {
  __chromeFixture: {
    calls,
    patch: (next: Partial<ChromeSettingsState>) => {
      state = { ...state, ...next }
    },
    fail: () => {
      failNext = true
    },
    holdStatus: () => {
      holdNextStatus = true
    },
    releaseStatus: () => releaseStatus?.(),
  },
})
const values = new Map<string, unknown>([
  [keys.devices, ['local', 'remote']],
  [keys.device('remote'), { id: 'remote', name: 'Remote fixture', kind: 'ssh' }],
])
const services = {
  shell: 'electron',
  channel: {
    async command(name: string, request: Record<string, unknown>) {
      if (name !== 'chrome.settings') return {}
      calls.push(String(request.kind))
      if (request.kind === 'chrome.status' && holdNextStatus) {
        holdNextStatus = false
        const before = structuredClone(state)
        await new Promise<void>((resolve) => {
          releaseStatus = resolve
        })
        return before
      }
      if (request.kind === 'chrome.store' || request.kind === 'chrome.prepare') {
        if (failNext) {
          failNext = false
          throw new Error('Fixture: connection setup failed')
        }
        state.prepared = true
      }
      if (request.kind === 'chrome.trust') state.sitePolicy.trustAll = request.on === true
      if (request.kind === 'chrome.block') state.sitePolicy.blocked.push(String(request.site))
      if (request.kind === 'chrome.unblock')
        state.sitePolicy.blocked = state.sitePolicy.blocked.filter((host) => host !== request.host)
      if (request.kind === 'chrome.forget')
        state.savedSites = state.savedSites.filter(
          (site) => request.origin !== null && site.origin !== request.origin,
        )
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
