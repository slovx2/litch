// 设备进程自己开的引擎连接（engine-link.mts）和自己执行的命名空间表（device-tools.mts）：
// 这两件和定时任务线共用，这里只测它们自己的约定。
import assert from 'node:assert/strict'
import test from 'node:test'
import { DeviceTools } from '../src/device-tools.mjs'
import { runTurn } from '../src/engine-link.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig } from './helpers.mjs'
import { text } from './tree-kit.mjs'

test('ENGINE-LINK-001：openEngineLink 握手时声明设备注册的命名空间；runTurn 等到回合结束带回最后的回答；连接断了报 onClose', async () => {
  const pi = new FakeEngine('pi')
  const env = rig({ pi })
  try {
    const link = await env.device.openEngineLink('pi')
    assert.deepEqual(link.runtime?.extensions, ['clientTools'])
    const greeting = [...pi.greetings.values()][0]
    assert.equal(greeting.clientInfo.name, 'litch-device')
    assert.deepEqual(greeting.capabilities.litchClientTools, {
      namespaces: ['litch_tasks', 'litch_manager', 'litch_sessions'],
      anyThread: ['litch_tasks', 'litch_manager', 'litch_sessions'],
    })
    const { thread } = await link.request('thread/start', { cwd: '/work' })
    const running = runTurn(
      link,
      { threadId: thread.id, input: text('跑一下') },
      { timeoutMs: 2000 },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    pi.end(thread.id, 'completed', '跑完了')
    const result = await running
    assert.equal(result.status, 'completed')
    assert.equal(result.lastMessage, '跑完了')
    assert.match(result.turnId, /turn/)
    const timedOut = await runTurn(
      link,
      { threadId: thread.id, input: text('再跑') },
      // 到点打断，再等打断的结果一小会儿
      { timeoutMs: 50, interruptGraceMs: 50 },
    )
    assert.equal(timedOut.status, 'timedOut')
    let closed = ''
    link.onClose((reason) => {
      closed = reason
    })
    pi.crash()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(closed)
    assert.equal(link.closed, true)
    await assert.rejects(link.request('thread/list', {}))
  } finally {
    await env.close()
  }
})

test('ENGINE-LINK-002：没在跑的 harness、没配置的 harness 开不了连接', async () => {
  const control = new FakeControl([managed('pi', 'stopped')])
  const pi = new FakeEngine('pi')
  const env = rig({}, {}, { control, dial: () => pi.connector })
  try {
    await assert.rejects(env.device.openEngineLink('pi'), /is not running/)
    await assert.rejects(env.device.openEngineLink('nope'), /is not configured/)
  } finally {
    await env.close()
  }
})

test('DEVICE-TOOLS-001：命名空间要以 litch_ 开头、不能注册两次；处理函数抛错替它回 failed；同一次调用的几份只执行一次', async () => {
  const tools = new DeviceTools()
  assert.throws(() => tools.register('sessions', async () => ({ success: true, contentItems: [] })))
  let runs = 0
  tools.register('litch_test', async (call) => {
    runs++
    if (call.tool === 'boom') throw new Error('炸了')
    return { success: true, contentItems: [{ type: 'inputText', text: call.tool }] }
  })
  assert.throws(() =>
    tools.register('litch_test', async () => ({ success: true, contentItems: [] })),
  )
  assert.deepEqual(tools.namespaces(), ['litch_test'])
  assert.equal(tools.has('litch_test'), true)
  assert.equal(tools.has('litch_other'), false)
  const replies: unknown[] = []
  const params = { threadId: 't', turnId: 'u', callId: 'c1', namespace: 'litch_test', tool: 'ok' }
  // 第一份所在的连接断了：从第二份的连接回
  tools.dispatch('codex', params, () => false)
  tools.dispatch('codex', params, (reply) => replies.push(reply) > 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  tools.dispatch('codex', params, (reply) => replies.push(reply) > 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runs, 1)
  assert.equal(replies.length, 1, '迟到的副本不再答')
  const failed: any[] = []
  tools.dispatch('pi', { ...params, callId: 'c2', tool: 'boom' }, (reply) => failed.push(reply) > 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(failed[0].success, false)
  assert.match(failed[0].contentItems[0].text, /^\[litch:failed\].*炸了/)
  // 回合结束：执行中的拿到的 signal 作废
  let aborted = false
  tools.register('litch_wait', (_call, { signal }) => {
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true
        resolve({ success: false, contentItems: [] })
      })
    })
  })
  tools.dispatch('pi', { ...params, callId: 'c3', namespace: 'litch_wait' }, () => true)
  await new Promise((resolve) => setTimeout(resolve, 5))
  tools.turnEnded('pi', 'u')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(aborted, true)
})
