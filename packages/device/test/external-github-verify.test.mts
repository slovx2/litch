import assert from 'node:assert/strict'
import test from 'node:test'
import { githubContentCandidate, githubContentChange } from '../src/external/github/poll-events.mjs'
import { type GithubApi, GithubFault } from '../src/external/github/read-api.mjs'
import { githubContentHash, githubContentVersion } from '../src/external/github/read-content.mjs'
import { createGithubExternalVerification } from '../src/external/mandate-github.mjs'
import { externalFixture } from './fixtures/external-c.mjs'

for (const [eventKind, contentKind, anchor, endpoint, pull] of [
  ['issue', 'issue', '', '/issues/1', false],
  ['pull_request', 'pull', '', '/pulls/1', true],
  ['comment', 'issue-comment', '#issuecomment-', '/issues/comments/', false],
  ['comment', 'issue-comment', '#issuecomment-', '/issues/comments/', true],
  ['review_comment', 'review-comment', '#discussion_r', '/pulls/comments/', true],
  ['review', 'review', '#pullrequestreview-', '/pulls/1/reviews/', true],
] as const) {
  test(`已采集的 ${eventKind}（${pull ? 'PR' : 'issue'}）复核正文，不把后续活动当作编辑`, async (t) => {
    const f = externalFixture(t)
    const source = f.store.config.source(f.scope.sourceId)!
    const base = '/repos/test/repo'
    const now = f.clock.at * 1000
    const created = new Date(now).toISOString()
    const updated = new Date(now + 4000).toISOString()
    const author = { id: '100', login: 'owner' }
    const bot = { userId: '200', login: 'litch-bot' }
    const seed = f.event(eventKind, { actor: author.id, pr: pull })
    const parentEndpoint = pull ? '/pulls/1' : '/issues/1'
    const objectId = seed.targetEvidence.sourceEventId
    const body = '原始正文 @litch-bot'
    const parent = {
      number: '1',
      labels: [],
      html_url: seed.targetEvidence.subject.url,
      ...(pull ? { base: { repo: { id: f.repo.repoId } } } : {}),
    }
    const raw = {
      ...(anchor ? {} : parent),
      id: objectId,
      user: author,
      body,
      created_at: created,
      updated_at: created,
      submitted_at: created,
      state: 'COMMENTED',
      html_url: anchor ? `${parent.html_url}${anchor}${objectId}` : parent.html_url,
      issue_url: `https://api.github.com${base}/issues/1`,
      pull_request_url: `https://api.github.com${base}/pulls/1`,
    }
    const observe = (row: typeof raw, previous?: Parameters<typeof githubContentChange>[1]) =>
      githubContentChange(
        githubContentCandidate(row, contentKind, 1, bot),
        previous,
        f.repo,
        pull ? 'pull' : 'issue',
        bot.userId,
        now - 1000,
        now + 5000,
        now + 5000,
      )
    const { event, observation } = observe(raw)
    assert.ok(event && observation)
    assert.equal(event.targetEvidence.publication, 'published')
    const api: GithubApi = {
      generation: '1',
      now: () => now,
      async get(path) {
        let response: object
        if (path === base) response = { id: f.repo.repoId, full_name: 'test/repo' }
        else if (path === '/user') response = { id: bot.userId, login: bot.login }
        else if (path === base + endpoint + (anchor ? objectId : '')) response = raw
        else if (path === base + parentEndpoint) response = parent
        else throw new GithubFault('not-found')
        return { status: 200, body: response, serverTime: now, headers: new Headers() }
      },
    }
    const verify = createGithubExternalVerification(
      async () => api,
      () => source,
    )
    const request = { source, repo: f.repo, event, addresses: f.configuration().identities }
    assert.equal((await verify.recheckEvent(request))?.event.contentVersion, event.contentVersion)
    raw.updated_at = updated
    assert.equal(observe(raw, observation).event, undefined, '时间变化不重新发出事件')
    assert.equal(
      observe(raw).event?.targetEvidence.publication,
      'edited',
      '首次看到的晚更新时间不补发原创',
    )
    const sameBody = await verify.recheckEvent(request)
    assert.equal(sameBody?.event.contentVersion, event.contentVersion)
    assert.deepEqual(sameBody?.addressedBotIds, ['200'])
    raw.body = '真的修改正文，仍然 @litch-bot'
    assert.equal(await verify.recheckEvent(request), null)
    assert.equal(observe(raw, observation).event?.targetEvidence.publication, 'edited')
    raw.body = body
    raw.created_at = raw.submitted_at = updated
    assert.equal(await verify.recheckEvent(request), null, '创建/提交证据不同不能替换原事件')
  })
}

