import assert from 'node:assert/strict'
import test from 'node:test'
import { checkIdentityRepositoryWrites } from '../src/external/execution-boundary.mjs'
import { feedbackOperationId, githubAckMarker } from '../src/external/github/write-feedback.mjs'
import { ExternalGithubOutbox } from '../src/external/outbox.mjs'
import type { GithubFeedbackIntent } from '../src/external/outbox-feedback-intent.mjs'
import type { ExternalWriteIntent } from '../src/external/outbox-payload.mjs'
import {
  actor,
  bot,
  externalFixture,
  repoMetadata,
  repoPath,
  respond,
  subject,
} from './fixtures/external-d.mjs'

const comments = `${repoPath}/issues/8/comments`
const single = `${repoPath}/issues/comments/71`
const received = '已收到，已交给机器人。'
const notified = '经理已开始处理。'
const base = {
  sourceId: 's',
  managerId: actor.managerId,
  botUserId: bot,
  identityId: bot,
  subject,
}
const create = (id: string): GithubFeedbackIntent => ({
  ...base,
  action: 'ack_comment_create',
  text: received,
  idempotencyKey: `ack:create:${id}`,
})
const edit = (id: string): GithubFeedbackIntent => ({
  ...base,
  action: 'ack_comment_update',
  text: notified,
  idempotencyKey: `ack:update:${id}`,
  createKey: `ack:create:${id}`,
})
const operation = (intent: GithubFeedbackIntent) =>
  feedbackOperationId(intent.sourceId, intent.subject.repoId, intent.idempotencyKey)
const returned = (body: unknown, user = bot) => ({
  id: '71',
  body,
  user: { id: user },
  issue_url: 'https://api.github.com/repos/example/demo/issues/8',
})

test('固定反馈按经理身份新增并编辑同一评论；经理工具不能调用固定动作', async (t) => {
  let remote: Record<string, unknown> | undefined
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname === comments && req.method === 'POST') {
      remote = returned(data.body)
      respond(res, remote, 201)
    } else if (url.pathname === single && req.method === 'GET') respond(res, remote)
    else if (url.pathname === single && req.method === 'PATCH') {
      assert.equal(remote?.id, '71')
      remote = returned(data.body)
      respond(res, remote)
    } else return false
    return true
  })
  const outbox = new ExternalGithubOutbox({
    store: f.store,
    secrets: f.secrets,
    stateDirectory: f.dir,
    send: f.send,
    now: f.now,
    assignmentForManager: () => ({
      identityId: bot,
      repoIds: [subject.repoId],
      injectCredentials: false,
    }),
  })
  for (const action of ['ack_comment_create', 'ack_comment_update', 'reaction_add']) {
    assert.throws(
      () =>
        outbox.enqueue(actor, {
          ...f.request,
          idempotencyKey: 'bad-action',
          intent: { action } as unknown as ExternalWriteIntent,
        }),
      /external_write_action_not_allowed/,
    )
  }
  assert.equal(await outbox.enqueueFeedback(create('group')), 'queued')
  assert.equal(await outbox.enqueueFeedback(create('group')), 'queued')
  const createId = operation(create('group'))
  await outbox.tick()
  assert.equal(remote?.body, `${received}\n\n${githubAckMarker(createId)}`)
  assert.equal(await outbox.enqueueFeedback(edit('group')), 'queued')
  await outbox.tick()
  assert.equal(remote?.body, `${notified}\n\n${githubAckMarker(createId)}`)
  const created = f.store.queue.outboxRecord(createId)
  const updated = f.store.queue.outboxRecord(operation(edit('group')))
  assert.equal(created?.receipt?.objectId, '71')
  assert.equal(updated?.receipt?.objectId, '71')
  assert.equal(updated?.action, 'ack_comment_update')
  assert.deepEqual(
    f.requests
      .filter((req) => req.method === 'POST' || req.method === 'PATCH')
      .map((req) => [req.method, req.path]),
    [
      ['POST', comments],
      ['PATCH', single],
    ],
  )
})

test('创建和编辑丢失回执时均只对账；确认前不会另建评论或提前编辑', async (t) => {
  let remote: Record<string, unknown> | undefined
  let visible = false
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname === comments && req.method === 'POST') {
      remote = returned(data.body)
      res.destroy()
    } else if (url.pathname === comments && req.method === 'GET') {
      respond(res, visible ? [remote] : [returned(remote?.body, '777')])
    } else if (url.pathname === single && req.method === 'GET') respond(res, remote)
    else if (url.pathname === single && req.method === 'PATCH') {
      remote = returned(data.body)
      res.destroy()
    } else return false
    return true
  })
  const created = operation(create('crash'))
  const updated = operation(edit('crash'))
  assert.equal(await f.outbox.enqueueFeedback(create('crash')), 'queued')
  assert.equal(await f.outbox.enqueueFeedback(edit('crash')), 'queued')
  await f.outbox.tick()
  assert.equal(f.store.queue.outboxRecord(created)?.state, 'unknown')
  assert.equal(f.store.queue.outboxRecord(updated)?.attempts, 0)
  const restart = f.newOutbox()
  await restart.tick()
  assert.equal(f.store.queue.outboxRecord(created)?.state, 'unknown')
  visible = true
  f.clock.at += 30
  await restart.tick()
  assert.equal(f.store.queue.outboxRecord(created)?.receipt?.verifiedBy, 'lookup')
  assert.equal(f.store.queue.outboxRecord(updated)?.state, 'unknown')
  await f.newOutbox().tick()
  assert.equal(f.store.queue.outboxRecord(updated)?.receipt?.verifiedBy, 'lookup')
  assert.equal(f.store.queue.outboxRecord(updated)?.receipt?.objectId, '71')
  assert.deepEqual(
    f.requests
      .filter((req) => req.method === 'POST' || req.method === 'PATCH')
      .map((req) => [req.method, req.path]),
    [
      ['POST', comments],
      ['PATCH', single],
    ],
  )
})

