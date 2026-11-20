import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import {
  type GithubPollEvent,
  pollGithubRepository,
  SqliteGithubPollStore,
} from '../src/external/github/poll.mjs'
import { ExternalStore } from '../src/external-store.mjs'
import { ManagerStore, openManagerDatabase } from '../src/manager-store.mjs'
import {
  apiHost,
  base,
  githubFixture,
  issue,
  pull,
  pullIssue,
  repo,
  sourceId,
  start,
} from './github-poll-fixture.mjs'

const scope = { sourceId, repoId: repo.repoId }
const defaults = { sourceId, repo, botUserId: '99', enabledAt: start }
const issueKey = { ...scope, stream: 'issues' } as const
const at = start + 20_000

function disk(t: TestContext, now: () => number) {
  const path = mkdtempSync(join(tmpdir(), 'litch-github-ledger-'))
  let manager: ManagerStore | undefined
  t.after(() => {
    manager?.close()
    rmSync(path, { recursive: true, force: true })
  })
  const reopen = () => {
    manager?.close()
    manager = new ManagerStore(openManagerDatabase(path))
    const external = new ExternalStore(manager)
    return { external, store: new SqliteGithubPollStore(external, now) }
  }
  return reopen
}

test('SQLite 重启从已入账的 PR 明细续跑；完整水位、观察与页证明按秒存储', async (t) => {
  const fx = await githubFixture(t, (url) => {
    if (url.pathname === `${base}/pulls/2`)
      return { body: pull(at, { body: '@litch-bot 只在 GitHub 的原文' }) }
    if (url.pathname !== `${base}/issues`) return
    if (url.searchParams.has('page')) return { body: [issue(800, 8, at)] }
    const params = new URLSearchParams(url.search)
    params.set('page', '2')
    return {
      body: [pullIssue(at)],
      headers: { ETag: '"first"', Link: `<${apiHost}${base}/issues?${params}>; rel="next"` },
    }
  })
  const reopen = disk(t, fx.now)
  let { external, store } = reopen()
  const opts = { ...defaults, api: fx.api, pageBudget: 1 }
  await pollGithubRepository({ ...opts, store })
  const pending = (await store.getCursor(issueKey))?.scan?.pending
  assert.equal(pending?.tasks[0]?.kind, 'pull')
  assert.equal(external.cursor(sourceId, repo.repoId, 'issues')?.coveredThrough, start / 1000)
  const persisted = external.pollCheckpoint(sourceId, repo.repoId, 'issues', 'cursor', 'state')
  assert.match(JSON.stringify(persisted), /"tasks":\[\{"kind":"pull","number":"2"\}\]/)
  assert.equal(external.inbox().entries.length, 0)
  assert.deepEqual(await store.listReviewCandidates(scope, start, 4), [2])
  ;({ external, store } = reopen())
  fx.advance(1000)
  await pollGithubRepository({ ...opts, store })
  assert.equal(fx.requests.filter((row) => row.path === `${base}/pulls/2`).length, 1)
  assert.equal(external.cursor(sourceId, repo.repoId, 'issues')?.coveredThrough, start / 1000)
  const row = external.observation(sourceId, repo.repoId, 'issues', '2/pull/102')
  assert.equal(row?.updatedAt, at / 1000)
  assert.equal(row?.observedAt, fx.now() / 1000)
  assert.equal(row?.mentionsBot, true)
  const proof = external.pollCheckpoint<{ etag: string; checkedAt: number }>(
    sourceId,
    repo.repoId,
    'issues',
    'page',
    pending?.proof?.path ?? '',
  )
  assert.deepEqual([proof?.etag, proof?.checkedAt], ['"first"', (start + 60_000) / 1000])
  ;({ external, store } = reopen())
  fx.advance(1000)
  await pollGithubRepository({ ...opts, store })
  assert.equal(
    external.cursor(sourceId, repo.repoId, 'issues')?.coveredThrough,
    (start + 55_000) / 1000,
  )
  assert.equal(
    fx.requests.filter((row) => row.path === `${base}/issues` && !row.query.includes('page=2'))
      .length,
    1,
  )
  const [first] = store.evidence.pending(scope, 1)
  assert.ok(first)
  assert.equal(first.value.event.kind, 'pull_request')
  assert.equal(first.value.event.occurredAt, at / 1000)
  assert.equal(first.value.event.targetEvidence.subject.number, '2')
  assert.doesNotMatch(JSON.stringify(first), /只在 GitHub 的原文/)
  assert.equal(store.evidence.pending(scope, 1, first.key).length, 1)
  assert.equal(external.inbox().entries.length, 0)
  const saved = store.evidence.settle(scope, first.value.event.externalEventKey, {
    status: 'received',
  })
  assert.equal(saved?.eventKey, first.value.event.externalEventKey)
  assert.deepEqual(external.eventEvidence(first.value.event.externalEventKey), first.value.event)
  assert.equal(store.evidence.pending(scope).length, 1)
})

test('来源和仓库的暂停跨进程保存、按凭据代生效，显式恢复重新核查', async (t) => {
  let denied = 'auth'
  const fx = await githubFixture(t, (url) => {
    if (url.pathname === '/user' && denied === 'auth') return { status: 401 }
    if (url.pathname === base && denied === 'repo') return { status: 404 }
    return undefined
  })
  const reopen = disk(t, fx.now)
  let { store } = reopen()
  const kick = (api = fx.client(), resume?: boolean) =>
    pollGithubRepository({ ...defaults, api, store, ...(resume ? { resume } : {}) })
  assert.equal((await kick()).fault?.reason, 'credential-rejected')
  denied = 'repo'
  ;({ store } = reopen())
  assert.equal((await kick()).fault?.reason, 'credential-rejected')
  assert.equal(fx.requests.length, 1)
  assert.equal((await kick(fx.client('rotated'))).fault?.reason, 'repository-unavailable')
  assert.equal((await store.getGate({ sourceId }))?.fault, undefined)
  assert.equal((await store.getGate(scope))?.fault.paused, true)
  denied = 'none'
  ;({ store } = reopen())
  assert.equal((await kick(fx.client('rotated'))).fault?.scope, 'repository')
  assert.equal(fx.requests.length, 3)
  assert.equal((await kick(fx.client('rotated'), true)).fault, undefined)
  assert.equal(await store.getGate(scope), undefined)
})

