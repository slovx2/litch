import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type GithubStream, pollGithubRepository } from '../src/external/github/poll.mjs'
import { GITHUB_API_VERSION } from '../src/external/github/read-api.mjs'
import {
  actor,
  apiHost,
  base,
  bot,
  githubFixture,
  iso,
  issue,
  MemoryGithubStore,
  pull,
  pullIssue,
  repo,
  sourceId,
  start,
} from './github-poll-fixture.mjs'

const day = 24 * 60 * 60_000
const at = start + 20_000
const scope = { sourceId, repoId: repo.repoId }
const cursor = (store: MemoryGithubStore, stream: GithubStream) =>
  store.getCursor({ ...scope, stream })
const makeComment = (id: number, number: number, onPull: boolean, atTime = at) => ({
  id,
  user: actor,
  body: '请 @litch-bot 看一下。',
  created_at: iso(atTime),
  updated_at: iso(atTime),
  issue_url: `${apiHost}${base}/issues/${number}`,
  html_url: `https://github.com/org/sample/${onPull ? 'pull' : 'issues'}/${number}#issuecomment-${id}`,
})

function next(url: URL, path = url.pathname) {
  const query = new URLSearchParams(url.search)
  query.set('page', String(Number(query.get('page') ?? 1) + 1))
  return `<${apiHost}${path}?${query}>; rel="next"`
}

test('混合分页核验原生动作和三种 PR 评论，正文只保存摘要并按数字事件 ID 去重', async (t) => {
  const created = issue(100, 1, at, { body: '请 @litch-bot；原文只在 GitHub' })
  const pr = pullIssue(at)
  const ref = { actor, created_at: iso(at) }
  const assign = {
    ...ref,
    id: 401,
    event: 'assigned',
    // 仓库事件把 actor 写成受派人，实际操作者在 assigner；议题时间线则把操作者写进 actor。
    actor: bot,
    assigner: { id: 43, login: 'actual-assigner' },
    assignee: bot,
  }
  const timelineAssign = { ...assign, actor: assign.assigner, assigner: null }
  const label = { ...ref, id: 402, event: 'labeled', label: { id: 42, name: 'litch' } }
  const requestReview = {
    ...ref,
    id: 403,
    event: 'review_requested',
    review_requester: { id: 44, login: 'review-requester' },
    requested_reviewer: bot,
  }
  const noEvidence = { ...ref, id: 404, event: 'assigned', actor: null, assignee: bot }
  const review = {
    id: 250,
    user: actor,
    body: '请 @litch-bot 采纳 review',
    state: 'COMMENTED',
    submitted_at: iso(at),
    pull_request_url: `${apiHost}${base}/pulls/2`,
  }
  const fx = await githubFixture(t, (url) => {
    const second = url.searchParams.has('page')
    switch (url.pathname) {
      case `${base}/issues`:
        return {
          body: [created],
          headers: { Link: next(url, `/repositories/${repo.repoId}/issues`) },
        }
      case `/repositories/${repo.repoId}/issues`:
        return { body: [pr] }
      case `${base}/issues/events`:
        return second
          ? {
              body: [
                { ...assign, issue: created },
                { ...requestReview, issue: pr },
              ],
            }
          : {
              body: [
                { ...noEvidence, issue: created },
                { ...label, issue: created },
                { ...assign, issue: created },
              ],
              headers: { Link: next(url) },
            }
      case `${base}/issues/1/timeline`:
        return second
          ? { body: [noEvidence, label, timelineAssign] }
          : { body: [{ id: 401, event: 'commented' }], headers: { Link: next(url) } }
      case `${base}/issues/2/timeline`:
        return { body: [requestReview] }
      case `${base}/issues/comments`:
        return { body: [makeComment(200, 1, false), makeComment(201, 2, true)] }
      case `${base}/pulls/comments`:
        return { body: [{ ...review, id: 202, updated_at: iso(at), created_at: iso(at) }] }
      case `${base}/pulls/2`:
        return { body: pull(at) }
      case `${base}/pulls/2/reviews`:
        return { body: [review, { ...review, id: 252, state: 'PENDING', submitted_at: null }] }
      default:
        return undefined
    }
  })
  const store = new MemoryGithubStore()
  const result = await pollGithubRepository({
    sourceId,
    repo,
    botUserId: '99',
    enabledAt: start,
    api: fx.api,
    store,
  })
  assert.equal(result.fault, undefined)
  assert.equal(result.bot?.login, bot.login)
  assert.ok(fx.requests.every((row) => row.version === GITHUB_API_VERSION))
  assert.ok(
    result.streams.every(({ cursor: evidence }) => evidence.coveredThrough === fx.now() - 5000),
  )
  const items = [...store.events.values()]
  assert.deepEqual(
    items.map((row) => row.kind).sort(),
    [
      'assigned',
      'issue',
      'comment',
      'comment',
      'labeled',
      'pull_request',
      'review',
      'review_comment',
      'review_requested',
    ].sort(),
  )
  assert.equal(
    store.events.get(`github/${repo.repoId}/issue-event/401`)?.actorEvidence?.userId,
    '43',
  )
  assert.equal(
    store.events.get(`github/${repo.repoId}/issue-event/401`)?.targetEvidence.assigneeUserId,
    '99',
  )
  assert.equal(
    store.events.get(`github/${repo.repoId}/issue-event/403`)?.actorEvidence?.userId,
    '44',
  )
  assert.equal(
    store.events.get(`github/${repo.repoId}/issue-event/403`)?.targetEvidence.reviewerUserId,
    '99',
  )
  assert.equal(
    store.events.get(`github/${repo.repoId}/issue-event/402`)?.targetEvidence.labelId,
    '42',
  )
  assert.equal(items.find((row) => row.kind === 'issue')?.targetEvidence.mentionedBotId, '99')
  assert.equal(
    items.find((row) => row.kind === 'pull_request')?.targetEvidence.sourceEventId,
    '102',
  )
  assert.ok(items.some((row) => row.permalink.endsWith('/pull/2#issuecomment-201')))
  assert.ok(items.some((row) => row.permalink.endsWith('/pull/2#discussion_r202')))
  assert.ok(items.some((row) => row.permalink.endsWith('/pull/2#pullrequestreview-250')))
  assert.ok(
    store.gaps.some((gap) => gap.reason === 'evidence-unavailable' && gap.subjectNumber === 1),
  )
  assert.doesNotMatch(JSON.stringify(items), /原文只在 GitHub|采纳 review/)
  fx.advance(120_000)
  await pollGithubRepository({
    sourceId,
    repo,
    botUserId: '99',
    enabledAt: start,
    api: fx.api,
    store,
  })
  assert.equal(store.events.size, items.length)
})

