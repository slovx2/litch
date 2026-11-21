import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pollGithubRepository } from '../src/external/github/poll.mjs'
import { pollGithubNotifications } from '../src/external/github/poll-notifications.mjs'
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

const scope = { sourceId, repoId: repo.repoId }
const account = { userId: String(bot.id), login: bot.login }
const stamp = start + 20_000
const listPath = `${base}/notifications`
const note = (
  id: number,
  number: number,
  reason: string,
  at: number,
  pr = false,
  detail?: string,
) => ({
  id: String(id),
  reason,
  unread: false,
  updated_at: iso(at),
  repository: { id: repo.repoId },
  subject: {
    type: pr ? 'PullRequest' : 'Issue',
    url: `${apiHost}${base}/${pr ? 'pulls' : 'issues'}/${number}`,
    latest_comment_url: detail ? `${apiHost}${base}/${detail}` : null,
  },
})
const action = (id: number, event: string, at: number) => ({
  id,
  actor,
  event,
  created_at: iso(at),
  assignee: bot,
  requested_reviewer: bot,
})
const page = (path: string, number: number, rel: string) =>
  `<${apiHost}${path}?per_page=100&page=${number}>; rel="${rel}"`

test('通知只读，带 since 和重叠，按 ID 与更新时间去重，并遵守 200、304 的 Poll-Interval', async (t) => {
  const modified = new Date(stamp).toUTCString()
  let body = [note(1, 1, 'mention', stamp), note(2, 8, 'subscribed', stamp)]
  let version = 'v1'
  const fx = await githubFixture(t, (url, req) => {
    if (url.pathname === listPath) {
      assert.equal(url.searchParams.get('all'), 'true')
      const same = req.headers['if-none-match'] === `"${version}"`
      return {
        status: same ? 304 : 200,
        body,
        headers: {
          ETag: `"${version}"`,
          'Last-Modified': modified,
          'X-Poll-Interval': same ? '240' : '180',
        },
      }
    }
    if (url.pathname === `${base}/issues/1`)
      return { body: issue(100, 1, stamp, { body: '@litch-bot 请处理' }) }
    if (url.pathname === `${base}/issues/comments/12`)
      return {
        body: {
          id: 12,
          issue_url: `${apiHost}${base}/issues/1`,
          user: actor,
          body: '@litch-bot 还有一项',
          created_at: iso(stamp + 240_000),
          updated_at: iso(stamp + 240_000),
        },
      }
    return undefined
  })
  const store = new MemoryGithubStore()
  const read = (interval = 120_000) =>
    pollGithubNotifications({
      api: fx.api,
      repo,
      scope,
      store,
      bot: account,
      botIds: new Set(['99']),
      boundNumbers: new Set(),
      enabledAt: start,
      interval,
    })
  const first = await read()
  assert.equal(first.coveredThrough, stamp)
  assert.equal(first.nextPollAt, fx.now() + 180_000)
  assert.equal(store.events.size, 1)
  fx.advance(179_000)
  await read()
  assert.equal(fx.requests.filter((row) => row.path === listPath).length, 1)
  fx.advance(1000)
  await read()
  const second = fx.requests.filter((row) => row.path === listPath).at(-1)
  assert.equal(new URLSearchParams(second?.query).get('since'), iso(stamp - 6000))
  assert.equal(second?.etag, undefined, 'since 变化时不能复用上一查询的 ETag')
  assert.equal(fx.requests.filter((row) => row.path.endsWith('/issues/1')).length, 1)
  fx.advance(180_000)
  const unchanged = await read()
  const third = fx.requests.filter((row) => row.path === listPath).at(-1)
  assert.equal(third?.etag, '"v1"')
  assert.equal(third?.modifiedSince, modified)
  assert.equal(unchanged.nextPollAt, fx.now() + 240_000)
  fx.advance(239_000)
  await read()
  assert.equal(fx.requests.filter((row) => row.path === listPath).length, 3)
  fx.advance(1000)
  version = 'v2'
  body = [note(1, 1, 'mention', stamp + 240_000, false, 'issues/comments/12')]
  const updated = await read(300_000)
  assert.equal(updated.nextPollAt, fx.now() + 300_000, '不小于来源默认间隔')
  assert.equal(store.events.size, 2)
  assert.ok(fx.requests.every((row) => row.method === 'GET'))
})