test('用 B 的实际解析器复查评论作者和版本，读取失败或跨 PR/issue 定位不通过', async (t) => {
  const f = externalFixture(t)
  const source = f.store.config.source(f.scope.sourceId)!
  const base = '/repos/test/repo'
  const user = { id: '100', login: 'renamed-owner' }
  const at = new Date(f.clock.at * 1000).toISOString()
  const body = '设备应处理此请求。@litch-bot-two <!-- litch-operation:agent-1 -->'
  const seed = f.event('comment', { actor: '100', target: { publication: 'published' } })
  const event = {
    ...seed,
    permalink: `${seed.permalink}#issuecomment-${seed.targetEvidence.sourceEventId}`,
    contentVersion: githubContentVersion(f.clock.at * 1000, githubContentHash(body)),
  }
  let gone = false
  let parent = '1'
  const api: GithubApi = {
    generation: '1',
    now: () => f.clock.at * 1000,
    async get(path) {
      let response: object
      if (path === base) response = { id: f.repo.repoId, full_name: 'test/repo' }
      else if (path === '/user') response = { id: '200', login: 'litch-bot' }
      else if (path === `${base}/issues/1`)
        response = {
          number: 1,
          html_url: event.targetEvidence.subject.url,
          labels: [],
          user,
          body: '',
        }
      else if (!gone && path === `${base}/issues/comments/${event.targetEvidence.sourceEventId}`)
        response = {
          id: event.targetEvidence.sourceEventId,
          issue_url: `https://api.github.com${base}/issues/${parent}`,
          html_url: event.permalink,
          user,
          body,
          updated_at: at,
          created_at: at,
        }
      else throw new GithubFault('not-found')
      return { status: 200, body: response, serverTime: f.clock.at * 1000, headers: new Headers() }
    },
  }
  const verify = createGithubExternalVerification(
    async () => api,
    (id) => f.store.config.source(id),
  )
  const request = { source, repo: f.repo, event, addresses: f.configuration().identities }
  const proof = await verify.recheckEvent(request)
  assert.equal(proof?.event.actorEvidence?.userId, '100')
  assert.equal(proof?.event.actorEvidence?.login, 'renamed-owner')
  assert.equal(proof?.agentMarked, true)
  assert.deepEqual(proof?.addressedBotIds, ['201'])
  assert.doesNotMatch(JSON.stringify(proof), /设备应处理此请求/)
  parent = '2'
  assert.equal(await verify.recheckEvent(request), null)
  parent = '1'
  gone = true
  assert.equal(await verify.recheckEvent(request), null)
})

test('当前指派存在仍须证实原发起者和未撤销，B 角色证据不得由目标用户代替', async (t) => {
  const f = externalFixture(t)
  const source = f.store.config.source(f.scope.sourceId)!
  const base = '/repos/test/repo'
  const actor = { id: '300', login: 'author' }
  const event = f.event('assigned', { target: { assigneeUserId: '200' } })
  const stamp = new Date(f.clock.at * 1000).toISOString()
  const add = {
    id: event.targetEvidence.sourceEventId,
    event: 'assigned',
    assigner: actor,
    assignee: { id: '200' },
    created_at: stamp,
  }
  const removed = {
    ...add,
    id: '321',
    event: 'unassigned',
    created_at: new Date((f.clock.at + 1) * 1000).toISOString(),
  }
  let timeline: object[] = [add]
  let checkedUser = '300'
  const api: GithubApi = {
    generation: '1',
    now: () => f.clock.at * 1000,
    async get(path) {
      let response: object
      if (path === base) response = { id: f.repo.repoId, full_name: 'test/repo' }
      else if (path === `${base}/issues/1`)
        response = {
          number: '1',
          html_url: event.permalink,
          labels: [],
          assignees: [{ id: '200' }],
        }
      else if (path === `${base}/issues/1/timeline?per_page=100&page=1`) response = timeline
      else if (path === `${base}/collaborators/author/permission`)
        response = {
          permission: 'read',
          role_name: 'triage',
          user: { id: checkedUser },
        }
      else throw new GithubFault('not-found')
      return { status: 200, body: response, serverTime: f.clock.at * 1000, headers: new Headers() }
    },
  }
  const verify = createGithubExternalVerification(
    async () => api,
    (id) => f.store.config.source(id),
  )
  const request = { source, repo: f.repo, event, addresses: f.configuration().identities }
  assert.equal((await verify.recheckEvent(request))?.event.actorEvidence?.userId, '300')
  assert.equal(
    (await verify.lookupGithubRole(source.sourceId, f.repo, { userId: '300', login: 'author' }))
      .state,
    'verified',
  )
  checkedUser = '200'
  assert.equal(
    (await verify.lookupGithubRole(source.sourceId, f.repo, { userId: '300', login: 'author' }))
      .state,
    'identity-mismatch',
  )
  timeline = [add, removed, { ...add, id: '322', created_at: removed.created_at }]
  assert.equal(await verify.recheckEvent(request), null)
})
