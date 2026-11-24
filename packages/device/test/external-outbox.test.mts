import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ExternalGithubOutbox,
  type ExternalWriteRequest,
  externalDraftHead,
} from '../src/external/outbox.mjs'
import { ExternalStore } from '../src/external-store.mjs'
import { ManagerStore, openManagerDatabase } from '../src/manager-store.mjs'
import {
  actor,
  bot,
  externalFixture,
  repoPath,
  respond,
  subject,
  token,
} from './fixtures/external-d.mjs'

const sha = '0123456789abcdef0123456789abcdef01234567'
const comment = { action: 'comment' as const, body: '机器人回复。' }
const commentsPath = `${repoPath}/issues/8/comments`
const commentResponse = (body: unknown, user = bot, id = '45') => ({
  id,
  user: { id: user },
  body,
  issue_url: 'https://api.github.com/repos/example/demo/issues/8',
  created_at: '2026-01-01T01:01:00Z',
})

test('只对绑定 X-n 的主题发送评论，同键同意图重放原回执，数据库不存正文', async (t) => {
  const f = await externalFixture(t, (req, res, url, data) => {
    if (req.method !== 'POST' || url.pathname !== commentsPath) return false
    assert.match(String(data.body), /<!-- litch-operation:ghw-[a-f\d]+ -->$/)
    respond(res, commentResponse(data.body), 201)
    return true
  })
  const input = { ...f.request, idempotencyKey: 'one', intent: comment }
  assert.throws(() => f.outbox.enqueue({ ...actor, threadId: 'old' }, input), /forbidden/)
  assert.throws(
    () => f.outbox.enqueue(actor, { ...input, target: { ...input.target, number: '9' } }),
    /binding/,
  )
  assert.throws(
    () =>
      f.outbox.enqueue(actor, {
        ...input,
        intent: { action: 'managed_push' } as unknown as ExternalWriteRequest['intent'],
      }),
    /not_allowed/,
  )
  assert.throws(
    () => f.outbox.enqueue(actor, { ...input, intent: { ...comment, body: token() } }),
    /text_invalid/,
  )
  const queued = f.outbox.enqueue(actor, input)
  assert.equal(queued.state, 'queued')
  assert.equal(queued.operationId, f.outbox.enqueue(actor, input).operationId)
  assert.throws(
    () => f.outbox.enqueue(actor, { ...input, intent: { ...comment, body: '正文改动' } }),
    /idempotency_conflict/,
  )
  await f.outbox.tick()
  assert.deepEqual(f.outbox.get(actor, queued.operationId)?.receipt, {
    at: 1767229260,
    botUserId: bot,
    objectId: '45',
    requestId: 'AB:0123',
    url: `${subject.url}#issuecomment-45`,
    verifiedBy: 'response',
  })
  assert.equal(f.outbox.enqueue(actor, input).issueId, 'X-1')
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1)
  const row = f.store.queue.outboxRecord(queued.operationId)
  assert.ok(row)
  assert.doesNotMatch(
    JSON.stringify({ row, audit: f.store.audit(`github/${subject.repoId}/${subject.number}`) }),
    /机器人回复|github_pat_/,
  )
})

