import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { treeRig, until } from './tree-kit.mjs'

test('请你做：版本校验、混合提交、文字回复与修改交付、取消、审计及回滚', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      name: '请求测试',
      scope: '',
      rules: '',
      template: 'blank',
      firstTask: '',
      dispatch: MANAGER_DEFAULT_DISPATCH,
      contact: MANAGER_DEFAULT_CONTACT,
    })
    await until(() => env.pi.running(threadId), '经理开始')
    const writer = env.device.managers.writer
    const call = (tool: string, args: unknown): any => writer.tool(manager.id, tool, args)
    assert.throws(
      () => call('add', { kind: 'request', request: { title: '检查', description: '真机验证' } }),
      /revision/,
    )
    const added = call('add', {
      kind: 'request',
      request: { title: '检查', description: '**真机**验证' },
      revision: 0,
      why: '需要真机',
    })
    assert.equal(added.id, 'R-1')
    assert.equal(env.device.managers.manager(manager.id).pendingRequests, 1)
    assert.equal(added.object.buttonLabel, null)
    const updated = call('update', {
      kind: 'request',
      id: added.id,
      revision: 1,
      patch: { buttonLabel: '已复验' },
      why: '明确交付',
    })
    assert.equal(updated.object.revision, 2)
    assert.throws(
      () =>
        call('update', {
          kind: 'request',
          id: added.id,
          revision: 1,
          patch: { title: '旧版' },
          why: '旧版本',
        }),
      /current revision/,
    )
    assert.throws(() =>
      call('update', {
        kind: 'request',
        id: added.id,
        revision: 2,
        patch: { status: 'delivered' },
        why: '冒充用户',
      }),
    )
    call('add', { kind: 'decision', decision: { title: '选择', background: '' } })
    const feedback = (requests: unknown[], answers: unknown[] = [], questions: unknown[] = []) =>
      client.call(MANAGER_METHOD.feedbackSubmit, {
        managerId: manager.id,
        requests,
        answers,
        questions,
      })
    const result = await feedback(
      [{ requestId: 'R-1', revision: 2, delivered: false, text: '设备不在身边' }],
      [{ decisionId: 'D-1', revision: 1, optionId: null, text: '同意' }],
      [{ decisionId: 'D-1', revision: 1, question: '还有哪些影响？' }],
    )
    assert.equal(result.acceptedRequests[0].status, 'replied')
    assert.equal(env.device.managers.manager(manager.id).pendingRequests, 0)
    assert.equal(result.acceptedRequests[0].response.delivered, false)
    assert.equal(result.acceptedQuestions.length, 1)
    assert.equal(result.accepted.length, 1)
    const activities = env.device.managers.board(manager.id).activities
    assert.equal(
      activities.find((activity) => activity.text === '需要真机')?.source?.kind,
      'manager',
    )
    assert.equal(
      activities.find((activity) => activity.text === 'User replied to the request')?.source?.kind,
      'user',
    )
    assert.equal(
      activities.find((activity) => activity.text === 'User submitted a question to the manager')
        ?.source?.kind,
      'user',
    )
    const events = [
      ...env.device.managers.store.deliveries(manager.id).map((entry) => entry.text),
      ...env.pi.seen
        .filter((entry) => ['turn/start', 'turn/steer'].includes(entry.method))
        .map((entry) => entry.params.input?.[0]?.text ?? ''),
    ].map((entry) => parseSessionEvent(entry).event)
    assert.ok(
      events.some(
        (event) =>
          event?.manager?.requests?.[0]?.text === '设备不在身边' &&
          event.manager.questions?.length === 1 &&
          event.manager.answers?.length === 1,
      ),
    )
    assert.equal(
      (await feedback([{ requestId: 'R-1', revision: 2, delivered: true, text: '' }]))
        .rejectedRequests[0].code,
      'requestConflict',
    )
    assert.equal(
      (await feedback([{ requestId: 'R-1', revision: 3, delivered: true, text: '现在已完成' }]))
        .acceptedRequests[0].status,
      'delivered',
    )
    call('close', {
      kind: 'request',
      id: 'R-1',
      revision: 4,
      status: 'cancelled',
      reason: '已收尾',
    })
    assert.equal(
      (await feedback([{ requestId: 'R-1', revision: 5, delivered: true, text: '' }]))
        .rejectedRequests[0].code,
      'requestCancelled',
    )
    const get = call('get', { id: 'R-1' })
    assert.equal(get.object.response.text, '现在已完成')
    assert.equal(get.object.cancelled.reason, '已收尾')
    assert.equal(get.changes.length, 5)
    const revision = call('get', { id: 'D-1' }).object.revision
    await assert.rejects(
      feedback(
        [{ requestId: 'invalid', revision: 1, delivered: true, text: '' }],
        [],
        [{ decisionId: 'D-1', revision, question: '应回滚' }],
      ),
    )
    assert.equal(call('get', { id: 'D-1' }).object.revision, revision)
    assert.equal(call('get', { id: 'D-1' }).object.discussion.messages.length, 1)
  } finally {
    await env.close()
  }
})

