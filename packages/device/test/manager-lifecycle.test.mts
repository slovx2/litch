import assert from 'node:assert/strict'
import test from 'node:test'
import { managerRoleRules, managerRulesText } from '../../protocol/src/client-tools-manager.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import {
  formatSessionEvent,
  parseSessionEvent,
  type SessionEvent,
} from '../../protocol/src/session-tree.mjs'
import { startChild } from '../src/session-start.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig } from './helpers.mjs'
import { until } from './tree-kit.mjs'

async function setup() {
  const engine = new FakeEngine('pi')
  const env = rig({ pi: engine })
  const client = env.connect()
  await client.initialize(['harness', 'litchManager'])
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: '收尾测试',
    scope: '旧范围',
    rules: 'Old rules.',
    template: 'blank',
    firstTask: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT },
  })
  await until(() => engine.running(threadId), '经理开场')
  const call = async (tool: string, args: unknown, turnId = engine.current(threadId)?.id ?? '') =>
    env.device.managers.tool({
      harness: 'pi',
      threadId,
      turnId,
      callId: 'test',
      namespace: 'litch_manager',
      tool,
      arguments: args,
    })
  const value = async (tool: string, args: unknown) => {
    const response = await call(tool, args)
    assert.equal(response.success, true, JSON.stringify(response))
    return JSON.parse(
      response.contentItems[0]?.type === 'inputText' ? response.contentItems[0].text : '',
    )
  }
  return { ...env, engine, client, manager, threadId, call, value }
}

test('结束中：等旧回合停下、只授权收尾回合，收尾可写总结/事项/关闭/landed，重复 end 不多开', async () => {
  const env = await setup()
  try {
    const { client, manager, threadId, engine, call, value } = env
    await value('add', { kind: 'item', item: { title: '实施' } })
    await value('add', { kind: 'decision', decision: { title: '尚未决定', background: '' } })
    await value('add', { kind: 'decision', decision: { title: '已决定', background: '' } })
    await value('answer', { id: 'D-2', optionId: null, text: '采用' })
    const previous = engine.current(threadId)?.id
    const ended = await client.call(MANAGER_METHOD.end, { managerId: manager.id })
    assert.equal(ended.manager.status, 'ending')
    assert.equal(ended.manager.endedAt, null)
    assert.equal(
      (await client.call(MANAGER_METHOD.end, { managerId: manager.id })).manager.status,
      'ending',
    )
    assert.equal(
      env.device.managers.store
        .deliveries(manager.id)
        .filter((event) => parseSessionEvent(event.text).event?.kind === 'manager-end').length,
      1,
    )
    assert.equal(engine.current(threadId)?.id, previous)
    assert.equal((await call('status', { text: '旧回合越权' })).success, false)
    await assert.rejects(
      startChild(
        env.device.sessionTree,
        threadId,
        { kind: 'fresh', title: '不再开线', prompt: '任务', wakeParent: false, worktree: false },
        'model',
      ),
      /ending/,
    )
    engine.end(threadId, 'completed', '原来的工作停下了')
    await until(
      () => engine.running(threadId) && engine.current(threadId)?.id !== previous,
      '收尾回合',
    )
    await until(
      () => env.device.managers.store.ending(manager.id)?.turnId === engine.current(threadId)?.id,
      '持久化回合绑定',
    )
    assert.equal(env.device.managers.manager(manager.id).status, 'ending')
    assert.equal((await call('status', { text: '迟到的旧回合调用' }, previous)).success, false)
    await value('status', { text: '完成总结' })
    await value('close', { kind: 'decision', id: 'D-1', status: 'withdrawn', reason: '不再需要' })
    await value('update', {
      kind: 'item',
      id: 'I-1',
      patch: { status: 'review' },
      why: '待用户验收',
    })
    await value('update', {
      kind: 'decision',
      id: 'D-2',
      patch: { landed: [{ kind: 'file', target: 'RESULT.md', label: null }] },
      why: '已落地',
    })
    assert.equal((await call('add', { kind: 'item', item: { title: '新任务' } })).success, false)
    assert.equal(
      (await client.fails(MANAGER_METHOD.update, { managerId: manager.id, scope: '改范围' })).data
        .litch,
      'managerEnded',
    )
    engine.end(threadId, 'completed', '总结已保存')
    await until(() => env.device.managers.manager(manager.id).status === 'ended', '转为只读')
    assert.ok(env.device.managers.manager(manager.id).endedAt)
    assert.equal(env.device.managers.store.situation(manager.id)?.text, '完成总结')
    assert.equal((await call('status', { text: '结束后不能改' })).success, false)
    assert.equal((await call('get', { id: 'D-2' })).success, true)
    const count = engine.turns.get(threadId)?.length
    await client.call(MANAGER_METHOD.end, { managerId: manager.id })
    assert.equal(engine.turns.get(threadId)?.length, count)
    assert.equal(env.device.managers.store.deliveries(manager.id).length, 0)
  } finally {
    await env.close()
  }
})

