import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import {
  MANAGER_ISSUE_METHOD as M,
  MANAGER_ISSUE_NOTIFICATION as N,
} from '../../protocol/src/manager-issues.mjs'
import { managerQuestionToolAllowed } from '../../protocol/src/manager-question.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { MANAGER_SCHEMA_VERSION } from '../src/manager-store.mjs'
import { rig } from './helpers.mjs'
import { refuseSteer, treeRig, until } from './tree-kit.mjs'

async function setup() {
  const env = treeRig()
  const client = env.connect()
  await client.initialize([
    'harness',
    'litchManager',
    'litchManagerIssues',
    'litchManagerIssueDiscussions',
  ])
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: 'Issue 经理',
    scope: '',
    rules: '',
    template: 'blank',
    firstTask: '',
    dispatch: MANAGER_DEFAULT_DISPATCH,
    contact: MANAGER_DEFAULT_CONTACT,
  })
  await until(() => env.pi.running(threadId), '经理启动')
  return { env, client, managerId: manager.id as string, threadId: threadId as string }
}

test('已读风暴合并为一次写入，重复确认不广播，读取无需等合并窗口', async () => {
  const { env, client, managerId } = await setup()
  try {
    const created = env.device.managers.issues.call(
      M.create,
      {
        managerId,
        title: '未读讨论',
        body: '',
      },
      'manager',
    ) as { issue: { id: string; revision: number } }
    const params = { managerId, id: created.issue.id, revision: created.issue.revision }
    const store = env.device.managers.store
    const original = store.markIssueSeen.bind(store)
    let writes = 0
    store.markIssueSeen = (...args) => {
      writes++
      return original(...args)
    }
    const pending = Array.from({ length: 1000 }, () =>
      env.device.managers.call(M.seen, params, true, true, true, true),
    )
    let finished = false
    void pending[0]!.then(() => {
      finished = true
    })
    const page = await client.call(M.list, { managerId, kinds: ['ordinary'] })
    assert.equal(page.page.entries[0].unread, true, '读取先于延迟的已读更新完成')
    const summary = await env.device.managers.call(
      'litch/manager/board/summary',
      { managerId },
      true,
      true,
      true,
      true,
    )
    assert.ok(summary && typeof summary === 'object' && 'summary' in summary)
    assert.equal(finished, false)
    const results = (await Promise.all(pending)) as { issue: { unread: boolean } }[]
    assert.ok(results.every((result) => !result.issue.unread))
    assert.equal(writes, 1)
    const reads = () =>
      client.notifications.filter(
        (frame) => frame.method === N.changed && (frame.params as any).change === 'read',
      ).length
    await until(() => reads() === 1, '首次已读通知投递')
    const before = reads()
    await client.call(M.seen, params)
    assert.equal(writes, 1, '已读时不再写库')
    assert.equal(reads(), before, '空操作不产生新一轮失效通知')
    env.device.managers.issues.call(M.comment, { ...params, body: '新回复' }, 'manager')
    assert.equal((await client.call(M.read, { managerId, id: params.id })).issue.unread, true)
    await client.call(M.seen, params)
    assert.equal(writes, 2, '新回复仍能正常标记已读')
  } finally {
    await env.close()
  }
})

test('服务关闭撤销待处理的已读，不能在库关闭后继续写入', async () => {
  const { env, managerId } = await setup()
  const issues = env.device.managers.issues
  const pending = issues.seen({ managerId, id: 'X-1', revision: 1 })
  const failed = assert.rejects(pending, /closed/)
  await env.close()
  await failed
  await assert.rejects(issues.seen({ managerId, id: 'X-1', revision: 1 }), /closed/)
})

