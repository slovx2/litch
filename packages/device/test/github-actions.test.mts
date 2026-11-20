import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type GithubRunWatch, observeGithubRun } from '../src/external/github/actions.mjs'
import { pollGithubRepository } from '../src/external/github/poll.mjs'
import {
  actor,
  base,
  githubFixture,
  head,
  iso,
  MemoryGithubStore,
  pull,
  pullIssue,
  repo,
  sourceId,
  start,
} from './github-poll-fixture.mjs'

const at = start + 20_000
const runId = '9007199254741001'
const association = {
  number: 2,
  base: { repo: { id: repo.repoId } },
  head: { sha: head, repo: { id: repo.repoId } },
}
const run = (attempt: number, status: string, conclusion: string | null, other = {}) => ({
  id: runId,
  run_attempt: attempt,
  status,
  conclusion,
  updated_at: iso(at),
  head_sha: head,
  workflow_id: 851,
  repository: { id: repo.repoId },
  head_repository: { id: repo.repoId },
  pull_requests: [association],
  ...other,
})
const bound = { number: 2, headSha: head, headRepoId: repo.repoId }

test('CI 精确到仓库、run、attempt、head 和 workflow；超时状态未知且之后可以转完成', async (t) => {
  let mode = 'waiting'
  const path = `${base}/actions/runs/${runId}`
  const fx = await githubFixture(t, (url) => {
    if (url.pathname === path) return { body: run(2, 'completed', 'failure') }
    if (url.pathname === `${path}/attempts/1`) {
      if (mode === 'mismatch') return { body: run(1, 'completed', 'failure', { workflow_id: 999 }) }
      if (mode === 'missing') return { status: 404 }
      return {
        body: mode === 'waiting' ? run(1, 'in_progress', null) : run(1, 'completed', 'success'),
      }
    }
    return undefined
  })
  const watch: GithubRunWatch = {
    repoId: repo.repoId,
    runId,
    attempt: 1,
    headSha: head,
    workflowId: '851',
    pullNumber: 2,
    deadline: fx.now() + 1000,
  }
  assert.equal((await observeGithubRun(fx.api, repo, watch, bound)).state, 'waiting')
  fx.advance(2000)
  const timeout = await observeGithubRun(fx.api, repo, watch, bound)
  assert.ok(
    timeout.state === 'unknown' &&
      timeout.reason === 'deadline' &&
      timeout.snapshot?.conclusion === null,
  )
  mode = 'completed'
  const completed = await observeGithubRun(fx.api, repo, watch, bound)
  assert.ok(completed.state === 'completed' && completed.snapshot.conclusion === 'success')
  assert.match(completed.snapshot.permalink, new RegExp(`/actions/runs/${runId}$`))
  mode = 'mismatch'
  assert.deepEqual(await observeGithubRun(fx.api, repo, watch, bound), {
    state: 'unknown',
    reason: 'invalid-response',
  })
  mode = 'missing'
  assert.deepEqual(await observeGithubRun(fx.api, repo, watch, bound), {
    state: 'unknown',
    reason: 'not-found',
  })
  assert.deepEqual(
    await observeGithubRun(fx.api, repo, watch, { ...bound, headSha: 'b'.repeat(40) }),
    { state: 'unknown', reason: 'evidence-mismatch' },
  )
  assert.equal(fx.requests.filter((row) => row.path === path).length, 5)
  assert.equal(fx.requests.filter((row) => row.path === `${path}/attempts/1`).length, 5)
})

test('已绑定 PR 核对 head 与 CI 关联；同一合并不另发关闭，缺少关联只记待确认', async (t) => {
  const pr = pull(at, { state: 'closed', closed_at: iso(at), merged_at: iso(at), merged_by: actor })
  const fx = await githubFixture(t, (url) => {
    if (url.pathname === `${base}/pulls/2`) return { body: pr }
    if (url.pathname === `${base}/issues/events`)
      return {
        body: [{ event: 'closed', id: 818, issue: pullIssue(at), actor, created_at: iso(at) }],
      }
    if (url.pathname === `${base}/actions/runs`)
      return {
        body: {
          workflow_runs: [
            run(1, 'in_progress', null),
            run(1, 'completed', 'failure', { id: 900, pull_requests: [] }),
            run(1, 'completed', 'failure', { id: 901, head_sha: 'b'.repeat(40) }),
          ],
        },
      }
    if (url.pathname === `${base}/actions/runs/${runId}`)
      return { body: run(1, 'completed', 'success') }
    return undefined
  })
  const store = new MemoryGithubStore()
  await pollGithubRepository({
    sourceId,
    repo,
    botUserId: '99',
    enabledAt: start,
    api: fx.api,
    store,
    boundPulls: [{ number: 2 }],
  })
  assert.deepEqual([...store.events.values()].map((row) => row.kind).sort(), [
    'ci',
    'merged',
    'pull_request',
  ])
  assert.equal(store.runs.filter((row) => row.state === 'association-pending').length, 1)
  assert.equal(store.pulls.get(2)?.headSha, head)
  const event = [...store.events.values()].find((row) => row.kind === 'ci')
  assert.equal(event?.externalEventKey, `github/${repo.repoId}/run/${runId}/1/completed/success`)
  assert.equal(event?.targetEvidence.run?.conclusion, 'success')
  assert.equal(fx.requests.filter((row) => row.path === `${base}/actions/runs/${runId}`).length, 1)
  assert.ok(!fx.requests.some((row) => row.path.endsWith('/actions/runs/900')))
})