for (const outcome of ['failed', 'interrupted'] as const)
  test(`收尾回合 ${outcome} 后仍转 ended，保留未完成对象`, async () => {
    const env = await setup()
    try {
      await env.value('add', { kind: 'item', item: { title: '未完' } })
      env.engine.end(env.threadId, 'completed', '计划')
      await env.client.call(MANAGER_METHOD.end, { managerId: env.manager.id })
      await until(
        () => Boolean(env.device.managers.store.ending(env.manager.id)?.turnId),
        '收尾已开始',
      )
      env.engine.end(env.threadId, outcome)
      await until(
        () => env.device.managers.manager(env.manager.id).status === 'ended',
        '收尾已终止',
      )
      assert.equal(env.device.managers.store.object(env.manager.id, 'I-1')?.status, 'backlog')
      assert.equal((await env.call('status', { text: '不能写' })).success, false)
    } finally {
      await env.close()
    }
  })

test('manager-rules 格式/解析和提示词：携带新范围、清空规矩，不携带开发者说明', () => {
  const event: SessionEvent = {
    kind: 'manager-rules',
    notes: [],
    manager: { managerId: 'm1', text: managerRulesText('新范围\n第二行', '新规矩') },
  }
  const formatted = formatSessionEvent(event)
  assert.match(formatted, /updated this manager/)
  assert.deepEqual(parseSessionEvent(`${formatted}用户后续消息`), { event, rest: '用户后续消息' })
  assert.match(managerRulesText('范围', ''), /cleared the custom rules/)
  assert.throws(() => formatSessionEvent({ kind: 'manager-rules', notes: [] }), /Invalid/)
  const bad = formatted.replace('"managerId":"m1"', '"managerId":""')
  assert.equal(parseSessionEvent(bad).event, null)
  const rules = managerRoleRules('范围')
  assert.equal(rules.includes('Personal and project instructions remain'), false)
  assert.equal(rules.includes('automatically detect stale basis'), false)
})

test('改范围/规矩：同事务排事件、忙时插话、闲时开回合，相同内容或仅改名称不重复发', async () => {
  const env = await setup()
  try {
    const { client, manager, threadId, engine } = env
    const original = engine.current(threadId)?.id
    await client.call(MANAGER_METHOD.update, {
      managerId: manager.id,
      scope: '新范围',
      rules: 'New rules.',
    })
    await until(
      () =>
        engine
          .current(threadId)
          ?.items.some(
            (item) =>
              Array.isArray(item.content) &&
              item.content.some(
                (part) => parseSessionEvent(part.text ?? '').event?.kind === 'manager-rules',
              ),
          ) === true,
      '规矩插入当前回合',
    )
    assert.equal(engine.current(threadId)?.id, original)
    const content = engine.current(threadId)?.items.at(-1)?.content as any
    assert.equal(
      parseSessionEvent(content[0].text).event?.manager?.text,
      managerRulesText('新范围', 'New rules.'),
    )
    await until(() => env.device.managers.store.deliveries(manager.id).length === 0, '事件已出队')
    await client.call(MANAGER_METHOD.update, {
      managerId: manager.id,
      scope: '新范围',
      rules: 'New rules.',
      name: '新名字',
    })
    assert.equal(env.device.managers.store.deliveries(manager.id).length, 0)
    engine.end(threadId, 'completed', '当前回合完成')
    await client.call(MANAGER_METHOD.update, { managerId: manager.id, rules: '' })
    await until(() => engine.running(threadId), '闲时规矩更新开回合')
    const input = engine.current(threadId)?.items[0]?.content as any
    assert.match(
      parseSessionEvent(input[0].text).event?.manager?.text ?? '',
      /cleared the custom rules/,
    )
  } finally {
    await env.close()
  }
})

