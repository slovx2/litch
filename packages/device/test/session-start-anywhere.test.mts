// 已授权派出在自动回合照常执行，提案与直接启动分别计数，所有入口共用并发名额。
import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionTools } from '../../protocol/src/client-tools-sessions.mjs'
import { startChild } from '../src/session-start.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { brief, litch, parent, SESSIONS, text, treeRig, until } from './tree-kit.mjs'

const spec = {
  kind: 'fresh' as const,
  title: '并发任务',
  ...brief('检查独立模块'),
  wakeParent: false,
}
const args = (i: number) => ({
  title: `任务${i}`,
  ...brief('检查独立模块'),
  harness: 'claude-code',
  initiation: 'user_asked',
})

test('START-ANY-001：唤醒、提醒、定时来源均可连开五路，四张提案与直接启动互不占额', async () => {
  for (const kind of ['wake', 'remind', 'task']) {
    const env = treeRig()
    try {
      const client = await litch(env)
      const { threadId } = await parent(client, false)
      const link = await env.device.sessionTree.link('pi')
      const turn = (await link.request('turn/start', {
        threadId,
        input: text(`自动${kind}`),
      })) as any
      if (kind === 'task') env.device.sessionTree.host.taskTurn = (_, id) => id === turn.turn.id
      assert.equal(env.device.sessionTree.isUserTurn('pi', turn.turn.id), false)
      for (let i = 0; i < 4; i++) {
        const call = await env.pi.callTool(threadId, SESSIONS, 'start', {
          ...args(i),
          initiation: 'propose',
        })
        assert.ok(resultOf(call?.answer).proposal_id)
      }
      for (let i = 0; i < 5; i++) {
        const call = await env.pi.callTool(threadId, SESSIONS, 'start', args(i))
        assert.ok(resultOf(call?.answer).thread_id, kind)
        assert.equal(resultOf(call?.answer).proposal_id, undefined)
      }
      assert.equal(env.device.sessionTree.proposals(threadId).length, 4)
      const extra = await env.pi.callTool(threadId, SESSIONS, 'start', {
        ...args(9),
        initiation: 'propose',
      })
      assert.equal(failureOf(extra?.answer), 'blocked')
    } finally {
      await env.close()
    }
  }
})

test('START-ANY-002：同回合成功16次后拒绝第17次，失败退额，重连不重置，下一回合有独立额度', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const original = env.claude.handlers['thread/start']
    assert.ok(original)
    env.claude.handlers['thread/start'] = () => {
      throw new RpcFailure(-32000, '模拟创建失败')
    }
    assert.ok(failureOf((await env.pi.callTool(threadId, SESSIONS, 'start', args(0)))?.answer))
    env.claude.handlers['thread/start'] = original
    for (let i = 0; i < 16; i++) {
      const result = resultOf((await env.pi.callTool(threadId, SESSIONS, 'start', args(i)))?.answer)
      assert.ok(result.thread_id, `第${i + 1}次成功`)
      env.claude.end(result.thread_id)
      await until(() => !env.device.sessionTree.isActive(result.thread_id), '子会话结束')
    }
    const reconnected = await litch(env)
    await reconnected.call('thread/resume', { threadId })
    const denied = await env.pi.callTool(threadId, SESSIONS, 'start', args(17))
    assert.equal(failureOf(denied?.answer), 'blocked')
    assert.match(denied?.answer.result.contentItems[0].text, /16 direct starts/)
    assert.equal(env.claude.sent('turn/start').length, 16)
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '父回合结束')
    await client.call('turn/start', { threadId, input: text('执行下一批') })
    assert.ok(
      resultOf((await env.pi.callTool(threadId, SESSIONS, 'start', args(18)))?.answer).thread_id,
    )
  } finally {
    await env.close()
  }
})