for (const replied of [false, true])
  test(`升级按原接单恢复${replied ? '已有' : '缺失'}回执和历史终态，不补唤醒旧记录`, async (t) => {
    const f = await externalFixture(t, (req, res, url, data) => {
      if (req.method !== 'POST' || url.pathname !== commentsPath) return false
      respond(res, commentResponse(data.body), 201)
      return true
    })
    let operationId: string | null = null
    if (replied) {
      const queued = f.outbox.enqueue(actor, {
        ...f.request,
        idempotencyKey: 'legacy-reply',
        intent: comment,
      })
      await f.outbox.tick()
      assert.equal(f.store.queue.outboxRecord(queued.operationId)?.state, 'confirmed')
      operationId = queued.operationId
    }
    const raw = f.store.manager.issue(actor.managerId, f.request.issueId) as Record<string, unknown>
    f.store.manager.saveIssue(actor.managerId, f.request.issueId, { ...raw, status: 'resolved' })
    f.store.manager.db.exec(
      'DROP TABLE manager_idle_compact; DROP TABLE external_result_replies; DROP TABLE feishu_apps; DROP TABLE feishu_operations; DROP TABLE feishu_audit; DROP TABLE feishu_chats; DROP TABLE speech_policies; DROP TABLE feishu_inbox; DROP TABLE feishu_context_cursor; DROP TABLE feishu_deliveries; DROP TABLE reviews; DROP TABLE feishu_outbox; DROP TABLE feishu_bindings; DROP TABLE feishu_pairings; DROP TABLE feishu_review_notices; DROP TABLE feishu_user_grants; PRAGMA user_version=11',
    )
    const reopened = new ManagerStore(openManagerDatabase(f.dir))
    try {
      const migrated = new ExternalStore(reopened).resultReplies
      assert.equal(
        migrated.matches(actor.managerId, f.request.issueId, f.request.sourceId, subject),
        true,
      )
      assert.equal(migrated.missing(actor.managerId, f.request.issueId) === null, replied)
      const row = reopened.db
        .prepare('SELECT receipt_id, terminal FROM external_result_replies')
        .get()
      assert.equal(row?.receipt_id, operationId)
      assert.equal(row?.terminal, 1)
      migrated.queueReminders()
      assert.deepEqual(migrated.pendingManagerIds(), [])
    } finally {
      reopened.close()
    }
  })

test('已回帖的开放议题只按 GitHub 收尾证据排一次状态提醒，状态改变时撤销待投递', async (t) => {
  const f = await externalFixture(t, (req, res, url, data) => {
    if (req.method !== 'POST' || url.pathname !== commentsPath) return false
    respond(res, commentResponse(data.body), 201)
    return true
  })
  const { managerId } = actor
  const { issueId, sourceId } = f.request
  const replies = f.store.resultReplies
  const raw = f.store.manager.issue(managerId, issueId) as Record<string, unknown>
  replies.finish(managerId, issueId)
  replies.queueReminders()
  const replyReminder = f.store.manager
    .deliveries(managerId)
    .find(({ text }) => text.includes('externalResultReplies'))
  assert.ok(replyReminder)
  const result = f.outbox.enqueue(actor, {
    ...f.request,
    idempotencyKey: 'result-before-close',
    intent: { ...comment, purpose: 'result' },
  })
  await f.outbox.tick()
  assert.equal(f.store.queue.outboxRecord(result.operationId)?.state, 'confirmed')
  assert.equal(
    f.store.manager.deliveries(managerId).some(({ id }) => id === replyReminder.id),
    false,
    '回帖确认只撤销对应的未回帖提醒',
  )
  replies.finish(managerId, issueId) // 看板本地收尾不能冒充 GitHub 关闭。
  replies.queueReminders()
  assert.deepEqual(replies.pendingManagerIds(), [])
  f.store.observeSubject(sourceId, { subject, state: 'closed', updatedAt: 998 }, 1000)
  replies.queueReminders()
  assert.deepEqual(replies.pendingManagerIds(), [], '接单前的关闭信息不能触发')
  f.store.observeSubject(sourceId, { subject, state: 'closed', updatedAt: 1001 }, 1001)
  replies.queueReminders()
  replies.queueReminders()
  const pending = f.store.manager
    .deliveries(managerId)
    .find(({ text }) => text.includes('externalIssueStatusCheck'))
  assert.ok(pending)
  assert.notEqual(pending.id, replyReminder.id, '状态提醒不能覆盖旧回帖提醒的投递 ID')
  assert.equal(replies.reminderCurrent(managerId, issueId, replyReminder.id, 'reply'), false)
  assert.equal(replies.reminderCurrent(managerId, issueId, pending.id, 'status'), true)
  assert.deepEqual(replies.pendingManagerIds(), [managerId])
  const reopened = new ManagerStore(openManagerDatabase(f.dir))
  try {
    const restored = new ExternalStore(reopened).resultReplies
    restored.queueReminders()
    assert.equal(
      reopened.deliveries(managerId).filter(({ text }) => text.includes('externalIssueStatusCheck'))
        .length,
      1,
      '重启不重复排队',
    )
    assert.equal(restored.reminderCurrent(managerId, issueId, pending.id, 'status'), true)
    reopened.transaction(() => {
      reopened.saveIssue(managerId, issueId, { ...raw, status: 'blocked' })
      restored.issueStatusChanged(managerId, issueId)
    })
    reopened.saveIssue(managerId, issueId, { ...raw, status: 'open' })
    restored.queueReminders()
    assert.equal(restored.reminderCurrent(managerId, issueId, pending.id, 'status'), false)
    assert.deepEqual(restored.pendingManagerIds(), [])
  } finally {
    reopened.close()
  }
})

