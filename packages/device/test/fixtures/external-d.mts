import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import {
  type ExternalSourceDraft,
  type ExternalSubject,
  externalSubjectKey,
} from '../../../protocol/src/external-sources.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
} from '../../../protocol/src/manager.mjs'
import { githubWriterForLoopbackTest } from '../../src/external/github/write-api.mjs'
import { ExternalGithubOutbox, type ExternalManagerActor } from '../../src/external/outbox.mjs'
import { ExternalGithubSecrets } from '../../src/external/secrets.mjs'
import { ExternalStore } from '../../src/external-store.mjs'
import { ManagerStore, openManagerDatabase } from '../../src/manager-store.mjs'

export const token = (name = 'first') => `github_pat_${name}0123456789abcdefghijklmnop`
export const subject: ExternalSubject = {
  provider: 'github',
  repoId: '90071992547409931',
  number: '8',
  kind: 'issue',
  url: 'https://github.com/example/demo/issues/8',
}
export const bot = '90071992547409932'
export const owner = '90071992547409933'
export const resource = '90071992547409934'
export const repoPath = '/repos/example/demo'
export const actor: ExternalManagerActor = { kind: 'manager', managerId: 'm', threadId: 'm-thread' }
export const repoMetadata = {
  id: subject.repoId,
  full_name: 'example/demo',
  name: 'demo',
  default_branch: 'main',
  owner: { id: resource, login: 'example', type: 'Organization' },
}
export type Mock = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  data: Record<string, unknown>,
) => boolean | Promise<boolean>

export function respond(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json', 'x-github-request-id': 'AB:0123' })
  res.end(JSON.stringify(data))
}

export async function githubMock(t: TestContext, handler?: Mock) {
  const requests: { method: string | undefined; path: string; auth: string | undefined }[] = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({
      method: req.method,
      path: url.pathname + url.search,
      auth: req.headers.authorization,
    })
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      if (await handler?.(req, res, url, data)) return
      const path = url.pathname
      if (path === '/user') {
        const user = req.headers.authorization === `Bearer ${token('wrong')}` ? '432' : bot
        // 真实 REST 用数字，夹具显式保留超过 JS 安全范围的字面量。
        res.end(`{"id":${user},"type":"User","login":"litch-device"}`)
      } else if (path === `/user/${owner}`) respond(res, { id: owner, type: 'User' })
      else if (path === '/user/repos') respond(res, [repoMetadata])
      else if (path === repoPath) respond(res, repoMetadata)
      else if (path === `${repoPath}/issues` || path === `${repoPath}/pulls`) respond(res, [])
      else if (path === `${repoPath}/actions/runs`) respond(res, { workflow_runs: [] })
      else if (path === `${repoPath}/issues/8`) respond(res, { number: 8 })
      else if (path === `${repoPath}/issues/8/comments`) respond(res, [])
      else respond(res, {}, 404)
    } catch {
      res.destroy()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const origin = `http://127.0.0.1:${address.port}`
  return { send: githubWriterForLoopbackTest(origin), requests, origin }
}

