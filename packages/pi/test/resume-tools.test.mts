import assert from 'node:assert/strict'
import test from 'node:test'
import { clientToolSpecs } from '../../protocol/src/client-tools-specs.mjs'
import { RESUME_TOOLS_READ } from '../../protocol/src/resume-tools.mjs'
import { clientTools } from '../src/dynamic-tools.mjs'
import { approvalHarness } from './approval-harness.mjs'

test('Pi 恢复工具：活动回合延后，缓存按指纹重建，新增工具可调用且移除后模型不再看到', {
  timeout: 30000,
}, async () => {
  const h = await approvalHarness({ approvals: false })
  let enter!: () => void
  const entered = {
    promise: new Promise<void>((resolve) => {
      enter = resolve
    }),
    resolve: () => enter(),
  }
  let unblock!: () => void
  const release = {
    promise: new Promise<void>((resolve) => {
      unblock = resolve
    }),
    resolve: () => unblock(),
  }
  try {
    const c = await h.connect('desktop', ['clientTools'])
    await c.ok('initialize', {
      clientInfo: { name: 'desktop', version: '0' },
      capabilities: {
        litchExtensions: ['clientTools'],
        litchClientTools: { namespaces: ['litch_machine'] },
      },
    })
    const { thread } = await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })
    const tools = clientToolSpecs(['litch_machine'])
    const machine = clientTools(tools).find((tool) => tool.name === 'machines')!
    h.steps.push(async () => {
      entered.resolve()
      await release.promise
      return { text: '继续' }
    })
    const first = await c.start(thread.id, '保持本回合')
    await entered.promise
    const original = h.server.sessions.get(thread.id)
    await c.ok('thread/resume', { threadId: thread.id, dynamicTools: tools })
    assert.deepEqual((await c.ok(RESUME_TOOLS_READ, { threadId: thread.id })).dynamicTools, [])
    assert.equal(h.server.sessions.get(thread.id), original)
    release.resolve()
    await c.completed(first)
    assert.deepEqual(h.server.store.thread(thread.id).dynamicTools, tools)
    h.steps.push((body) => {
      assert.ok(body.tools.some((tool: any) => tool.function.name === machine.piName))
      return { tools: [{ name: machine.piName, args: {} }] }
    })
    const second = await c.start(thread.id, '调用新工具')
    const request = await c.until('工具调用', (message) => message.method === 'item/tool/call')
    await c.answer(request, {
      success: true,
      contentItems: [{ type: 'inputText', text: '调用成功' }],
    })
    assert.equal((await c.completed(second)).status, 'completed')
    assert.notEqual(h.server.sessions.get(thread.id), original)
    const installed = h.server.sessions.get(thread.id)
    await c.ok('thread/resume', { threadId: thread.id, dynamicTools: tools })
    assert.equal(h.server.sessions.get(thread.id), installed, '相同工具、相同历史复用实例')
    await c.ok('thread/resume', { threadId: thread.id, dynamicTools: [] })
    assert.notEqual(h.server.sessions.get(thread.id), installed)
    h.steps.push((body) => {
      assert.ok(!body.tools.some((tool: any) => tool.function.name === machine.piName))
      return { text: '工具已移除' }
    })
    await c.completed(await c.start(thread.id, '验证关闭'))
    for (const dynamicTools of [null, {}, [{ type: 'function', name: 'broken' }]]) {
      const reply = await c.call('thread/resume', { threadId: thread.id, dynamicTools })
      assert.equal(reply.error.code, -32602)
      assert.deepEqual(h.server.store.thread(thread.id).dynamicTools, [])
    }
    const ephemeral = await c.ok('thread/start', {
      cwd: h.cwd,
      model: 'gate/gate',
      ephemeral: true,
    })
    await c.ok('thread/resume', { threadId: ephemeral.thread.id, dynamicTools: tools })
    assert.deepEqual(h.server.store.thread(ephemeral.thread.id).dynamicTools, [])
    assert.deepEqual(h.invalid, [])
  } finally {
    release.resolve()
    await h.dispose()
  }
})
