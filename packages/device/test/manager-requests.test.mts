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