test('忽略请求：理由选填、事件明确、分页计数独立，不能同时声明交付或替代经理取消', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager', 'litchManagerPaging'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
      cwd: env.stateDir,
      harness: 'pi',
      model: null,
      effort: null,
      name: '忽略请求',
      scope: '',
      rules: '',
      template: 'blank',
      firstTask: '',
      dispatch: MANAGER_DEFAULT_DISPATCH,
      contact: MANAGER_DEFAULT_CONTACT,
    })
    await until(() => env.pi.running(threadId), '经理开始')
    const owner = env.device.managers
    const tool = (name: string, args: any): any => owner.writer.tool(manager.id, name, args)
    for (let i = 1; i <= 5; i++)
      tool('add', {
        kind: 'request',
        revision: 0,
        why: '用户操作',
        request: { title: `请求${i}`, description: '检查设备' },
      })
    tool('close', {
      kind: 'request',
      id: 'R-4',
      revision: 1,
      status: 'cancelled',
      reason: '经理取消',
    })
    const feedback = (requests: unknown[]) =>
      client.call(MANAGER_METHOD.feedbackSubmit, {
        managerId: manager.id,
        answers: [],
        questions: [],
        requests,
      })
    assert.equal(
      (
        await feedback([
          { requestId: 'R-1', revision: 1, delivered: true, ignored: true, text: '' },
        ])
      ).rejectedRequests[0].code,
      'invalidRequest',
    )
    assert.equal(
      (
        await feedback([
          { requestId: 'R-1', revision: 1, delivered: false, ignored: 'yes', text: '' },
        ])
      ).rejectedRequests[0].code,
      'invalidRequest',
    )
    const result = await feedback([
      { requestId: 'R-1', revision: 1, delivered: false, ignored: true, text: '' },
      { requestId: 'R-2', revision: 1, delivered: false, ignored: true, text: '这事不用管了' },
      { requestId: 'R-3', revision: 1, delivered: true, text: '' },
      { requestId: 'R-4', revision: 2, delivered: false, ignored: true, text: '' },
      { requestId: 'R-5', revision: 1, delivered: false, text: '暂时无法操作' },
    ])
    assert.equal(result.acceptedRequests.length, 4)
    assert.equal(result.rejectedRequests[0].code, 'requestCancelled')
    assert.equal(result.acceptedRequests[0].status, 'replied', '不改变已有 status 枚举')
    assert.equal(result.acceptedRequests[0].response.ignored, true)
    assert.equal(result.acceptedRequests[0].response.text, '')
    assert.equal(result.acceptedRequests[1].response.text, '这事不用管了')
    assert.equal(owner.manager(manager.id).pendingRequests, 0)
    const counts = owner.paging.summary(manager.id).counts.request
    assert.deepEqual(
      {
        ignored: counts.ignored,
        delivered: counts.delivered,
        cancelled: counts.cancelled,
        replied: counts.replied,
        pending: counts.pending,
        all: counts.all,
      },
      { ignored: 2, delivered: 1, cancelled: 1, replied: 1, pending: 0, all: 5 },
    )
    const query = owner.paging.queries.page(
      { managerId: manager.id, kind: 'request', status: 'ignored', order: 'newest' },
      [],
    )
    assert.deepEqual(query.entries.map((entry) => entry.id).sort(), ['R-1', 'R-2'])
    assert.ok(query.entries.every((entry) => entry.status === 'ignored' && !entry.pending))
    const events = [
      ...owner.store.deliveries(manager.id).map((entry) => entry.text),
      ...env.pi.seen
        .filter((entry) => ['turn/start', 'turn/steer'].includes(entry.method))
        .map((entry) => entry.params.input?.[0]?.text ?? ''),
    ]
    const event = events
      .map((text) => parseSessionEvent(text).event)
      .find(
        (event) =>
          event?.kind === 'manager-answers' && event.manager?.requests?.some((r) => r.ignored),
      )
    assert.equal(event?.manager?.requests?.filter((r) => r.ignored).length, 2)
    assert.ok(events.some((text) => text.includes('ignored=true (the user chose not to do this)')))
    assert.equal(
      tool('get', { id: 'R-2' }).changes.find((change: any) => change.after?.response?.ignored).by,
      'user',
    )
    assert.equal(
      (
        await feedback([
          { requestId: 'R-1', revision: 1, delivered: false, ignored: true, text: '' },
        ])
      ).rejectedRequests[0].code,
      'requestConflict',
    )
    const changed = await feedback([
      { requestId: 'R-1', revision: 2, delivered: true, text: '后来完成了' },
    ])
    assert.equal(changed.acceptedRequests[0].response.ignored, undefined)
    assert.equal(owner.paging.summary(manager.id).counts.request.ignored, 1)
  } finally {
    await env.close()
  }
})