test('X 编号独立；创建、评论、状态和跟进；报告未读不变；旧连接没有 issue 通知或字段', async () => {
  const { env, client, managerId, threadId } = await setup()
  try {
    const old = env.connect()
    await old.initialize(['harness', 'litchManager'])
    const denied = await old.fails(M.create, { managerId, title: '不应写入', body: '' })
    assert.equal(denied.data.litch, 'extensionRequired')
    const d = env.device.managers.writer.tool(managerId, 'add', {
      kind: 'decision',
      decision: { title: '决策', background: '' },
    }) as any
    assert.equal(d.id, 'D-1')
    const p = env.device.managers.posts.tool(managerId, 'report', {
      title: '报告',
      body: '正文',
      why: '报告',
    }).post
    const created = await client.call(M.create, {
      managerId,
      title: '跟进',
      body: '',
      idempotencyKey: 'create-1',
    })
    assert.equal(created.issue.id, 'X-1')
    assert.equal(created.issue.author.kind, 'user')
    assert.deepEqual(
      await client.call(M.create, {
        managerId,
        title: '跟进',
        body: '',
        idempotencyKey: 'create-1',
      }),
      created,
    )
    await env.device.managers.settleDeliveries(managerId)
    assert.ok(
      env.pi.seen.some((f) => f.method === 'turn/steer'),
      '正在运行时插话',
    )
    const comment = { managerId, id: 'X-1', revision: 1, body: '评论', idempotencyKey: 'comment-1' }
    const reply = await client.call(M.comment, comment)
    assert.equal(reply.issue.discussion.comments.length, 1)
    assert.equal(reply.issue.revision, 1, '评论不改变原帖 revision')
    assert.deepEqual(await client.call(M.comment, comment), reply)
    const edited = await client.call(M.comment, {
      managerId,
      id: 'X-1',
      revision: 1,
      body: '编辑后的评论',
      commentId: reply.issue.discussion.comments[0].id,
      commentRevision: 1,
    })
    assert.equal(edited.issue.discussion.comments[0].revision, 2)
    assert.equal(edited.issue.revision, 1)
    assert.equal(edited.issue.discussion.comments.length, 1)
    const forbiddenEdit = await env.device.managers.tool({
      harness: 'pi',
      threadId,
      turnId: 'turn',
      callId: 'edit-user',
      namespace: 'litch_manager',
      tool: 'issue_comment',
      arguments: {
        id: 'X-1',
        revision: 1,
        body: '不能改用户评论',
        why: '测试',
        commentId: reply.issue.discussion.comments[0].id,
        commentRevision: 2,
      },
    })
    assert.equal(forbiddenEdit.success, false)
    assert.equal(
      (await client.fails(M.comment, { ...comment, body: '同 key 不同正文' })).data.litch,
      'issueIdempotencyConflict',
    )
    let paused = (
      await client.call(M.follow, { managerId, id: 'X-1', revision: 1, state: 'off', why: '暂停' })
    ).issue
    await env.device.managers.settleDeliveries(managerId)
    const deliveries = env.device.managers.store.deliveries(managerId).length
    paused = (
      await client.call(M.comment, {
        ...comment,
        revision: paused.revision,
        body: '暂停期间',
        idempotencyKey: 'comment-2',
      })
    ).issue
    assert.equal(paused.discussion.comments.length, 2)
    assert.equal(env.device.managers.store.deliveries(managerId).length, deliveries)
    const changed = (
      await client.call(M.update, {
        managerId,
        id: paused.id,
        revision: paused.revision,
        patch: { status: 'blocked', title: '受阻' },
        why: '等条件',
      })
    ).issue
    assert.equal(changed.status, 'blocked')
    assert.equal(changed.followUp.state, 'off')
    assert.equal(
      (
        await client.fails(M.update, {
          managerId,
          id: changed.id,
          revision: 1,
          patch: { status: 'resolved' },
          why: '旧草稿',
        })
      ).data.litch,
      'issueConflict',
    )
    const special = (await client.call(M.read, { managerId, id: 'D-1' })).issue
    assert.equal(special.id, 'D-1')
    const specialFollow = (
      await client.call(M.follow, {
        managerId,
        id: special.id,
        revision: special.revision,
        state: 'off',
      })
    ).issue
    assert.equal(specialFollow.quick.revision, 1)
    assert.equal(specialFollow.revision, 2)
    await client.call(M.comment, {
      managerId,
      id: special.id,
      revision: specialFollow.revision,
      body: '讨论不是答案',
    })
    assert.equal(env.device.managers.store.object(managerId, 'D-1')?.status, 'open')
    await client.call(M.comment, {
      managerId,
      id: p.id,
      revision: p.revision,
      body: '讨论不是已阅',
    })
    assert.equal(env.device.managers.posts.get(managerId, p.id).unread, true)
    const list = await client.call(M.list, { managerId, order: 'newest' })
    assert.deepEqual(
      list.page.entries.map((i: any) => i.id),
      ['X-1'],
    )
    assert.equal(list.page.entries[0].status, 'blocked')
    const board = (await old.call(MANAGER_METHOD.boardRead, { managerId })).board
    assert.equal('issues' in board, false)
    assert.equal(JSON.stringify(board).includes('X-1'), false)
    assert.equal(
      old.notifications.some((n) => Object.values(N).includes(n.method as any)),
      false,
    )
    assert.equal(managerQuestionToolAllowed('litch_manager', 'issue_comment'), false)
    assert.equal(managerQuestionToolAllowed('litch_manager', 'issue_get'), true)
    const unowned = await env.device.managers.tool({
      harness: 'pi',
      threadId: 'other',
      turnId: '',
      callId: 'fake',
      namespace: 'litch_manager',
      tool: 'issue_comment',
      arguments: comment,
    })
    assert.equal(unowned.success, false)
    assert.equal(env.pi.running(threadId), true)
  } finally {
    await env.close()
  }
})

