import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
  type ManagerCreateParams,
} from '../../protocol/src/manager.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { treeRig, until } from './tree-kit.mjs'

function settings(cwd: string): ManagerCreateParams {
  return {
    cwd,
    harness: 'pi',
    model: null,
    effort: null,
    name: '经理',
    scope: '测试',
    template: 'blank',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: 'Keep the repository authoritative.',
    firstTask: '',
  }
}
const value = (response: any) => {
  assert.equal(response.success, true, JSON.stringify(response))
  return JSON.parse(response.contentItems[0].text)
}
/** 回合里交给模型的各条事件的种类和忽略的决策 */
const events = (items: { content?: unknown }[] | undefined) =>
  (items ?? []).flatMap((item) => {
    const event = parseSessionEvent((item.content as any)?.[0]?.text ?? '').event
    return event
      ? [
          `${event.kind}${(event.manager?.ignored ?? []).map((one) => `:${one.decisionId}`).join('')}`,
        ]
      : []
  })

test('用户忽略决策：不计待处理、不唤醒，随下一回合告诉经理；经理带理由才能重开，不能直接答复', async () => {
  const env = treeRig()
  try {
    const client = env.connect()
    await client.initialize(['harness', 'litchManager'])
    const { manager, threadId } = await client.call(MANAGER_METHOD.create, settings(env.stateDir))
    await until(() => env.pi.running(threadId), '经理开场')
    const tool = async (name: string, args: unknown) => {
      const result = await env.pi.callTool(threadId, 'litch_manager', name, args)
      assert.ok(result)
      return result.answer.result
    }
    for (const title of ['甲？', '乙？', '丙？'])
      value(await tool('add', { kind: 'decision', decision: { title, background: '' } }))
    env.pi.end(threadId, 'completed', '开场完')
    await until(() => !env.device.sessionTree.isActive(threadId), '经理空闲')
    const turns = env.pi.turns.get(threadId)?.length

    // 忽略：记下谁、何时、理由；不计待处理
    const { decision } = await client.call(MANAGER_METHOD.decisionIgnore, {
      managerId: manager.id,
      decisionId: 'D-1',
      revision: 1,
      reason: '不需要',
    })
    assert.equal(decision.status, 'ignored')
    assert.equal(decision.closed.by, 'user')
    assert.equal(decision.closed.reason, '不需要')
    assert.equal(typeof decision.closed.at, 'number')
    assert.equal(env.device.managers.manager(manager.id).pendingDecisions, 2)
    const fails = async (params: unknown) =>
      (await client.fails(MANAGER_METHOD.decisionIgnore, params)).data.litch
    assert.equal(
      await fails({ managerId: manager.id, decisionId: 'D-1', revision: 2 }),
      'decisionNotOpen',
    )
    assert.equal(
      await fails({ managerId: manager.id, decisionId: 'D-2', revision: 7 }),
      'decisionConflict',
    )
    // 不唤醒：事件排着，过了设备的投递节拍经理仍没开回合（这里要证明“没发生”，只能等过节拍）
    assert.equal(env.device.managers.store.deliveries(manager.id).length, 1)
    await new Promise((done) => setTimeout(done, 1500))
    assert.equal(env.pi.running(threadId), false)
    assert.equal(env.pi.turns.get(threadId)?.length, turns)
    assert.equal(env.device.managers.store.deliveries(manager.id).length, 1)

    // 用户答复别的决策开回合：忽略事件先交出，答复跟在同一回合里
    await client.call(MANAGER_METHOD.answersSubmit, {
      managerId: manager.id,
      answers: [{ decisionId: 'D-2', revision: 1, optionId: null, text: '同意' }],
    })
    await until(() => env.device.managers.store.deliveries(manager.id).length === 0, '两条都交出')
    assert.deepEqual(events(env.pi.current(threadId)?.items), [
      'manager-ignored:D-1',
      'manager-answers',
    ])
    const told = (env.pi.current(threadId)?.items[0]?.content as any)?.[0]?.text as string
    assert.match(told, /D-1 "甲？": "不需要"/)
    assert.match(told, /litch_manager\.reopen/)

    // 经理：总览不列为待定、只列 id 和标题；不能直接答复、不能关闭；重开必须写理由、只限被忽略的
    const summary = value(await tool('summary', {}))
    assert.deepEqual(
      summary.decisions.map((one: { id: string }) => one.id),
      ['D-3'],
    )
    assert.deepEqual(summary.ignoredDecisions, [{ id: 'D-1', title: '甲？' }])
    assert.equal((await tool('answer', { id: 'D-1', optionId: null, text: '好' })).success, false)
    assert.equal(
      (await tool('close', { kind: 'decision', id: 'D-1', status: 'withdrawn', reason: '过时' }))
        .success,
      false,
    )
    assert.equal((await tool('reopen', { id: 'D-1' })).success, false)
    assert.equal((await tool('reopen', { id: 'D-1', reason: '  ' })).success, false)
    assert.equal((await tool('reopen', { id: 'D-3', reason: '没忽略' })).success, false)
    const reopened = value(await tool('reopen', { id: 'D-1', reason: '上线时间改了，要重新定' }))
    assert.equal(reopened.object.status, 'open')
    assert.equal(reopened.object.closed, null)
    const change = env.device.managers.board(manager.id).changes[0]
    assert.equal(change?.objectId, 'D-1')
    assert.equal(change?.by, 'manager')
    assert.equal(change?.why, '上线时间改了，要重新定')
    assert.equal(env.device.managers.manager(manager.id).pendingDecisions, 2)

    // 经理有回合在跑时忽略：插进这一回合
    await client.call(MANAGER_METHOD.decisionIgnore, {
      managerId: manager.id,
      decisionId: 'D-3',
      revision: 1,
    })
    await until(() => env.device.managers.store.deliveries(manager.id).length === 0, '插话送达')
    assert.equal(events(env.pi.current(threadId)?.items).at(-1), 'manager-ignored:D-3')
    env.pi.end(threadId, 'completed', '处理完')
    await until(() => !env.device.sessionTree.isActive(threadId), '再次空闲')

    // 交出前用户撤销了忽略：这一条不再告诉经理
    await client.call(MANAGER_METHOD.decisionIgnore, {
      managerId: manager.id,
      decisionId: 'D-1',
      revision: reopened.object.revision,
    })
    const back = await client.call(MANAGER_METHOD.decisionReopen, {
      managerId: manager.id,
      decisionId: 'D-1',
    })
    assert.equal(back.decision.status, 'open')
    assert.equal(env.device.managers.manager(manager.id).pendingDecisions, 1)
    await client.call(MANAGER_METHOD.update, { managerId: manager.id, rules: 'New policy.' })
    await until(() => env.device.managers.store.deliveries(manager.id).length === 0, '规矩送达')
    await until(() => env.pi.running(threadId), '规矩开回合')
    assert.deepEqual(events(env.pi.current(threadId)?.items), ['manager-rules'])
  } finally {
    await env.close()
  }
})