test('同一条评论的同一个反应幂等；GitHub 已存在的 200 可直接记回执', async (t) => {
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname === single && req.method === 'GET') respond(res, returned('原请求', '33'))
    else if (url.pathname === `${single}/reactions` && req.method === 'POST') {
      assert.equal(data.content, 'eyes')
      respond(res, { id: '809', content: 'eyes', user: { id: bot } }, 200)
    } else return false
    return true
  })
  const reaction: GithubFeedbackIntent = {
    ...base,
    action: 'reaction_add',
    comment: { kind: 'comment', id: '71' },
    reaction: 'eyes',
    idempotencyKey: `reaction:github:${subject.repoId}:comment:71:eyes`,
  }
  assert.equal(await f.outbox.enqueueFeedback(reaction), 'queued')
  assert.equal(await f.outbox.enqueueFeedback(reaction), 'queued')
  assert.equal(
    await f.outbox.enqueueFeedback({ ...reaction, idempotencyKey: 'new-key' }),
    'skipped',
  )
  await f.outbox.tick()
  const restarted = f.newOutbox()
  assert.equal(await restarted.enqueueFeedback(reaction), 'queued')
  await restarted.tick()
  assert.equal(f.store.queue.outboxRecord(operation(reaction))?.receipt?.objectId, '809')
  assert.equal(f.requests.filter((req) => req.method === 'POST').length, 1)
})

test('已知没有写权限则跳过；403 经同代记为缺权并提示，后续不继续发', async (t) => {
  const noRole = await externalFixture(t, (_req, res, url) => {
    if (url.pathname !== repoPath) return false
    respond(res, {
      ...repoMetadata,
      permissions: { push: false, triage: false, maintain: false, admin: false },
    })
    return true
  })
  assert.equal(await noRole.outbox.enqueueFeedback(create('read-only')), 'skipped')
  await noRole.outbox.tick()
  assert.equal(noRole.requests.filter((req) => req.method === 'POST').length, 0)
  assert.equal(
    checkIdentityRepositoryWrites({
      secrets: noRole.secrets,
      identityId: bot,
      repositories: noRole.source.repos,
    })[0]?.code,
    'github_feedback_write_permission_required',
  )

  const denied = await externalFixture(t, (req, res, url) => {
    if (url.pathname !== comments || req.method !== 'POST') return false
    respond(res, { message: 'Resource not accessible by personal access token' }, 403)
    return true
  })
  const given = create('denied')
  assert.equal(await denied.outbox.enqueueFeedback(given), 'queued')
  await denied.outbox.tick()
  assert.equal(denied.store.queue.outboxRecord(operation(given))?.state, 'blocked')
  assert.equal(await denied.outbox.enqueueFeedback(create('another')), 'skipped')
  assert.equal(denied.requests.filter((req) => req.method === 'POST').length, 1)
  assert.equal(
    checkIdentityRepositoryWrites({
      secrets: denied.secrets,
      identityId: bot,
      repositories: denied.source.repos,
    })[0]?.code,
    'github_feedback_write_permission_required',
  )
})

test('仓库开关禁用反馈；行内 review 反应丢回执后只查原评论的同类反应', async (t) => {
  const reviewComment = `${repoPath}/pulls/comments/28`
  const feedback = `${reviewComment}/reactions`
  const f = await externalFixture(t, (_req, res, url, data) => {
    if (url.pathname === reviewComment)
      respond(res, {
        id: '28',
        pull_request_url: 'https://api.github.com/repos/example/demo/pulls/17',
      })
    else if (url.pathname === feedback) {
      if (data.content === 'rocket') res.destroy()
      else {
        assert.equal(url.searchParams.get('content'), 'rocket')
        respond(res, [{ id: '53', content: 'rocket', user: { id: bot } }])
      }
    } else return false
    return true
  })
  const repo = f.source.repos[0]
  assert.ok(repo)
  const disabledRepo = { ...repo, immediateFeedback: false }
  assert.equal(
    f.store.config.saveSource(
      { ...f.source, repos: [disabledRepo] },
      1,
      'feedback-disabled',
      'user',
    ).outcome,
    'applied',
  )
  const reaction: GithubFeedbackIntent = {
    ...base,
    subject: {
      ...subject,
      kind: 'pull_request',
      number: '17',
      url: 'https://github.com/example/demo/pull/17',
    },
    action: 'reaction_add',
    comment: { kind: 'review_comment', id: '28' },
    reaction: 'rocket',
    idempotencyKey: `reaction:github:${subject.repoId}:review_comment:28:rocket`,
  }
  assert.equal(await f.outbox.enqueueFeedback(reaction), 'skipped')
  assert.equal(
    f.store.config.saveSource(f.source, 2, 'feedback-restored', 'user').outcome,
    'applied',
  )
  assert.equal(await f.outbox.enqueueFeedback(reaction), 'queued')
  await f.outbox.tick()
  assert.equal(f.store.queue.outboxRecord(operation(reaction))?.state, 'unknown')
  await f.newOutbox().tick()
  assert.equal(f.store.queue.outboxRecord(operation(reaction))?.receipt?.verifiedBy, 'lookup')
  assert.equal(f.requests.filter((req) => req.method === 'POST').length, 1)
})