test('经理评论持久未读，重连读取与 seen；用户评论唤醒闲置经理但不唤醒已结束经理', async () => {
  const { env, client, managerId, threadId } = await setup()
  try {
    let issue = (
      await client.call(M.create, { managerId, title: '讨论', body: '', followUp: 'off' })
    ).issue
    const tool = await env.device.managers.tool({
      harness: 'pi',
      threadId,
      turnId: env.pi.current(threadId)!.id as string,
      callId: 'm-comment',
      namespace: 'litch_manager',
      tool: 'issue_comment',
      arguments: {
        id: issue.id,
        revision: issue.revision,
        body: '经理回复',
        why: '回复用户',
        idempotencyKey: 'manager-1',
      },
    })
    assert.equal(tool.success, true)
    issue = JSON.parse((tool.contentItems[0] as any).text).issue
    assert.equal(issue.unread, true)
    await until(() => client.notifications.some((n) => n.method === N.activity), '经理评论通知')
    const reconnect = env.connect()
    await reconnect.initialize(['harness', 'litchManagerIssues', 'litchManagerIssueDiscussions'])
    assert.equal((await reconnect.call(M.read, { managerId, id: issue.id })).issue.unread, true)
    assert.equal(
      (await reconnect.call(M.seen, { managerId, id: issue.id, revision: issue.revision })).issue
        .unread,
      false,
    )
    env.pi.end(threadId, 'completed', '完成')
    await until(() => !env.device.sessionTree.isActive(threadId), '经理闲置')
    issue = (
      await reconnect.call(M.follow, {
        managerId,
        id: issue.id,
        revision: issue.revision,
        state: 'on',
      })
    ).issue
    assert.equal(env.pi.running(threadId), false, '恢复不回放暂停评论')
    await reconnect.call(M.comment, {
      managerId,
      id: issue.id,
      revision: issue.revision,
      body: '请继续',
    })
    await until(() => env.pi.running(threadId), '用户新评论唤醒')
    const current = env.pi.current(threadId)!.items[0] as any
    assert.equal(parseSessionEvent(current.content[0].text).event?.kind, 'manager-issue')
    await env.device.managers.settleDeliveries(managerId)
    env.pi.end(threadId, 'completed', '完成')
    await until(() => !env.device.sessionTree.isActive(threadId), '再次闲置')
    const record = env.device.managers.store.manager(managerId)!
    env.device.managers.store.saveManager({ ...record, status: 'ended', endedAt: 100 })
    await reconnect.call(M.comment, {
      managerId,
      id: issue.id,
      revision: issue.revision,
      body: '结束后留言',
    })
    await env.device.managers.settleDeliveries(managerId)
    assert.equal(env.pi.running(threadId), false)
    assert.equal(env.device.managers.store.deliveries(managerId).length, 1)
  } finally {
    await env.close()
  }
})