test('304 只覆盖已提交的当前页；后页仍核对，秒级 since 前移一秒发现晚到的同秒事件', async (t) => {
  let late = false
  const ref = { actor, created_at: iso(at), event: 'labeled', label: { name: 'litch' } }
  const thread = issue(100, 1, at)
  const a = { ...ref, id: 500 }
  const b = { ...ref, id: 501 }
  const fx = await githubFixture(t, (url, req) => {
    if (url.pathname === `${base}/issues/events`) {
      if (!url.searchParams.has('page')) {
        if (req.headers['if-none-match'] === '"first"') return { status: 304 }
        return { body: [{ ...a, issue: thread }], headers: { Link: next(url), ETag: '"first"' } }
      }
      return {
        body: late ? [{ ...b, issue: thread }] : [],
        headers: { ETag: late ? '"new"' : '"last"' },
      }
    }
    if (url.pathname === `${base}/issues/1/timeline`) return { body: [a, b] }
    if (url.pathname === `${base}/issues/comments`)
      return {
        body: late
          ? [makeComment(601, 1, false, at), makeComment(602, 1, false, at)]
          : [makeComment(601, 1, false, at)],
      }
    return undefined
  })
  const store = new MemoryGithubStore()
  const options = { sourceId, repo, botUserId: '99', enabledAt: start, api: fx.api, store }
  await pollGithubRepository(options)
  const previous = await cursor(store, 'issue-comments')
  assert.equal(store.events.size, 2)
  late = true
  fx.advance(120_000)
  await pollGithubRepository(options)
  assert.equal(store.events.size, 4)
  const eventRequests = fx.requests.filter((row) => row.path === `${base}/issues/events`)
  assert.deepEqual(
    eventRequests.map((row) => row.etag),
    [undefined, undefined, '"first"', '"last"'],
  )
  const lastQuery = fx.requests
    .filter((row) => row.path === `${base}/issues/comments`)
    .at(-1)?.query
  assert.equal(
    new URLSearchParams(lastQuery).get('since'),
    iso(Math.max(start, (previous?.coveredThrough ?? 0) - 600_000) - 1000),
  )
})

