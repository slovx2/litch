import assert from 'node:assert/strict'
import test from 'node:test'
import { type GithubApi, GithubFault } from '../src/external/github/read-api.mjs'
import { githubContentHash, githubContentVersion } from '../src/external/github/read-content.mjs'
import { createGithubExternalVerification } from '../src/external/mandate-github.mjs'
import { externalFixture } from './fixtures/external-c.mjs'

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