test('经理创建 issue 使用工具调用幂等键，X 关系可读，失败事务回滚评论与通知', async () => {
  const { env, client, managerId, threadId } = await setup()
  try {
    env.device.managers.writer.tool(managerId, 'add', { kind: 'item', item: { title: '内部事项' } })
    const call = {
      harness: 'pi',
      threadId,
      turnId: 'turn',
      callId: 'create-idem',
      namespace: 'litch_manager',
      tool: 'issue_create',
      arguments: { title: '经理议题', body: '', related: [{ kind: 'item', target: 'I-1' }] },
    }
    const first = await env.device.managers.tool(call)
    assert.equal(first.success, true)
    assert.deepEqual(await env.device.managers.tool(call), first)
    const issue = JSON.parse((first.contentItems[0] as any).text).issue
    assert.equal(issue.id, 'X-1')
    assert.equal(issue.author.kind, 'manager')
    assert.equal(issue.unread, true)
    assert.equal(issue.relations[0].to.target, 'I-1')
    const linked = (
      await client.call(M.create, {
        managerId,
        title: '用户关联',
        body: '',
        related: [{ kind: 'issue', target: 'X-1' }],
        followUp: 'off',
      })
    ).issue
    assert.equal(linked.relations[0].by, 'user')
    assert.equal(linked.relations[0].to.target, 'X-1')
    const original = env.device.managers.store.enqueue
    env.device.managers.store.enqueue = () => {
      throw new Error('模拟投递写入失败')
    }
    try {
      await client.fails(M.comment, {
        managerId,
        id: 'X-1',
        revision: 1,
        body: '必须回滚',
        idempotencyKey: 'atomic',
      })
      assert.equal(env.device.managers.issues.get(managerId, 'X-1').discussion.comments.length, 0)
    } finally {
      env.device.managers.store.enqueue = original
    }
    const retry = await client.call(M.comment, {
      managerId,
      id: 'X-1',
      revision: 1,
      body: '必须回滚',
      idempotencyKey: 'atomic',
    })
    assert.equal(retry.issue.discussion.comments.length, 1)
  } finally {
    await env.close()
  }
})

test('设备重启后评论与幂等回执保留，未投递事件恢复且只交一次', async () => {
  const { env, client, managerId, threadId } = await setup()
  let second: ReturnType<typeof rig> | undefined
  try {
    refuseSteer(env.pi)
    const created = (
      await client.call(M.create, { managerId, title: '跨重启', body: '', followUp: 'off' })
    ).issue
    const followed = (
      await client.call(M.follow, {
        managerId,
        id: created.id,
        revision: created.revision,
        state: 'on',
      })
    ).issue
    const input = {
      managerId,
      id: created.id,
      revision: followed.revision,
      body: '持久评论',
      idempotencyKey: 'restart-comment',
    }
    const result = await client.call(M.comment, input)
    await env.device.managers.settleDeliveries(managerId)
    const pendingId = env.device.managers.store.deliveries(managerId)[0]?.id
    assert.ok(pendingId)
    await env.device.close()
    env.pi.end(threadId, 'completed', '完成')
    second = rig({ pi: env.pi }, {}, { stateDir: env.stateDir })
    const after = second.connect()
    await after.initialize(['harness', 'litchManagerIssues', 'litchManagerIssueDiscussions'])
    assert.deepEqual(await after.call(M.comment, input), result)
    assert.equal(
      (await after.call(M.read, { managerId, id: created.id })).issue.discussion.comments.length,
      1,
    )
    await until(
      () => second!.device.managers.store.deliveries(managerId).length === 0,
      '重启后出队',
      5000,
    )
    assert.equal(env.pi.running(threadId), true)
    const delivered = env.pi.seen.filter(
      (f) => f.method === 'turn/start' && JSON.stringify(f.params).includes('持久评论'),
    )
    assert.equal(delivered.length, 1)
  } finally {
    if (second) await second.close()
    else await env.close()
  }
})