test('关联 PR 未合并即关闭：已回帖后只提示复核看板，不产生未回帖标记', async (t) => {
  const f = await externalFixture(t, (req, res, url, data) => {
    if (req.method !== 'POST' || url.pathname !== commentsPath) return false
    respond(res, commentResponse(data.body), 201)
    return true
  })
  const { managerId } = actor
  const { issueId, sourceId } = f.request
  const pr = {
    ...subject,
    kind: 'pull_request' as const,
    number: '19',
    url: 'https://github.com/example/demo/pull/19',
  }
  f.store.bindRef({ ...pr, managerId, issueId, origin: 'write_receipt', createdAt: f.now() })
  f.store.observeSubject(sourceId, { subject: pr, state: 'closed', updatedAt: f.now() }, f.now())
  const replies = f.store.resultReplies
  replies.queueReminders()
  assert.equal(replies.missing(managerId, issueId), null)
  assert.deepEqual(replies.pendingManagerIds(), [])
  const result = f.outbox.enqueue(actor, {
    ...f.request,
    idempotencyKey: 'closed-pr-result',
    intent: { ...comment, purpose: 'result' },
  })
  await f.outbox.tick()
  assert.equal(f.store.queue.outboxRecord(result.operationId)?.state, 'confirmed')
  replies.queueReminders()
  const [event] = f.store.manager.deliveries(managerId)
  assert.match(event?.text ?? '', /externalIssueStatusCheck/)
})

test('工作线自行推送后，设备仅对原仓库和批准 base 创建草稿、回执与原 X-n 同时提交', async (t) => {
  let workHead = ''
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname === `${repoPath}/git/ref/heads/${workHead}`) {
      respond(res, { ref: `refs/heads/${workHead}`, object: { sha, type: 'commit' } })
      return true
    }
    if (url.pathname !== `${repoPath}/pulls` || req.method !== 'POST') return false
    assert.deepEqual([data.head, data.base, data.draft], [workHead, 'main', true])
    respond(
      res,
      {
        id: '800',
        number: '9',
        title: data.title,
        body: data.body,
        user: { id: bot },
        draft: true,
        head: { repo: { id: subject.repoId }, ref: workHead, sha },
        base: { repo: { id: subject.repoId }, ref: 'main' },
      },
      201,
    )
    return true
  })
  const repo = f.source.repos[0]
  assert.ok(repo)
  workHead = externalDraftHead(repo, actor.managerId, f.request.issueId, 'line-a')
  const input = {
    ...f.request,
    idempotencyKey: 'draft',
    intent: {
      action: 'draft_pr' as const,
      title: '提交',
      body: '',
      head: workHead,
      headSha: sha,
      base: 'main',
    },
  }
  for (const [head, base] of [
    ['other:fork', 'main'],
    ['litch/work/other-line', 'main'],
    [workHead, 'dev'],
  ] as const)
    assert.throws(
      () =>
        f.outbox.enqueue(actor, {
          ...input,
          intent: { ...input.intent, head, base },
        }),
      /branch/,
    )
  const mismatched = f.outbox.enqueue(actor, {
    ...input,
    idempotencyKey: 'other-sha',
    intent: { ...input.intent, headSha: 'f'.repeat(40) },
  })
  const queued = f.outbox.enqueue(actor, input)
  await f.outbox.tick()
  assert.equal(
    f.outbox.get(actor, mismatched.operationId)?.errorClass,
    'external_draft_head_does_not_match',
  )
  assert.equal(f.outbox.get(actor, queued.operationId)?.state, 'confirmed')
  assert.deepEqual(
    f.store.refs(actor.managerId, f.request.issueId).map((r) => [r.number, r.origin]),
    [
      ['8', 'intake'],
      ['9', 'write_receipt'],
    ],
  )
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1)
})