export async function externalFixture(t: TestContext, handler?: Mock) {
  const mock = await githubMock(t, handler)
  const dir = mkdtempSync(join(tmpdir(), 'litch-external-d-'))
  const manager = new ManagerStore(openManagerDatabase(dir))
  t.after(() => {
    manager.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const store = new ExternalStore(manager)
  manager.saveManager({
    id: actor.managerId,
    threadId: actor.threadId,
    name: '测试',
    scope: '',
    cwd: dir,
    harness: 'codex',
    model: null,
    effort: null,
    template: 'blank',
    rules: '',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    pendingDecisions: 0,
    runningLines: 0,
    latestActivity: null,
    dispatch: { ...MANAGER_DEFAULT_DISPATCH },
    contact: { ...MANAGER_DEFAULT_CONTACT },
  })
  store.config.setOwner(
    {
      provider: 'github',
      userId: owner,
      loginCache: 'owner',
      profileUrl: 'https://github.com/owner',
      method: 'userId',
    },
    'user',
    0,
    'owner-configure',
  )
  const clock = { at: 1000 }
  const now = () => clock.at
  const secrets = new ExternalGithubSecrets(store, dir, { send: mock.send, now })
  const configured = await secrets.configure({
    operationId: 'create-robot',
    repoIds: [subject.repoId],
    token: token(),
  })
  assert.equal(configured.outcome, 'applied')
  const credentialRef = configured.record?.credentialRef
  assert.ok(credentialRef)
  const source: ExternalSourceDraft = {
    provider: 'github',
    sourceId: 's',
    enabled: true,
    botUserId: bot,
    credentialRef,
    interval: 60,
    minRole: 'triage',
    triggers: { mention: true, assignment: true, reviewRequest: true, label: false, labelIds: [] },
    writePolicy: { comment: true, draftPr: true, status: false, managedPush: false },
    repos: [
      {
        repoId: subject.repoId,
        owner: 'example',
        name: 'demo',
        url: 'https://github.com/example/demo',
        localRoot: dir,
        allowedBase: ['main'],
        headNamespace: 'litch/work',
      },
    ],
    routes: [
      {
        routeId: 'route',
        stableManagerId: actor.managerId,
        priority: 1,
        enabled: true,
        repoIds: [subject.repoId],
      },
    ],
  }
  assert.equal(store.config.saveSource(source, 0, 'source-configure', 'user').outcome, 'applied')
  const addIntake = (
    intakeId: string,
    ref: ExternalSubject = subject,
    kind: 'issue' | 'comment' = 'issue',
  ) => {
    const eventKey = `event-${intakeId}`
    store.insertInboxEvent({
      eventKey,
      subject: ref,
      subjectKey: externalSubjectKey(ref),
      kind,
      sourceEventId: '123',
      actorId: owner,
      actorRoleAtCheck: 'owner',
      occurredAt: 100,
      observedAt: 101,
      sourceId: 's',
      status: 'received',
      contentVersion: null,
      eventUrl: ref.url,
    })
    store.collectIntake({
      intakeId,
      sourceId: 's',
      subject: ref,
      subjectKey: externalSubjectKey(ref),
      eventKeys: [eventKey],
      autoNotifyUntil: 1200,
      managerId: actor.managerId,
    })
    return eventKey
  }
  const accepted = store.commitTriage({
    action: 'accept',
    intakeId: 'first',
    expectedRevision: 1,
    managerId: actor.managerId,
    actorId: actor.threadId,
    at: 999,
    idempotencyKey: 'take-1',
    title: '测试',
    body: '',
    evidence: {
      requesterUserId: owner,
      observedRole: 'owner',
      eventKeys: [addIntake('first')],
      ruleId: 'test',
      rulesVersion: 1,
      policyRevision: 1,
      routeId: 'route',
      authorizedScope: {
        repoId: subject.repoId,
        subjectKey: externalSubjectKey(subject),
        actions: ['comment', 'draft_pr', 'status'],
      },
    },
  })
  assert.ok(accepted.outcome === 'applied' && accepted.mandate && accepted.ref)
  const { mandateId, issueId } = accepted.mandate
  const request = {
    sourceId: 's',
    issueId,
    target: { repoId: subject.repoId, number: subject.number },
    mandateId,
  }
  const newOutbox = () =>
    new ExternalGithubOutbox({
      store,
      secrets,
      stateDirectory: dir,
      send: mock.send,
      now,
      assignmentForManager: () => ({ identityId: bot, repoIds: [subject.repoId] }),
    })
  return {
    ...mock,
    clock,
    now,
    store,
    dir,
    secrets,
    source,
    credentialRef,
    configured,
    addIntake,
    request,
    newOutbox,
    outbox: newOutbox(),
  }
}