test('v6 连续升级保留 D/R/P/S/I、问答、关联、报告已阅；不建立别名表', async () => {
  const { env, managerId, threadId } = await setup()
  let second: ReturnType<typeof rig> | undefined
  try {
    const { store, writer, posts } = env.device.managers
    writer.tool(managerId, 'add', {
      kind: 'decision',
      decision: { title: 'D', background: '依据' },
    })
    writer.tool(managerId, 'add', { kind: 'item', item: { title: 'I' } })
    writer.tool(managerId, 'add', {
      kind: 'request',
      request: { title: 'R', description: '操作' },
      revision: 0,
      why: '请你做',
    })
    const report = posts.tool(managerId, 'report', {
      title: 'P',
      body: '结论',
      why: '汇报',
      related: [{ kind: 'issue', target: 'D-1' }],
    }).post
    posts.read(managerId, report.id, report.revision)
    const proposal = env.device.sessionTree.propose({
      threadId,
      title: 'S',
      background: '后续',
      prompt: '任务',
      kind: 'fresh',
      harness: 'pi',
      model: null,
      cwd: env.stateDir,
      wakeParent: false,
    })
    store.saveQuestion({
      managerId,
      decisionId: 'D-1',
      discussion: {
        messages: [
          {
            id: 'question-1',
            question: '旧追问',
            answer: '旧回答',
            at: 2,
            answeredAt: 3,
            status: 'completed',
            refreshed: false,
            mode: 'manager',
          },
        ],
        summary: '摘要',
        light: false,
        forwarded: 1,
      },
      threadId: null,
      threads: ['retired-question'],
      source: 'source',
      revision: 1,
    })
    store.saveSuggestionReview(managerId, proposal.id, { state: 'endorsed', at: 2, reason: '保留' })
    const before = {
      objects: store.objects(managerId),
      questions: store.questions(managerId),
      reports: store.publishedReports(managerId),
      relations: store.relations(managerId),
      changes: store.changes(managerId),
    }
    await env.device.close()
    const db = new DatabaseSync(join(env.stateDir, 'manager.sqlite'))
    db.exec(
      'DROP TABLE manager_resets; DROP TABLE manager_history; DROP TABLE issues; DROP TABLE issue_comments; DROP TABLE issue_notifications; DROP TABLE issue_idempotency; DROP TABLE issue_meta; DROP TABLE issue_history; PRAGMA user_version=6',
    )
    db.close()
    second = rig({ pi: env.pi }, {}, { stateDir: env.stateDir })
    const after = second.device.managers.store
    assert.equal(
      after.db.prepare('PRAGMA user_version').get()?.user_version,
      MANAGER_SCHEMA_VERSION,
    )
    assert.deepEqual(after.objects(managerId), before.objects)
    assert.deepEqual(after.questions(managerId), before.questions)
    assert.deepEqual(after.publishedReports(managerId), before.reports)
    assert.deepEqual(after.relations(managerId), before.relations)
    assert.deepEqual(after.changes(managerId), before.changes)
    assert.equal(after.suggestionReview(managerId, proposal.id)?.state, 'endorsed')
    assert.equal(
      after.db.prepare("SELECT name FROM sqlite_master WHERE name='issue_aliases'").get(),
      undefined,
    )
    const api = second.connect()
    await api.initialize(['harness', 'litchManagerIssues', 'litchManagerIssueDiscussions'])
    const page = (
      await api.call(M.list, {
        managerId,
        kinds: ['ordinary', 'decision', 'request', 'report', 'suggestion'],
        order: 'oldest',
      })
    ).page
    assert.deepEqual(
      new Set(page.entries.map((i: any) => i.id)),
      new Set(['D-1', 'R-1', 'P-1', `S-${proposal.id}`]),
    )
    assert.equal((await api.call(M.read, { managerId, id: 'P-1' })).issue.unread, false)
    assert.equal(
      (await api.call(M.read, { managerId, id: 'D-1' })).issue.discussion.questions[0].answer,
      '旧回答',
    )
    assert.equal(
      (await api.call(M.create, { managerId, title: '新增', body: '', followUp: 'off' })).issue.id,
      'X-1',
    )
  } finally {
    if (second) await second.close()
    else await env.close()
  }
})