test('崩溃后不重发；分页对账按原线程、机器人数字 ID 和正文核对标记', async (t) => {
  let payload = ''
  let matchExists = false
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname !== commentsPath) return false
    if (req.method === 'POST') {
      payload = String(data.body)
      res.destroy()
    } else if (url.searchParams.get('page') === '1') {
      // 即使 GitHub 回传外站分页地址，也只用固定模板计算下一页。
      res.setHeader('Link', '<https://unexpected.invalid/collect>; rel="next"')
      respond(res, [commentResponse(payload, '333', '46'), commentResponse('改过正文', bot, '47')])
    } else respond(res, matchExists ? [commentResponse(payload)] : [])
    return true
  })
  const input = { ...f.request, idempotencyKey: 'crash', intent: comment }
  const queued = f.outbox.enqueue(actor, input)
  await f.outbox.tick()
  assert.equal(f.outbox.get(actor, queued.operationId)?.state, 'unknown')
  const restarted = f.newOutbox()
  await restarted.tick()
  assert.equal(restarted.get(actor, queued.operationId)?.errorClass, 'github_write_no_proof')
  assert.equal(restarted.enqueue(actor, input).state, 'unknown')
  matchExists = true
  assert.equal(
    f.store.config.saveSource({ ...f.source, enabled: false }, 1, 'pause', 'user').outcome,
    'applied',
  )
  f.clock.at += 30
  await restarted.tick()
  assert.equal(restarted.get(actor, queued.operationId)?.receipt?.verifiedBy, 'lookup')
  assert.equal(f.store.queue.writeAttempts(queued.operationId)[0]?.outcome, 'unknown')
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1)
})

test('租约过期和对账窗口结束仍保持未知；用户可查单项但不会自动重发', async (t) => {
  const f = await externalFixture(t)
  const queued = f.outbox.enqueue(actor, {
    ...f.request,
    idempotencyKey: 'expired-lease',
    intent: comment,
  })
  assert.equal(
    f.store.queue.beginWrite(queued.operationId, queued.revision, f.now(), f.now() + 5).outcome,
    'applied',
  )
  f.clock.at += 6
  const restarted = f.newOutbox()
  await restarted.tick()
  assert.equal(restarted.get(actor, queued.operationId)?.state, 'unknown')
  assert.equal(f.store.queue.writeAttempts(queued.operationId)[0]?.errorClass, 'lease_expired')
  f.clock.at += 601
  await restarted.tick()
  const missing = restarted.get(actor, queued.operationId)
  assert.equal(missing?.errorClass, 'external_write_manual_confirmation_required')
  const requests = f.requests.length
  await restarted.tick()
  assert.equal(f.requests.length, requests)
  await restarted.reconcile(queued.operationId)
  assert.ok(f.requests.length > requests)
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0)
})

test('发送前轮换只重排确认未发出的尝试，发送前暂停会挡下请求', async (t) => {
  let duringPreflight: (() => Promise<void> | void) | undefined
  const f = await externalFixture(t, async (req, res, url, data) => {
    if (url.pathname === `${repoPath}/issues/8` && duringPreflight) {
      const act = duringPreflight
      duringPreflight = undefined
      await act()
    }
    if (url.pathname !== commentsPath || req.method !== 'POST') return false
    respond(res, commentResponse(data.body), 201)
    return true
  })
  const queued = f.outbox.enqueue(actor, {
    ...f.request,
    idempotencyKey: 'rotate',
    intent: comment,
  })
  duringPreflight = async () => {
    assert.equal(
      (
        await f.secrets.rotate({
          credentialRef: f.credentialRef,
          operationId: 'rotate',
          expectedGeneration: 1,
          token: token('second'),
        })
      ).outcome,
      'applied',
    )
  }
  await f.outbox.tick()
  assert.equal(f.outbox.get(actor, queued.operationId)?.state, 'queued')
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0)
  f.clock.at += 100
  await f.outbox.tick()
  assert.equal(f.outbox.get(actor, queued.operationId)?.state, 'confirmed')
  assert.equal(f.requests.findLast((r) => r.method === 'POST')?.auth, `Bearer ${token('second')}`)

  const paused = f.outbox.enqueue(actor, { ...f.request, idempotencyKey: 'pause', intent: comment })
  duringPreflight = () => {
    assert.equal(
      f.store.config.saveSource({ ...f.source, enabled: false }, 1, 'pause', 'user').outcome,
      'applied',
    )
  }
  await f.outbox.tick()
  assert.equal(f.outbox.get(actor, paused.operationId)?.state, 'blocked')
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1)
})