test('START-ANY-003：多入口并发最多八个，失败释放预占', async () => {
  const env = treeRig()
  let release = () => {}
  try {
    const client = await litch(env)
    const { threadId, turnId } = await parent(client)
    const original = env.claude.handlers['thread/start']
    assert.ok(original)
    assert.ok(turnId)
    const link = await env.device.sessionTree.link('claude-code')
    const request = link.request.bind(link)
    let entering = 0
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    link.request = async (method, params, options) => {
      if (method === 'thread/start') {
        entering++
        await barrier
      }
      return request(method, params, options)
    }
    const starts = Array.from({ length: 12 }, (_, i) =>
      startChild(
        env.device.sessionTree,
        threadId,
        { ...spec, harness: 'claude-code' },
        i % 2 ? 'user' : 'model',
        i % 2 ? undefined : turnId,
      ),
    )
    const settled = Promise.allSettled(starts)
    await until(() => entering === 8, '八个请求已占位')
    release()
    const outcomes = await settled
    link.request = request
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 8)
    assert.equal(outcomes.filter((r) => r.status === 'rejected').length, 4)
    for (const row of outcomes) if (row.status === 'fulfilled') env.claude.end(row.value.threadId)
    await until(
      () =>
        env.device.sessionTree.store
          .childrenOf(threadId)
          .every((c) => !env.device.sessionTree.isActive(c.threadId)),
      '全部停止',
    )
    env.claude.handlers['thread/start'] = () => {
      throw new RpcFailure(-32000, '模拟失败')
    }
    const failed = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        startChild(env.device.sessionTree, threadId, { ...spec, harness: 'claude-code' }, 'user'),
      ),
    )
    assert.ok(failed.every((r) => r.status === 'rejected'))
    env.claude.handlers['thread/start'] = original
    const retry = await startChild(
      env.device.sessionTree,
      threadId,
      { ...spec, harness: 'claude-code' },
      'user',
    )
    assert.ok(retry.threadId)
  } finally {
    release()
    await env.close()
  }
})

test('START-ANY-005：已收到开始通知但启动应答未回的子会话只占一个名额', async () => {
  const env = treeRig()
  let release = () => {}
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const link = await env.device.sessionTree.link('claude-code')
    const request = link.request.bind(link)
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let begun = 0
    link.request = async (method, params, options) => {
      const answer = await request(method, params, options)
      if (method === 'turn/start') {
        begun++
        await barrier
      }
      return answer
    }
    const first = Promise.all(
      Array.from({ length: 4 }, () =>
        startChild(env.device.sessionTree, threadId, { ...spec, harness: 'claude-code' }, 'user'),
      ),
    )
    await until(() => begun === 4, '四个子会话已经开始，但应答仍未返回')
    const second = Promise.all(
      Array.from({ length: 4 }, () =>
        startChild(env.device.sessionTree, threadId, { ...spec, harness: 'claude-code' }, 'user'),
      ),
    )
    await until(() => begun === 8, '另外四个名额仍可使用')
    await assert.rejects(startChild(env.device.sessionTree, threadId, spec, 'user'), /limit is 8/)
    release()
    assert.equal((await first).length + (await second).length, 8)
  } finally {
    release()
    await env.close()
  }
})

test('START-ANY-006：同回合只剩一个额度时并发启动只放行一个，不同父会话不互占', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId, turnId } = await parent(client)
    assert.ok(turnId)
    for (let i = 0; i < 15; i++)
      assert.ok(env.device.sessionTree.store.reserveDirectStart(threadId, turnId, 16))
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        startChild(
          env.device.sessionTree,
          threadId,
          { ...spec, harness: 'claude-code' },
          'model',
          turnId,
        ),
      ),
    )
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter((r) => r.status === 'rejected').length, 3)
    const other = await parent(client)
    assert.ok(other.turnId)
    assert.ok(
      (await startChild(env.device.sessionTree, other.threadId, spec, 'model', other.turnId))
        .threadId,
    )
  } finally {
    await env.close()
  }
})

test('START-ANY-004：直接启动必须有回合号；任务卡开关各变体都带双语授权和独立上限规则', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    await assert.rejects(startChild(env.device.sessionTree, threadId, spec, 'model', ''), /turn ID/)
    assert.equal(env.device.sessionTree.store.childrenOf(threadId).length, 0)
    for (const cards of [true, false])
      for (const wrap of [true, false]) {
        const tools = sessionTools(wrap, cards)
        const start = tools.tools.find((t) => t.name === 'start')
        assert.ok(start)
        assert.match(start.description, /any turn/)
        assert.match(start.description, /16 direct starts/)
        assert.match(start.description, /任意后续回合/)
        assert.match(tools.instructions ?? '', /用户已经要求过/)
        assert.doesNotMatch(start.description, /separate work in their latest message/)
      }
  } finally {
    await env.close()
  }
})