test('指派与评审还原原生事件键；仓库积压续扫时仍先收到一轮内的通知', async (t) => {
  const old = action(400, 'assigned', stamp - 10_000)
  const assigned = action(401, 'assigned', stamp)
  const reviewed = action(402, 'review_requested', stamp)
  const robot = { ...action(403, 'assigned', stamp), actor: { id: 98, login: 'other-bot' } }
  const subject = issue(100, 1, stamp, { assignees: [bot] })
  let listing: ReturnType<typeof note>[] = []
  const fx = await githubFixture(t, (url) => {
    const p = url.pathname
    const n = Number(url.searchParams.get('page') ?? 1)
    if (p === listPath) return { body: listing }
    if (p === `${base}/issues/events`)
      return {
        body:
          n === 1
            ? [
                { ...assigned, issue: subject },
                { ...reviewed, issue: pullIssue(stamp) },
              ]
            : Array.from({ length: 100 }, () => ({ ...old, issue: subject })),
        headers: { Link: page(p, n + 1, 'next') },
      }
    if (p === `${base}/issues/1/timeline`) return { body: [assigned, robot] }
    if (p === `${base}/issues/2/timeline`) {
      if (n === 1)
        return { body: [old], headers: { Link: `${page(p, 2, 'next')}, ${page(p, 23, 'last')}` } }
      if (n === 23) return { body: [reviewed], headers: { Link: page(p, 22, 'prev') } }
      return { body: [old], headers: { Link: `${page(p, 21, 'prev')}, ${page(p, 23, 'next')}` } }
    }
    if (p === `${base}/issues/1`) return { body: subject }
    if (p === `${base}/pulls/2`) return { body: pull(stamp, { requested_reviewers: [bot] }) }
    return undefined
  })
  const store = new MemoryGithubStore()
  const read = () =>
    pollGithubNotifications({
      api: fx.api,
      repo,
      scope,
      store,
      bot: account,
      botIds: new Set(['99', '98']),
      boundNumbers: new Set(),
      enabledAt: start,
      interval: 60_000,
    })
  const fallback = () =>
    pollGithubRepository({
      api: fx.api,
      repo,
      store,
      sourceId,
      botUserId: '99',
      enabledAt: start,
      pageBudget: 1,
    })
  await read()
  await fallback()
  assert.ok((await store.getCursor({ ...scope, stream: 'issue-events' }))?.scan)
  listing = [note(1, 1, 'assign', stamp), note(2, 2, 'review_requested', stamp, true)]
  fx.advance(60_000)
  await read()
  assert.deepEqual(
    [...store.events.keys()].sort(),
    ['401', '402'].map((id) => `github/${repo.repoId}/issue-event/${id}`),
  )
  assert.ok(fx.requests.some((entry) => entry.query.includes('page=23')))
  for (let idx = 0; idx < 3; idx++) await fallback()
  assert.equal(store.events.size, 2, '仓库流沿用同一事件键')
  assert.equal(
    fx.requests.filter(
      (row) => row.path === `${base}/issues/events` && !new URLSearchParams(row.query).has('page'),
    ).length,
    1,
  )
})

test('仓库 Issue Events 在当前水位前的第一页停止；历史页的 Link 不触发回扫', async (t) => {
  const fx = await githubFixture(t, (url) => {
    if (url.pathname !== `${base}/issues/events`) return
    const old = start - 20_000
    return {
      body: Array.from({ length: 100 }, (_, idx) => ({
        ...action(500 + idx, 'assigned', old),
        issue: issue(1, 1, old),
      })),
      headers: { Link: page(url.pathname, 2, 'next') },
    }
  })
  const store = new MemoryGithubStore()
  await pollGithubRepository({
    api: fx.api,
    store,
    repo,
    sourceId,
    botUserId: '99',
    enabledAt: start,
  })
  assert.equal(fx.requests.filter((row) => row.path.endsWith('/issues/events')).length, 1)
  assert.equal(store.events.size, 0)
  assert.equal(
    (await store.getCursor({ ...scope, stream: 'issue-events' }))?.coveredThrough,
    fx.now() - 5000,
  )
})