test('草稿回执丢失后从 state=all 查证人工已关闭的 PR，并绑定原 X-n', async (t) => {
  let workHead = ''
  let remote: Record<string, unknown> | undefined
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname === `${repoPath}/git/ref/heads/${workHead}`) {
      respond(res, { ref: `refs/heads/${workHead}`, object: { sha, type: 'commit' } })
      return true
    }
    if (url.pathname === `${repoPath}/pulls` && req.method === 'POST') {
      remote = {
        id: '901',
        number: '11',
        title: data.title,
        body: data.body,
        user: { id: bot },
        draft: false,
        state: 'closed',
        head: { repo: { id: subject.repoId }, ref: workHead, sha },
        base: { repo: { id: subject.repoId }, ref: 'main' },
      }
      res.destroy()
    } else if (url.pathname === `${repoPath}/pulls` && url.searchParams.get('state') === 'all') {
      assert.equal(url.searchParams.get('head'), `example:${workHead}`)
      assert.equal(url.searchParams.get('base'), 'main')
      respond(res, remote ? [remote] : [])
    } else if (url.pathname === `${repoPath}/pulls/11` && remote) respond(res, remote)
    else return false
    return true
  })
  const repo = f.source.repos[0]
  assert.ok(repo)
  workHead = externalDraftHead(repo, actor.managerId, f.request.issueId, 'line-b')
  const queued = f.outbox.enqueue(actor, {
    ...f.request,
    idempotencyKey: 'draft-crash',
    intent: {
      action: 'draft_pr',
      title: '提交',
      body: '原内容',
      head: workHead,
      headSha: sha,
      base: 'main',
    },
  })
  await f.outbox.tick()
  assert.equal(f.outbox.get(actor, queued.operationId)?.state, 'unknown')
  assert.equal(
    f.outbox.pendingDraft({
      sourceId: f.source.sourceId,
      repoId: subject.repoId,
      head: workHead,
      base: 'main',
      botUserId: bot,
    }),
    queued.operationId,
  )
  const restarted = f.newOutbox()
  await restarted.tick()
  assert.equal(restarted.get(actor, queued.operationId)?.receipt?.verifiedBy, 'lookup')
  assert.equal(f.store.ref({ ...subject, number: '11' })?.issueId, 'X-1')
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1)
})

test('忽略且回复用处置事务只回复原主题，同一个处置键不会再发', async (t) => {
  const unknownTopic = {
    ...subject,
    number: '10',
    url: 'https://github.com/example/demo/issues/10',
  }
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname === `${repoPath}/issues/10`) respond(res, { id: '91', number: '10' })
    else if (url.pathname === `${repoPath}/issues/10/comments` && req.method === 'POST')
      respond(
        res,
        {
          ...commentResponse(data.body),
          issue_url: 'https://api.github.com/repos/example/demo/issues/10',
        },
        201,
      )
    else return false
    return true
  })
  f.addIntake('ignored', unknownTopic)
  const commit = {
    action: 'ignore' as const,
    intakeId: 'ignored',
    managerId: actor.managerId,
    expectedRevision: 1,
    idempotencyKey: 'ignore-key',
    at: f.now(),
    actorId: actor.threadId,
    reason: '内部忽略原因',
  }
  const reply = f.outbox.prepareTriageReply(
    actor,
    commit.intakeId,
    commit.idempotencyKey,
    '感谢反馈',
  )
  const result = f.store.commitTriage(commit, { reply })
  assert.equal(result.outcome, 'applied')
  await f.outbox.tick()
  const replay = f.outbox.prepareTriageReply(
    actor,
    commit.intakeId,
    commit.idempotencyKey,
    '感谢反馈',
  )
  assert.deepEqual(f.store.commitTriage(commit, { reply: replay }), result)
  await f.outbox.tick()
  assert.deepEqual(
    f.requests.filter((r) => r.method === 'POST').map((r) => r.path),
    [`${repoPath}/issues/10/comments`],
  )
})

