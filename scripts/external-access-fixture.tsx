// 正式 React 组件的权限回归夹具。通道使用合成快照；手机原生控件在浏览器里映射为等价表单。

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { InboxDetail } from '../apps/mobile/src/screens/managers/external/InboxDetail.tsx'
import type {
  ExternalAccess,
  ExternalIdentityLogin,
  ExternalSourceStatus,
} from '../packages/protocol/src/external-sources.mts'
import { ServicesProvider } from '../packages/ui/src/app/services.tsx'
import { InboxTriage } from '../packages/ui/src/external/InboxTriage.tsx'
import { UnattendedPage } from '../packages/ui/src/external/UnattendedPage.tsx'

const intake = { intakeId: 'one', revision: 1, status: 'pending_triage', managerId: 'm1' }
const head = {
  eventKey: 'event',
  intakeId: 'one',
  kind: 'mention',
  status: 'pending_triage',
  subject: { number: '8', url: 'https://github.com/example/demo/issues/8' },
  occurredAt: 1,
}
const manager = { id: 'm1', deviceId: 'local', status: 'active', name: 'fixture' }
const device = { id: 'local', connection: 'online', externalSources: true, name: 'fixture' }
const sourceStatus: ExternalSourceStatus = {
  source: {
    sourceId: 'github-ready',
    provider: 'github',
    enabled: true,
    revision: 1,
    rulesVersion: 1,
    createdAt: 1,
    credentialRef: 'fixture',
    botUserId: '99',
    minRole: 'triage',
    interval: 120,
    routes: [],
    triggers: { mention: true, assignment: true, reviewRequest: true, label: true, labelIds: [] },
    writePolicy: { comment: true, draftPr: false, status: false, managedPush: false },
    repos: [
      {
        repoId: '123',
        owner: 'example',
        name: 'demo',
        url: 'https://github.com/example/demo',
        localRoot: '/tmp/fixture',
        allowedBase: ['main'],
        headNamespace: 'litch/',
      },
    ],
  },
  readiness: {
    collect: {
      state: 'ok',
      diagnostics: [{ check: 'repository', state: 'ok', code: 'github_collection_available' }],
    },
    notify: { state: 'ok', diagnostics: [] },
    dispatch: { state: 'unverified', diagnostics: [] },
    write: { state: 'unverified', diagnostics: [] },
  },
  coverage: [],
}
const sinks = new Set<{ snapshot(value: unknown): void }>()
const loginSinks = new Set<{ snapshot(value: unknown): void }>()
const pendingLogin = { loginId: 'fixture-login', revision: 1, expiresAt: 2_000_000_000 } as const
let login: ExternalIdentityLogin = { ...pendingLogin, state: 'preparing', phase: 'download' }
let access: ExternalAccess | undefined
const calls: string[] = []
const snapshot = () => ({
  access,
  sources: { value: [sourceStatus] },
  configuration: { value: { revision: 1, identities: [], assignments: [] } },
  autostart: {
    value: {
      revision: 1,
      state: 'disabled',
      serviceManager: 'launchd',
      requiresLogin: true,
      instance: { mode: 'manual' },
    },
  },
})
const channel = {
  subscribe(topic: { kind: string }, sink: { snapshot(value: unknown): void }) {
    if (topic.kind === 'externalIdentityLogin') {
      loginSinks.add(sink)
      sink.snapshot({ value: login })
      return () => loginSinks.delete(sink)
    }
    sinks.add(sink)
    sink.snapshot(snapshot())
    return () => sinks.delete(sink)
  },
  async command(name: string) {
    calls.push(name)
    if (name === 'external.inbox.get') return { events: [head], intake }
    if (name === 'external.identity.repositories') return { repositories: [] }
    if (name === 'external.identity.list') return { identities: [] }
    if (name === 'external.identity.add') return login
    if (name === 'external.source.check')
      return {
        readiness: {
          ...sourceStatus.readiness,
          collect: {
            state: 'blocked',
            diagnostics: [
              { check: 'repository', state: 'blocked', code: 'github_local_origin_mismatch' },
            ],
          },
        },
        agentGhIdentity: { userId: '42', login: 'fixture-owner', isOwner: true, checkedAt: 1 },
      }
    return { identities: [], repositories: [] }
  },
}
const replica = { store: { get: () => undefined, subscribe: () => () => {} } }
Object.assign(window, { mobileServices: { channel, replica, intake } })
function App() {
  const [current, set] = useState<ExternalAccess>()
  Object.assign(window, {
    setAccess: (next: ExternalAccess | undefined) => {
      access = next
      set(next)
      for (const sink of sinks) sink.snapshot(snapshot())
    },
  })
  return (
    <ServicesProvider value={{ channel, replica, shell: 'browser' } as never}>
      <div id="desktop">
        <UnattendedPage device={device as never} onBack={() => {}} onClose={() => {}} />
      </div>
      <div id="triage">
        <InboxTriage
          manager={manager}
          intake={intake as never}
          access={current}
          managers={[{ id: 'm2', name: 'other' }]}
          disabled={false}
          onDone={() => {}}
        />
      </div>
      <div id="mobile">
        <InboxDetail
          manager={manager as never}
          head={head as never}
          access={current}
          disabled={false}
          onClose={() => {}}
        />
      </div>
    </ServicesProvider>
  )
}
Object.assign(window, {
  accessCalls: calls,
  failGithubCliDownload: () => {
    login = { ...pendingLogin, revision: 2, state: 'error', code: 'github_gh_download_unavailable' }
    for (const sink of loginSinks) sink.snapshot({ value: login })
  },
})
const root = document.getElementById('root')
if (!root) throw new Error('缺少夹具根节点')
createRoot(root).render(<App />)