test('issue 讨论过滤在计数和分页前生效；开启标记持久化且不改变快速动作', async () => {
  const { env, client, managerId } = await setup()
  try {
    const decisions = Array.from(
      { length: 3 },
      (_, i) =>
        env.device.managers.writer.tool(managerId, 'add', {
          kind: 'decision',
          decision: { title: `决策 ${i}`, background: '' },
        }) as any,
    )
    const report = env.device.managers.posts.tool(managerId, 'report', {
      title: '报告',
      body: '报告正文',
      why: '测试',
    }).post
    await client.call(M.create, { managerId, title: '议题', body: '' })
    const query = {
      managerId,
      kinds: ['ordinary', 'decision', 'report'],
      discussionsOnly: true,
      order: 'oldest',
      limit: 1,
    }
    assert.equal((await client.call(M.list, query)).page.total, 1)
    const before = (await client.call(M.read, { managerId, id: decisions[0].id })).issue
    const opened = (
      await client.call(M.update, {
        managerId,
        id: before.id,
        revision: before.revision,
        patch: { discussionOpened: true },
        why: '打开讨论',
      })
    ).issue
    assert.equal(opened.discussion.opened, true)
    assert.deepEqual(opened.quick, before.quick)
    assert.equal(opened.status, before.status)
    assert.equal(
      (env.device.managers.store.issueMeta(managerId, before.id) as any).discussionOpened,
      true,
    )
    await client.call(M.comment, { managerId, id: decisions[1].id, revision: 1, body: '已有评论' })
    await client.call(M.update, {
      managerId,
      id: report.id,
      revision: report.revision,
      patch: { discussionOpened: true },
      why: '打开讨论',
    })
    assert.equal((await client.call(M.read, { managerId, id: report.id })).issue.status, 'unread')
    const page = (await client.call(M.list, query)).page
    assert.equal(page.total, 4)
    const ids = [page.entries[0].id]
    let cursor = page.nextCursor
    while (cursor) {
      const next = (await client.call(M.list, { ...query, cursor })).page
      ids.push(...next.entries.map((i: any) => i.id))
      cursor = next.nextCursor
    }
    assert.deepEqual(new Set(ids), new Set(['X-1', decisions[0].id, decisions[1].id, report.id]))
    assert.equal((await client.call(M.list, { ...query, discussionsOnly: false })).page.total, 5)
    const denied = await client.fails(M.update, {
      managerId,
      id: opened.id,
      revision: opened.revision,
      patch: { discussionOpened: true, title: '不能绕过快速动作' },
      why: '测试',
    })
    assert.equal(denied.data.litch, 'issueTypeMismatch')
    assert.equal(
      (await client.call(M.read, { managerId, id: opened.id })).issue.title,
      before.title,
    )
  } finally {
    await env.close()
  }
})

test('新设备对未声明讨论子能力的连接不回传标记，并拒绝新字段', async () => {
  const { env, client, managerId } = await setup()
  try {
    const old = env.connect()
    await old.initialize(['harness', 'litchManagerIssues'])
    const created = (await client.call(M.create, { managerId, title: '协商测试', body: '' })).issue
    await client.call(M.update, {
      managerId,
      id: created.id,
      revision: created.revision,
      patch: { discussionOpened: true },
      why: '打开讨论',
    })
    const newReply = (await client.call(M.read, { managerId, id: created.id })).issue
    const oldReply = (await old.call(M.read, { managerId, id: created.id })).issue
    assert.equal(newReply.discussion.opened, true)
    assert.equal('opened' in oldReply.discussion, false)
    assert.equal((await old.call(M.list, { managerId, order: 'newest' })).page.total, 1)
    assert.equal(
      (await old.fails(M.list, { managerId, order: 'newest', discussionsOnly: true })).data.litch,
      'extensionRequired',
    )
    assert.equal(
      (
        await old.fails(M.update, {
          managerId,
          id: created.id,
          revision: newReply.revision,
          patch: { discussionOpened: true },
          why: '未声明',
        })
      ).data.litch,
      'extensionRequired',
    )
  } finally {
    await env.close()
  }
})

