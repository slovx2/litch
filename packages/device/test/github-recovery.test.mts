import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pollGithubRepository } from '../src/external/github/poll.mjs'
import {
  apiHost,
  base,
  githubFixture,
  issue,
  MemoryGithubStore,
  repo,
  sourceId,
  start,
} from './github-poll-fixture.mjs'

const day = 24 * 60 * 60_000
const inputs = { sourceId, repo, botUserId: '99', enabledAt: start }
const scope = { sourceId, repoId: repo.repoId }

test('周期回扫找出重叠窗口以外的晚到事件，回扫不会推高正向完整水位', async (t) => {
  let late = false
  const fx = await githubFixture(t, (url) =>
    url.pathname === `${base}/issues`
      ? { body: late ? [issue(900, 9, start + 120_000)] : [] }
      : undefined,
  )
  const store = new MemoryGithubStore()
  const options = { ...inputs, store, api: fx.api }
  const key = { ...scope, stream: 'issues' as const }
  await pollGithubRepository(options)
  fx.advance(30 * 60_000)
  await pollGithubRepository(options)
  const previous = await store.getCursor(key)
  assert.equal(store.events.size, 0)
  fx.advance(day - 30 * 60_000)
  late = true
  await pollGithubRepository(options)
  assert.equal(store.events.size, 1)
  assert.equal((await store.getCursor(key))?.coveredThrough, previous?.coveredThrough)
  assert.equal((await store.getCursor(key))?.repairAt, fx.now())
})

test('续点超期重扫，不信任旧页码；覆盖原扫描区间后关闭缺口', async (t) => {
  let secondRound = false
  const fx = await githubFixture(t, (url) => {
    if (url.pathname !== `${base}/issues`) return
    if (secondRound) return { body: [issue(801, 2, start + 20_000)] }
    const query = new URLSearchParams(url.search)
    query.set('page', '2')
    return {
      body: [issue(800, 1, start + 20_000)],
      headers: { Link: `<${apiHost}${base}/issues?${query}>; rel="next"` },
    }
  })
  const store = new MemoryGithubStore()
  const options = { ...inputs, store, api: fx.api, pageBudget: 1 }
  const key = { ...scope, stream: 'issues' as const }
  await pollGithubRepository(options)
  assert.equal((await store.getCursor(key))?.coveredThrough, start)
  fx.advance(6 * 60 * 60_000 + 1000)
  secondRound = true
  await pollGithubRepository(options)
  assert.equal((await store.getCursor(key))?.coveredThrough, fx.now() - 5000)
  assert.equal(
    fx.requests.filter((row) => row.path === `${base}/issues` && row.query.includes('page=2'))
      .length,
    0,
  )
  assert.deepEqual(
    store.gaps
      .filter((row) => row.stream === 'issues' && row.reason === 'expired-scan')
      .map((row) => row.status),
    ['pending', 'resolved'],
  )
  assert.equal(store.events.size, 2)
})

test('缺页证明的 304 和跨主机 Link 无法推进水位；X-Poll-Interval 只限制对应流', async (t) => {
  const fx = await githubFixture(t, (url) => {
    switch (url.pathname) {
      case `${base}/issues`:
        return { status: 304 }
      case `${base}/issues/events`:
        return {
          body: [],
          headers: {
            Link: `<https://outside.invalid${base}/issues/events?per_page=100&page=2>; rel="next"`,
          },
        }
      case `${base}/issues/comments`:
        return { body: [], headers: { 'X-Poll-Interval': '180' } }
      default:
        return undefined
    }
  })
  const store = new MemoryGithubStore()
  const options = { ...inputs, store, api: fx.api }
  await pollGithubRepository(options)
  for (const stream of ['issues', 'issue-events'] as const) {
    const cursor = await store.getCursor({ ...scope, stream })
    assert.equal(cursor?.coveredThrough, start)
    assert.equal(cursor?.fault?.kind, 'invalid-response')
  }
  fx.advance(120_000)
  await pollGithubRepository(options)
  assert.equal(fx.requests.filter((row) => row.path === `${base}/issues/comments`).length, 1)
  assert.equal(fx.requests.filter((row) => row.path === `${base}/pulls/comments`).length, 2)
})
