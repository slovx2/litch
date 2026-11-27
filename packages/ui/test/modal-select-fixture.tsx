// 正式组件与模拟核心；不读取浏览器资料、不连接 SSH、GitHub、飞书或账号服务。
import '../src/styles/index.css'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  type DeviceView,
  type HarnessConfigTopicView,
  type HcSlot,
  keys,
  type PairingView,
  type SessionSettings,
  serveChannel,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { sampleClaude } from '../../core/src/mock/sample-hc-claude.mjs'
import { sampleCodex } from '../../core/src/mock/sample-hc-codex.mjs'
import { setAppearance } from '../src/app/appearance.ts'
import { PageWindow } from '../src/app/PageWindow.tsx'
import { ServicesProvider, useKey } from '../src/app/services.tsx'
import { browserClock } from '../src/boot/channel.ts'
import { AccountsTab } from '../src/devices/hconfig/AccountsTab.tsx'
import { InstructionsTab } from '../src/devices/hconfig/InstructionsTab.tsx'
import { AuthFields, HcDialog } from '../src/devices/hconfig/parts.tsx'
import { PairDialog } from '../src/devices/PairDialog.tsx'
import { AddRepo } from '../src/external/AddRepo.tsx'
import { AppPage } from '../src/feishu/AppPage.tsx'
import { requestSearch } from '../src/search/actions.ts'
import { TitleSearch } from '../src/search/TitleSearch.tsx'
import { BrowserImportDialog } from '../src/settings/BrowserImportDialog.tsx'
import type { BrowserImportBridge } from '../src/side/browser/bridge.ts'
import { SpawnDialog } from '../src/tree/SpawnDialog.tsx'

setAppearance({ lang: 'zh-CN' })
const scene = new URLSearchParams(location.search).get('scene')
const core = createMockCore({ clock: browserClock, lang: 'zh-CN' })
const original = core.command.bind(core)
core.command = async (name, params, signal) => {
  const result = await original(name, params, signal)
  if (name === 'pairing.start')
    return {
      pairing: {
        ...(result as { pairing: PairingView }).pairing,
        hosts: ['100.100.100.7', 'host.example.ts.net'],
      },
    }
  return result
}
const [client, server] = createPortPair()
serveChannel(server, core, { clock: browserClock })
const channel = connectChannel(client)
const replica = createReplica(channel)
replica.start()
const slot = <T,>(data: T | null): HcSlot<T> => ({ data, error: null, loading: false, revision: 0 })
const codex = sampleCodex({ home: '/fixture', remote: false })
const claude = sampleClaude({ home: '/fixture', remote: false })
const accountView = (harness: string) => {
  const sample = harness === 'claude' ? claude : codex
  const view: HarnessConfigTopicView = {
    deviceId: 'local',
    harness,
    supported: true,
    config: slot(sample.config),
    instructions: slot(sample.instructions),
    mcp: slot(sample.mcp),
    models: slot(sample.models ?? null),
    providers: slot(sample.providers),
    attempts: [],
    restartRequired: false,
  }
  return view
}
const bridge: BrowserImportBridge = {
  sources: async () => [
    {
      browser: 'chrome',
      name: 'Chrome',
      kinds: ['cookies'],
      promptsSystemAuth: false,
      needsElevation: false,
      profiles: ['Default', 'Profile 2'].map((id) => ({
        id,
        name: id,
        isDefault: id === 'Default',
        has: { cookies: true, passwords: false },
      })),
    },
  ],
  start: async () => ({ kinds: {} }),
  cancel: async () => {},
  onProgress: () => () => {},
  state: async () => ({}),
  dismissBanner: async () => {},
}
const repository = {
  repoId: '456',
  owner: 'fixture',
  name: 'available',
  url: 'https://example.test/fixture/available',
  defaultBranch: 'main',
  grants: [
    {
      identityId: 'identity',
      botUserId: '99',
      credentialRef: 'fixture',
      read: true,
      write: 'verified' as const,
    },
  ],
}
const noop = () => {}

function Fixture() {
  const local = useKey<DeviceView>(keys.device('local'))
  const remote = useKey<DeviceView>(keys.device('build'))
  const parent = useKey<SessionSettings>(keys.settings('local', 's1'))
  const [auth, setAuth] = useState({ region: 'one' } as Record<string, string>)
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (scene === 'spawn') return replica.openSession('local', 's1')
  }, [])
  if (!local || !remote || closed) return null
  switch (scene) {
    case 'spawn':
      return !parent ? null : (
        <SpawnDialog
          deviceId="local"
          parent={{
            id: 's1',
            harness: 'claude-code',
            title: '父会话',
            cwd: '/fixture',
            workspaceId: null,
          }}
          onClose={noop}
        />
      )
    case 'import':
      return <BrowserImportDialog bridge={bridge} onClose={noop} />
    case 'pair':
      return <PairDialog device={remote} onClose={noop} />
    case 'repo':
      return (
        <AddRepo
          deviceId="local"
          repositories={[repository]}
          identities={[]}
          taken={new Set()}
          onClose={noop}
        />
      )
    case 'feishu':
      return (
        <PageWindow kind="settings" onClose={() => setClosed(true)}>
          <AppPage device={local} appId="cli_a1b2c3d4e5f60718" onBack={noop} onClose={noop} />
        </PageWindow>
      )
    case 'search':
      return (
        <>
          <button type="button" data-open-search onClick={() => requestSearch()}>
            打开标题搜索
          </button>
          <TitleSearch onOpen={noop} />
        </>
      )
    case 'template':
      return <AccountsTab device={local} harnessId="claude" view={accountView('claude')} />
    case 'provider-field':
      return <AccountsTab device={local} harnessId="codex" view={accountView('codex')} />
    case 'instructions':
      return <InstructionsTab device={local} harnessId="codex" slot={slot(codex.instructions)} />
    case 'auth':
      return (
        <HcDialog
          title="隔离账号登录"
          kind="login"
          busy={false}
          failure={null}
          yes="确定"
          ready
          onSubmit={noop}
          onClose={noop}
        >
          <AuthFields
            idPrefix="fixture-auth"
            fields={[
              {
                id: 'region',
                title: { 'zh-CN': '地区', en: 'Region' },
                secret: false,
                optional: false,
                placeholder: null,
                options: ['one', 'two'].map((value) => ({
                  value,
                  title: { 'zh-CN': value, en: value },
                  description: null,
                })),
              },
            ]}
            values={auth}
            disabled={false}
            onChange={setAuth}
          />
        </HcDialog>
      )
    default:
      throw new Error(`未知夹具：${scene}`)
  }
}
const root = document.getElementById('root')
if (!root) throw new Error('缺少挂载点')
createRoot(root).render(
  <ServicesProvider value={{ channel, replica, shell: 'browser' }}>
    <Fixture />
  </ServicesProvider>,
)