test('报告默认跟进：用户评论插话或唤醒一次，显式暂停及经理评论不唤醒', async () => {
  const { env, client, managerId, threadId } = await setup()
  try {
    const { posts, issues, store } = env.device.managers
    const post = posts.tool(managerId, 'report', {
      title: '星云验收报告',
      body: '隔离报告正文',
      why: '记录验收',
    }).post
    const read = () => issues.get(managerId, post.id)
    const deliveries = () =>
      env.pi.seen.filter(
        (frame) =>
          ['turn/start', 'turn/steer'].includes(frame.method) &&
          JSON.stringify(frame.params).includes('星云报告评论'),
      )
    assert.equal(read().followUp.state, 'on')
    const currentTurn = env.pi.current(threadId)!.id
    const comment = {
      managerId,
      id: post.id,
      revision: read().revision,
      body: '星云报告评论：请核对验收',
      idempotencyKey: 'nebula-report-running',
    }
    await client.call(M.comment, comment)
    await env.device.managers.settleDeliveries(managerId)
    assert.equal(deliveries().length, 1)
    assert.equal(deliveries()[0]!.method, 'turn/steer')
    assert.equal(env.pi.current(threadId)!.id, currentTurn)
    await client.call(M.comment, comment)
    await env.device.managers.settleDeliveries(managerId)
    assert.equal(deliveries().length, 1, '幂等重试不重复插话')
    posts.read(managerId, post.id, post.revision)
    assert.equal(read().followUp.state, 'on', '已阅报告仍默认跟进')

    env.pi.end(threadId, 'completed', '完成')
    await until(() => !env.device.sessionTree.isActive(threadId), '报告评论前经理空闲')
    await client.call(M.comment, {
      ...comment,
      body: '星云报告评论：空闲时继续核对',
      idempotencyKey: 'nebula-report-idle',
    })
    await until(() => env.pi.running(threadId), '报告评论唤醒经理')
    await env.device.managers.settleDeliveries(managerId)
    assert.equal(deliveries().length, 2)
    assert.equal(deliveries()[1]!.method, 'turn/start')
    assert.equal(store.deliveries(managerId).length, 0)
    assert.equal(read().unread, false, '用户评论保留报告已阅状态')

    const paused = (
      await client.call(M.follow, {
        managerId,
        id: post.id,
        revision: read().revision,
        state: 'off',
      })
    ).issue
    await env.device.managers.settleDeliveries(managerId)
    env.pi.end(threadId, 'completed', '完成')
    await until(() => !env.device.sessionTree.isActive(threadId), '暂停后经理空闲')
    const calls = env.pi.seen.length
    const saved = (
      await client.call(M.comment, {
        ...comment,
        revision: paused.revision,
        body: '星云报告评论：暂停期间仅保存',
        idempotencyKey: 'nebula-report-paused',
      })
    ).issue
    await env.device.managers.settleDeliveries(managerId)
    assert.equal(saved.discussion.comments.length, 3)
    assert.equal(env.pi.seen.length, calls)
    assert.equal(env.pi.running(threadId), false)
    assert.equal(store.deliveries(managerId).length, 0)
    const resumed = (
      await client.call(M.follow, {
        managerId,
        id: post.id,
        revision: saved.revision,
        state: 'on',
      })
    ).issue
    issues.call(
      M.comment,
      {
        managerId,
        id: post.id,
        revision: resumed.revision,
        body: '经理记录核对结果',
        why: '记录',
      },
      'manager',
    )
    await env.device.managers.settleDeliveries(managerId)
    assert.equal(env.pi.running(threadId), false, '经理评论不唤醒自己')
    assert.equal(env.pi.seen.length, calls, '恢复跟进不回放历史评论')
  } finally {
    await env.close()
  }
})