test('续点和水位按流独立：间歇失败保留完整水位，再按 Link 补齐后提交', async (t) => {
  let fail = true
  const fx = await githubFixture(t, (url) => {
    if (url.pathname !== `${base}/issues`) return undefined
    if (!url.searchParams.has('page'))
      return { body: [issue(1, 1, at)], headers: { Link: next(url), ETag: '"one"' } }
    return fail ? { status: 503, headers: { 'Retry-After': '40' } } : { body: [issue(2, 2, at)] }
  })
  const store = new MemoryGithubStore()
  const options = {
    sourceId,
    repo,
    botUserId: '99',
    enabledAt: start,
    api: fx.api,
    store,
    pageBudget: 1,
  }
  await pollGithubRepository(options)
  assert.equal((await cursor(store, 'issues'))?.coveredThrough, start)
  assert.equal((await cursor(store, 'issue-comments'))?.coveredThrough, fx.now() - 5000)
  assert.equal(store.events.size, 1)
  assert.ok(
    store.gaps.some(
      (gap) => gap.stream === 'issues' && gap.reason === 'page-budget' && gap.status === 'pending',
    ),
  )
  fx.advance(1000)
  await pollGithubRepository(options)
  const failed = await cursor(store, 'issues')
  assert.equal(failed?.coveredThrough, start)
  assert.equal(failed?.fault?.retryAt, fx.now() + 40_000)
  assert.match(failed?.scan?.next ?? '', /page=2/)
  fail = false
  fx.advance(41_000)
  await pollGithubRepository(options)
  assert.equal((await cursor(store, 'issues'))?.coveredThrough, start + 55_000)
  assert.equal(store.events.size, 2)
  assert.ok(
    store.gaps.some(
      (gap) => gap.stream === 'issues' && gap.reason === 'page-budget' && gap.status === 'resolved',
    ),
  )
  assert.equal(
    fx.requests.filter((row) => row.path === `${base}/issues` && !row.query.includes('page=2'))
      .length,
    1,
  )
})

test('冷启动建基线；正文更新增加提及只记录编辑，不重放旧 issue', async (t) => {
  let edited = false
  const fx = await githubFixture(t, (url) =>
    url.pathname === `${base}/issues`
      ? {
          body: [
            issue(
              200,
              3,
              start - 30_000,
              edited ? { body: '@litch-bot', updated_at: iso(start + 61_000) } : {},
            ),
            issue(201, 4, at, { body: '@litch-bot' }),
          ],
        }
      : undefined,
  )
  const store = new MemoryGithubStore()
  const options = { sourceId, repo, botUserId: '99', enabledAt: start, api: fx.api, store }
  await pollGithubRepository(options)
  assert.equal(store.observations.size, 1)
  assert.deepEqual(
    [...store.events.values()].map((row) => row.targetEvidence.subject.number),
    ['4'],
  )
  edited = true
  fx.advance(120_000)
  await pollGithubRepository(options)
  assert.deepEqual(
    [...store.events.values()].map((row) => [
      row.targetEvidence.subject.number,
      row.targetEvidence.publication,
    ]),
    [
      ['4', 'published'],
      ['3', 'edited'],
    ],
  )
})

test('离线只补最近 30 天并有界前进；超过上限的范围显式入账', async (t) => {
  const resumed = start + 45 * day + 5000
  const cutoff = resumed - 5000 - 30 * day
  const fx = await githubFixture(
    t,
    (url) =>
      url.pathname === `${base}/issues`
        ? {
            body: [issue(200, 3, cutoff - 2000), issue(201, 4, cutoff + 2000)],
          }
        : undefined,
    resumed,
  )
  const store = new MemoryGithubStore()
  await pollGithubRepository({
    sourceId,
    repo,
    botUserId: '99',
    enabledAt: start,
    api: fx.api,
    store,
  })
  assert.equal((await cursor(store, 'issues'))?.coveredThrough, cutoff + day)
  assert.deepEqual(
    store.gaps.find((row) => row.stream === 'issues'),
    {
      stream: 'issues',
      from: start,
      to: cutoff,
      reason: 'offline-limit',
      status: 'unrecoverable',
    },
  )
  assert.deepEqual(
    [...store.events.values()].map((row) => row.targetEvidence.subject.number),
    ['4'],
  )
  const firstQuery = fx.requests.find((row) => row.path === `${base}/issues`)?.query
  assert.equal(new URLSearchParams(firstQuery).get('since'), iso(cutoff - 1000))
})