test('页、归一证据和观察同事务；普通事件处理后同键回扫不再次入箱', async (t) => {
  const { external, store } = disk(t, () => start + 60_250)()
  const event: GithubPollEvent = {
    provider: 'github',
    externalEventKey: `github/${repo.repoId}/issue-event/10`,
    subjectKey: `github/${repo.repoId}/8`,
    kind: 'labeled',
    occurredAt: at / 1000,
    actorEvidence: { userId: '42', login: 'source-user' },
    contentVersion: null,
    permalink: 'https://github.com/org/sample/issues/8#event-10',
    targetEvidence: {
      subject: {
        provider: 'github',
        repoId: repo.repoId,
        number: '8',
        kind: 'issue',
        url: 'https://github.com/org/sample/issues/8',
      },
      sourceEventId: '10',
      labelName: '常规标签',
    },
  }
  const cursor = { tag: 'fixture', coveredThrough: at, checkedAt: start + 60_250 }
  const observation = {
    objectKey: '8/issue/800',
    subjectKey: event.subjectKey,
    objectId: '800',
    observedAt: start + 60_250,
    updatedAt: at + 123,
    hash: 'hash',
    mentioned: false,
  }
  await assert.rejects(
    store.commit(issueKey, cursor, {
      events: [
        event,
        {
          ...event,
          targetEvidence: { ...event.targetEvidence, sourceEventId: 'not-a-numeric-id' },
        },
      ],
      observations: [observation],
      candidates: [{ number: 2, discoveredAt: at }],
    }),
    /证据与仓库不符/,
  )
  assert.equal(external.cursor(sourceId, repo.repoId, 'issues'), null)
  assert.equal(await store.getObservation(scope, observation.objectKey), undefined)
  assert.deepEqual(await store.listReviewCandidates(scope, start, 4), [])
  assert.equal(store.evidence.pending(scope).length, 0)
  await store.commit(issueKey, cursor, { events: [event], observations: [observation] })
  await store.commit({ ...scope, stream: 'issue-events' }, cursor, { events: [event] })
  const other = { ...scope, sourceId: 'new-source' }
  await store.commit({ ...other, stream: 'issue-events' }, cursor, { events: [event] })
  assert.equal(store.evidence.pending(other).length, 0)
  assert.equal(store.evidence.settle(other, event.externalEventKey, { status: 'received' }), null)
  assert.equal(store.evidence.pending(scope).length, 1)
  assert.equal(
    external.observation(sourceId, repo.repoId, 'issues', observation.objectKey)?.updatedAt,
    (at + 123) / 1000,
  )
  assert.deepEqual(await store.getObservation(scope, observation.objectKey), observation)
  assert.deepEqual(await store.getCursor(issueKey), cursor)
  assert.equal(store.evidence.settle(scope, event.externalEventKey, 'ignore'), null)
  await store.commit(issueKey, cursor, { events: [event] })
  assert.equal(store.evidence.pending(scope).length, 0)
  assert.equal(external.inboxEvent(event.externalEventKey), null)
})

test('PR 目录跨流合并并按最近尝试轮扫；换凭据后能重查旧暂停项', async (t) => {
  let now = start + 60_250
  const reopen = disk(t, () => now)
  let { external, store } = reopen()
  const snapshot = { tag: 'first', coveredThrough: at }
  const old = start - 24 * 60 * 60_000
  await store.commit(issueKey, snapshot, {
    candidates: [
      { number: 1, state: 'open', discoveredAt: old, updatedAt: old },
      { number: 2, state: 'closed', discoveredAt: old, updatedAt: old, closedAt: old },
      { number: 3, state: 'closed', discoveredAt: at, updatedAt: at, closedAt: at },
    ],
  })
  await store.commit({ ...scope, stream: 'issue-comments' }, snapshot, {
    candidates: [{ number: 4, discoveredAt: at }],
  })
  assert.deepEqual(
    await store.listReviewCandidates(scope, start, 5, { boundNumbers: [2] }),
    [1, 2, 3, 4],
  )
  await store.commit({ ...scope, stream: 'reviews:1' }, snapshot, {})
  now += 2000
  await store.commit(
    { ...scope, stream: 'reviews:3' },
    {
      ...snapshot,
      fault: { scope: 'target', kind: 'permission', paused: true, reason: 'permission-denied' },
    },
    {},
  )
  ;({ external, store } = reopen())
  assert.deepEqual(await store.listReviewCandidates(scope, start, 5, { tag: 'first' }), [4, 1])
  assert.deepEqual(await store.listReviewCandidates(scope, start, 5, { tag: 'rotated' }), [4, 1, 3])
  assert.equal(
    external.pollCheckpoint<{ attemptedAt: number }>(
      sourceId,
      repo.repoId,
      'github:repository',
      'review-schedule',
      '3',
    )?.attemptedAt,
    now / 1000,
  )
  assert.equal(
    external.pollCheckpoint<{ number: string }>(
      sourceId,
      repo.repoId,
      'github:repository',
      'pull-candidate',
      '4',
    )?.number,
    '4',
  )
})