for (const phase of ['queued', 'running', 'finished-offline'] as const)
  test(`结束流程重启恢复：${phase}，不重复开收尾回合`, async () => {
    const first = await setup()
    let second: ReturnType<typeof rig> | null = null
    try {
      const { engine, threadId, manager } = first
      if (phase !== 'queued') engine.end(threadId, 'completed', '原回合完成')
      await first.client.call(MANAGER_METHOD.end, { managerId: manager.id })
      if (phase !== 'queued')
        await until(
          () => Boolean(first.device.managers.store.ending(manager.id)?.turnId),
          '收尾绑定',
        )
      await first.device.close()
      if (phase === 'queued') engine.end(threadId, 'completed', '离线时旧回合结束')
      if (phase === 'finished-offline') engine.end(threadId, 'completed', '离线时收尾结束')
      const before = engine.turns.get(threadId)?.length ?? 0
      second = rig({ pi: engine }, {}, { stateDir: first.stateDir })
      const current = second
      if (phase === 'finished-offline') {
        await until(
          () => current.device.managers.manager(manager.id).status === 'ended',
          '核实已结束',
        )
      } else {
        await until(
          () =>
            Boolean(current.device.managers.store.ending(manager.id)?.turnId) &&
            current.device.sessionTree.isActive(threadId),
          '恢复收尾',
        )
        const response = await current.device.managers.tool({
          harness: 'pi',
          threadId,
          turnId: engine.current(threadId)?.id ?? '',
          callId: 'restart',
          namespace: 'litch_manager',
          tool: 'status',
          arguments: { text: '重启后的总结' },
        })
        assert.equal(response.success, true, JSON.stringify(response))
        engine.end(threadId, 'completed', '收尾结束')
        await until(
          () => current.device.managers.manager(manager.id).status === 'ended',
          '结束后只读',
        )
      }
      assert.equal(engine.turns.get(threadId)?.length, before + (phase === 'queued' ? 1 : 0))
      assert.equal(current.device.managers.store.deliveries(manager.id).length, 0)
    } finally {
      if (second) await second.close()
      else await first.close()
    }
  })

test('收尾工具和完成通知早于 turn/start 应答：先从事件认出回合，不丢写入、不误开第二轮', async () => {
  const env = await setup()
  try {
    env.engine.end(env.threadId, 'completed', '旧回合结束')
    const start = env.engine.handlers['turn/start']
    assert.ok(start)
    let response: unknown = null
    env.engine.handlers['turn/start'] = async (params, connection) => {
      const result = await start(params, connection)
      if (parseSessionEvent(params.input?.[0]?.text ?? '').event?.kind === 'manager-end') {
        response = await env.call('status', { text: '应答之前已总结' })
        env.engine.end(env.threadId, 'completed', '收尾完成')
      }
      return result
    }
    await env.client.call(MANAGER_METHOD.end, { managerId: env.manager.id })
    await until(() => env.device.managers.manager(env.manager.id).status === 'ended', '快速收尾')
    assert.equal((response as { success: boolean }).success, true)
    assert.equal(env.device.managers.store.situation(env.manager.id)?.text, '应答之前已总结')
    assert.equal(env.engine.turns.get(env.threadId)?.length, 2)
  } finally {
    await env.close()
  }
})

test('规矩变更提交和事件入队同事务；插话失败保留，旧回合结束后重试', async () => {
  const env = await setup()
  try {
    const { client, manager, threadId, engine } = env
    const enqueue = env.device.managers.store.enqueue.bind(env.device.managers.store)
    const before = env.device.managers.store.changes(manager.id)
    env.device.managers.store.enqueue = () => {
      throw new Error('模拟事件写入失败')
    }
    await client.fails(MANAGER_METHOD.update, { managerId: manager.id, rules: '不能部分提交' })
    assert.equal(env.device.managers.manager(manager.id).rules, 'Old rules.')
    assert.deepEqual(env.device.managers.store.changes(manager.id), before)
    env.device.managers.store.enqueue = enqueue
    engine.handlers['turn/steer'] = () => {
      throw new Error('暂时不能插话')
    }
    await client.call(MANAGER_METHOD.update, { managerId: manager.id, scope: '之后的新范围' })
    await until(() => engine.seen.some((frame) => frame.method === 'turn/steer'), '插话尝试')
    assert.equal(env.device.managers.store.deliveries(manager.id).length, 1)
    engine.end(threadId, 'completed', '旧回合完成')
    await until(
      () =>
        engine.running(threadId) && env.device.managers.store.deliveries(manager.id).length === 0,
      '下一轮送达',
    )
    const input = engine.current(threadId)?.items[0]?.content as any
    assert.equal(parseSessionEvent(input[0].text).event?.kind, 'manager-rules')
  } finally {
    await env.close()
  }
})