test('报告缺省开启且不持久化推导暂停；其他类型保持状态推导与显式开关', async () => {
  const { env, client, managerId, threadId } = await setup()
  let second: ReturnType<typeof rig> | undefined
  try {
    const { store, writer, posts, issues } = env.device.managers
    writer.tool(managerId, 'add', {
      kind: 'decision',
      decision: { title: '星云决策', background: '' },
    })
    writer.tool(managerId, 'add', {
      kind: 'request',
      request: { title: '星云请求', description: '' },
      revision: 0,
      why: '请求',
    })
    const report = posts.tool(managerId, 'report', {
      title: '星云报告',
      body: '报告正文',
      why: '汇报',
    }).post
    const proposal = env.device.sessionTree.propose({
      threadId,
      title: '星云建议',
      background: '后续任务',
      prompt: '核对验收',
      kind: 'fresh',
      harness: 'pi',
      model: null,
      cwd: env.stateDir,
      wakeParent: false,
    })
    const ordinary = (
      await client.call(M.create, {
        managerId,
        title: '星云普通议题',
        body: '',
        followUp: 'off',
      })
    ).issue
    const suggestionId = `S-${proposal.id}`
    for (const status of ['open', 'answered', 'ignored', 'expired', 'withdrawn'] as const) {
      const decision = store.object(managerId, 'D-1')!
      store.saveObject(managerId, { ...decision, status } as typeof decision)
      assert.equal(
        issues.get(managerId, 'D-1').followUp.state,
        status === 'open' ? 'on' : 'off',
        status,
      )
      if (status !== 'open') {
        await env.device.managers.settleDeliveries(managerId)
        const sent = env.pi.seen.length
        await client.call(M.comment, {
          managerId,
          id: 'D-1',
          revision: issues.get(managerId, 'D-1').revision,
          body: `已处理决策的评论 ${status}`,
        })
        await env.device.managers.settleDeliveries(managerId)
        assert.equal(env.pi.seen.length, sent, '已处理决策评论不插话或唤醒')
      }
    }
    for (const id of ['R-1', report.id, suggestionId]) {
      assert.equal(issues.get(managerId, id).followUp.state, 'on', id)
      assert.equal(store.issueMeta(managerId, id), null)
    }
    posts.read(managerId, report.id, report.revision)
    assert.equal(issues.get(managerId, report.id).followUp.state, 'on', '已阅报告仍跟进')
    // 老版本评论/打开讨论只保存这两个字段，不会把 special() 的推导状态写入 meta。
    store.saveIssueMeta(managerId, report.id, {
      revision: 1,
      updatedAt: report.updatedAt,
      discussionOpened: true,
    })
    const pausedReport = posts.tool(managerId, 'report', {
      title: '显式暂停报告',
      body: '报告正文',
      why: '汇报',
    }).post
    const page = (followUp: 'on' | 'off') =>
      issues.list(managerId, {
        managerId,
        kinds: ['ordinary', 'decision', 'suggestion', 'request', 'report'],
        followUp,
        order: 'newest',
      })
    assert.equal(page('on').total, 4)
    assert.deepEqual(
      page('off')
        .entries.map((one) => one.id)
        .sort(),
      ['D-1', ordinary.id].sort(),
    )
    const paused = (
      await client.call(M.follow, {
        managerId,
        id: pausedReport.id,
        revision: issues.get(managerId, pausedReport.id).revision,
        state: 'off',
      })
    ).issue
    assert.equal(page('on').total, 3)
    assert.equal(page('off').total, 3)
    assert.equal(issues.get(managerId, pausedReport.id).followUp.changedBy, 'user')
    await env.device.close()
    second = rig({ pi: env.pi }, {}, { stateDir: env.stateDir })
    assert.equal(second.device.managers.issues.get(managerId, report.id).followUp.state, 'on')
    assert.equal(
      second.device.managers.issues.get(managerId, pausedReport.id).followUp.state,
      'off',
    )
    assert.equal(
      second.device.managers.issues.get(managerId, pausedReport.id).revision,
      paused.revision,
    )
    assert.equal(second.device.managers.issues.get(managerId, ordinary.id).followUp.state, 'off')
    // 由经理显式暂停同样保持关闭，不与默认状态混淆。
    second.device.managers.issues.call(
      M.follow,
      {
        managerId,
        id: report.id,
        revision: second.device.managers.issues.get(managerId, report.id).revision,
        state: 'off',
        why: '暂不跟进',
      },
      'manager',
    )
    assert.equal(
      second.device.managers.issues.get(managerId, report.id).followUp.changedBy,
      'manager',
    )
    assert.equal(second.device.managers.issues.get(managerId, report.id).followUp.state, 'off')
  } finally {
    if (second) await second.close()
    else await env.close()
  }
})
