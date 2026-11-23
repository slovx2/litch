// 正式 React 组件的权限回归夹具。通道使用合成快照；手机原生控件在浏览器里映射为等价表单。

import { type ClientAskRequest, keys } from '@litch/core'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { InboxDetail } from '../apps/mobile/src/screens/managers/external/InboxDetail.tsx'
import type {
  ExternalAccess,
  ExternalIdentity,
  ExternalIdentityLogin,
  ExternalSourceStatus,
} from '../packages/protocol/src/external-sources.mts'
import { ServicesProvider } from '../packages/ui/src/app/services.tsx'
import { ClientAskCard } from '../packages/ui/src/composer/ClientAskCard.tsx'
import { ExternalInbox } from '../packages/ui/src/external/Inbox.tsx'
import { InboxTriage } from '../packages/ui/src/external/InboxTriage.tsx'
import { UnattendedPage } from '../packages/ui/src/external/UnattendedPage.tsx'
import { IssueMeta } from '../packages/ui/src/manager/issues/IssueMeta.tsx'

const intake = { intakeId: 'one', revision: 1, status: 'pending_triage', managerId: 'm1' }
const recovery = { managerId: 'm1', threadId: 'manager-thread', action: 'refresh' } as const
const observedAt = Math.floor(Date.now() / 1000) - 120
const head = {
  eventKey: 'event',
  intakeId: 'one',
  kind: 'comment',
  status: 'pending_triage',
  subject: { number: '8', url: 'https://github.com/example/demo/issues/8' },
  occurredAt: observedAt,
  observedAt,
  delivery: { state: 'queued', reason: 'manager_tools_outdated', recovery },
}
const otherHead = {
  ...head,
  eventKey: 'other-event',
  intakeId: 'two',
  subject: { number: '9', url: 'https://github.com/example/demo/issues/9' },
  delivery: {
    ...head.delivery,
    recovery: { ...recovery, managerId: 'm2', threadId: 'other-thread' },
  },
}
const missingResultReply = {
  managerId: 'm1',
  issueId: 'X-1',
  subject: { ...head.subject, provider: 'github', repoId: '123', kind: 'issue' },
} as const
const device = {
  id: 'remote',
  kind: 'ssh',
  connection: 'online',
  externalSources: true,
  name: 'SSH fixture',
}
const manager = {
  id: 'm1',
  deviceId: device.id,
  status: 'active',
  name: 'Remote fixture manager',
  threadId: recovery.threadId,
  harness: 'claude-code',
}
const identity: ExternalIdentity = {
  identityId: 'fixture',
  botUserId: '99',
  login: 'fixture-bot',
  revision: 1,
  credentials: [],
}
const oauth = {
  credentialRef: 'oauth',
  provider: 'github',
  botUserId: '100',
  resourceOwnerId: '100',
  credentialKind: 'oauth',
  scopes: ['notifications'],
  createdAt: 1,
  lastVerifiedAt: 1,
  state: 'active',
  generation: 1,
} as const
const identities: ExternalIdentity[] = [
  identity,
  {
    identityId: 'granted',
    botUserId: '100',
    login: 'notified-bot',
    revision: 1,
    credentials: [
      { ...oauth, credentialRef: 'limited', scopes: ['public_repo'] },
      { ...oauth, scopes: ['notifications'] },
    ],
  },
  {
    identityId: 'revoked',
    botUserId: '101',
    login: 'revoked-bot',
    revision: 1,
    credentials: [{ ...oauth, botUserId: '101', scopes: ['notifications'], state: 'revoked' }],
  },
]
const chromeSite: ClientAskRequest = {
  id: 'chrome-site',
  itemId: 'chrome-site',
  kind: 'clientAsk',
  device: { kind: 'local', name: '本机', host: '' },
  tool: { namespace: 'litch_browser', name: 'navigate' },
  ask: {
    kind: 'site',
    browser: 'chrome',
    origin: 'https://example.com',
    url: 'https://example.com',
  },
  options: [
    { id: 'once', role: 'accept' },
    { id: 'session', role: 'acceptSession' },
    { id: 'always', role: 'acceptAlways' },
    { id: 'decline', role: 'decline' },
  ],
}
const availableRepo = {
  repoId: '456',
  owner: 'example',
  name: 'available',
  url: 'https://github.com/example/available',
  grants: [
    {
      identityId: identity.identityId,
      botUserId: '99',
      credentialRef: 'fixture',
      read: true,
      write: 'verified',
    },
  ],
}
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
    notify: {
      state: 'blocked',
      diagnostics: [
        { check: 'managerTools', code: 'manager_tools_outdated', state: 'blocked', recovery },
      ],
    },
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
  configuration: { value: { revision: 1, identities, assignments: [] } },
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
    if (topic.kind === 'externalInbox') {
      sink.snapshot({ online: true, value: { entries: [head, otherHead] } })
      return () => {}
    }
    if (topic.kind === 'externalIdentityLogin') {
      loginSinks.add(sink)
      sink.snapshot({ value: login })
      return () => loginSinks.delete(sink)
    }
    sinks.add(sink)
    sink.snapshot(snapshot())
    return () => sinks.delete(sink)
  },
  async command(name: string, args: { deviceId?: string; intakeId?: string } = {}) {
    calls.push(name)
    if (
      /^external\.(?:identity\.(?:list|repositories|add)|source\.check)$/.test(name) &&
      args.deviceId !== device.id
    )
      throw new Error('没有选中远程夹具')
    if (name === 'external.inbox.get')
      return args.intakeId === otherHead.intakeId
        ? { events: [otherHead], intake: null }
        : { events: [head], intake }
    if (name === 'external.identity.repositories') return { repositories: [availableRepo] }
    if (name === 'external.identity.list') return { identities }
    if (name === 'external.identity.avatar') return null
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
const managers = new Map<string, unknown>([
  [keys.managerIds(device.id), [manager.id]],
  [keys.manager(device.id, manager.id), manager],
])
const replica = { store: { get: (key: string) => managers.get(key), subscribe: () => () => {} } }
Object.assign(window, { mobileServices: { channel, replica, intake } })
function App() {
  const [current, set] = useState<ExternalAccess>()
  const [missing, showMissing] = useState(false)
  Object.assign(window, {
    setResultMissing: (value: boolean) => {
      if (value) sourceStatus.missingResultReplies = [missingResultReply]
      else delete sourceStatus.missingResultReplies
      showMissing(value)
      for (const sink of sinks) sink.snapshot(snapshot())
    },
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
      <div id="desktop-inbox">
        <ExternalInbox manager={manager as never} disabled={false} onOpenIssue={() => {}} />
      </div>
      <div id="desktop-chrome-site">
        <ClientAskCard request={chromeSite} deviceId="local" sessionId="fixture" waiting={0} />
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
      <div id="board">
        <IssueMeta
          head={
            {
              kind: 'ordinary',
              id: 'X-1',
              status: 'resolved',
              author: 'manager',
              followUp: 'off',
              updatedAt: 1000,
              ...(missing ? { missingResultReply } : {}),
            } as never
          }
        />
      </div>
      <div id="mobile">
        <InboxDetail
          manager={manager as never}
          head={{ ...head, ...(missing ? { missingResultReply } : {}) } as never}
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