test('litch/progress 需要管理员确认，阻止门禁冲突，按历史状态核对同一提交', async (t) => {
  let gate = true
  let submitted: Record<string, unknown> | undefined
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname === `${repoPath}/pulls/14`)
      respond(res, {
        number: '14',
        user: { id: bot },
        state: 'open',
        base: { repo: { id: subject.repoId }, ref: 'main' },
        head: { repo: { id: subject.repoId }, sha },
      })
    else if (url.pathname === `${repoPath}/rules/branches/main`)
      respond(
        res,
        gate
          ? [
              {
                parameters: { required_status_checks: [{ context: 'litch/progress' }] },
              },
            ]
          : [],
      )
    else if (url.pathname === `${repoPath}/statuses/${sha}` && req.method === 'POST') {
      assert.equal(data.context, 'litch/progress')
      assert.equal(data.state, 'pending')
      submitted = { ...data, id: '19', creator: { id: bot } }
      res.destroy()
    } else if (url.pathname === `${repoPath}/commits/${sha}/statuses`) {
      respond(res, [{ ...submitted, id: '20', state: 'success' }, submitted])
    } else return false
    return true
  })
  const outbox = new ExternalGithubOutbox({
    store: f.store,
    secrets: f.secrets,
    stateDirectory: f.dir,
    send: f.send,
    now: f.now,
    statusGateConfirmed: () => true,
    assignmentForManager: () => ({ identityId: bot, repoIds: [subject.repoId] }),
  })
  f.store.bindRef({
    ...subject,
    kind: 'pull_request',
    number: '14',
    url: 'https://github.com/example/demo/pull/14',
    managerId: actor.managerId,
    issueId: f.request.issueId,
    origin: 'write_receipt',
    createdAt: f.now(),
  })
  assert.equal(
    f.store.config.saveSource(
      {
        ...f.source,
        writePolicy: { ...f.source.writePolicy, status: true },
      },
      1,
      'enable-status',
      'user',
    ).outcome,
    'applied',
  )
  const input = {
    ...f.request,
    target: { ...f.request.target, number: '14' },
    intent: { action: 'status' as const, state: 'pending' as const, headSha: sha },
    idempotencyKey: 'status',
  }
  assert.throws(() => f.outbox.enqueue(actor, input), /action_not_allowed/)
  const blocked = outbox.enqueue(actor, input)
  await outbox.tick()
  assert.equal(outbox.get(actor, blocked.operationId)?.errorClass, 'external_progress_used_as_gate')
  gate = false
  const queued = outbox.enqueue(actor, { ...input, idempotencyKey: 'status-again' })
  await outbox.tick()
  assert.equal(outbox.get(actor, queued.operationId)?.state, 'unknown')
  await outbox.tick()
  assert.equal(outbox.get(actor, queued.operationId)?.receipt?.objectId, '19')
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1)
})

test('代写使用经理分配的机器人而非来源采集机器人，发送前换身份会挡下', async (t) => {
  const writer = '90071992547415555'
  const f = await externalFixture(t, (req, res, url, data) => {
    if (url.pathname === '/user' && req.headers.authorization === `Bearer ${token('writer')}`) {
      respond(res, { id: writer, type: 'User', login: 'manager-writer' })
    } else if (url.pathname === commentsPath && req.method === 'POST') {
      respond(res, commentResponse(data.body, writer), 201)
    } else return false
    return true
  })
  const { identity } = await f.secrets.addIdentity({
    operationId: 'writer',
    token: token('writer'),
  })
  assert.equal(identity.identityId, writer)
  let current = writer
  const outbox = new ExternalGithubOutbox({
    store: f.store,
    secrets: f.secrets,
    stateDirectory: f.dir,
    send: f.send,
    now: f.now,
    assignmentForManager: () => ({
      identityId: current,
      repoIds: [subject.repoId],
      injectCredentials: false,
    }),
  })
  const input = { ...f.request, idempotencyKey: 'manager-writer', intent: comment }
  const first = outbox.enqueue(actor, input)
  await outbox.tick()
  assert.equal(outbox.get(actor, first.operationId)?.receipt?.botUserId, writer)
  assert.equal(
    f.requests.findLast((row) => row.method === 'POST')?.auth,
    `Bearer ${token('writer')}`,
  )
  const second = outbox.enqueue(actor, { ...input, idempotencyKey: 'changed-assignment' })
  current = bot
  await outbox.tick()
  assert.equal(outbox.get(actor, second.operationId)?.errorClass, 'external_write_identity_changed')
  assert.equal(outbox.enqueue(actor, input).receipt?.botUserId, writer)
  assert.equal(f.requests.filter((row) => row.method === 'POST').length, 1)
})
