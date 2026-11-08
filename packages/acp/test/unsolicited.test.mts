import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, isolate, scene, text, turn, violations } from './client.mjs'

test('通用 ACP 空闲时收到正文立即显示，组成后台回合并持久化；未声明者不收到扩展', async () => {
  const s = await scene({
    FAKE_ACP_LATE_UPDATES: JSON.stringify([
      { sessionUpdate: 'session_info_update', title: '新标题' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '后台' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '结果' } },
    ]),
  })
  try {
    await s.desktop.call('initialize', { capabilities: { litchExtensions: ['backgroundTasks'] } })
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    await turn(s, thread.id, text('hello'))
    const plain = client(s.server)
    await plain.call('initialize', {})
    await plain.call('thread/resume', { threadId: thread.id })
    const agent = s.server.runtime.current()
    assert.ok(agent)
    await agent.connection.request('session/set_mode', {
      sessionId: thread.id,
      modeId: 'emit-late',
    })
    await s.desktop.until('item/agentMessage/delta', (p) => p.delta === '结果')
    const done = await s.desktop.until(
      'turn/completed',
      (p) => p.turn.litchOrigin === 'backgroundTask',
    )
    assert.equal(done.turn.items[0].text, '后台结果')
    assert.equal(done.turn.status, 'completed')
    assert.equal(
      plain.notifications.some((n) => n.params.turn?.litchOrigin),
      false,
    )
    const saved = s.server.store.getMeta('turns', thread.id)
    assert.equal(saved.length, 2)
    assert.equal(saved.at(-1).items[0].text, '后台结果')
    assert.equal(s.server.store.getMeta('turnOrigins', thread.id)[done.turn.id], 'backgroundTask')
    await turn(s, thread.id, text('hello again'))
    assert.equal(s.server.store.getMeta('turns', thread.id).length, 3)
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('停止后的晚到正文不重新唤醒；新用户回合解除停止范围', async () => {
  const s = await scene({
    FAKE_ACP_LATE_UPDATES: JSON.stringify([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '晚到' } },
    ]),
  })
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    await turn(s, thread.id, text('hello'))
    await s.desktop.call('turn/interrupt', { threadId: thread.id })
    const agent = s.server.runtime.current()
    assert.ok(agent)
    await agent.connection.request('session/set_mode', {
      sessionId: thread.id,
      modeId: 'emit-late',
    })
    assert.equal(s.server.live.get(thread.id)?.projection.turns.length, 1)
    await turn(s, thread.id, text('hello'))
    await agent.connection.request('session/set_mode', {
      sessionId: thread.id,
      modeId: 'emit-late',
    })
    assert.equal(s.server.live.get(thread.id)?.projection.turns.length, 3)
  } finally {
    await dispose(s)
  }
})

test('agy 回读与新用户 prompt 共用锁；取消后先排空 load，不追加旧回放', async (t) => {
  const isolated = await isolate({ CHA_ACP_AGENT: 'agy' })
  isolated.env.CHA_AGY_CLI = isolated.env.CHA_ACP_CLI
  isolated.env.CHA_AGY_ARGS = isolated.env.CHA_ACP_ARGS
  const server = new AcpServer(isolated.home, isolated.env)
  const desktop = client(server)
  const s = { ...isolated, server, desktop }
  let release = () => {}
  try {
    await desktop.call('initialize', { capabilities: { litchExtensions: ['backgroundTasks'] } })
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd })
    const previous = await turn(s, thread.id, text('hello'))
    await setImmediate()
    const agent = server.runtime.current()
    assert.ok(agent)
    let loadStarted = () => {}
    const started = new Promise<void>((resolve) => {
      loadStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = agent.connection.request.bind(agent.connection)
    let prompts = 0
    agent.connection.request = async (...args: Parameters<typeof original>) => {
      if (args[0] === 'session/load') {
        loadStarted()
        await gate
      }
      if (args[0] === 'session/prompt') prompts++
      return original(...args)
    }
    t.mock.timers.enable({ apis: ['setTimeout'] })
    server.agyBackground?.observe(thread.id, {
      sessionUpdate: 'tool_call',
      name: 'invoke_subagent',
      toolCallId: 'test-invoke',
    })
    server.agyBackground?.start(thread.id, previous.id)
    t.mock.timers.tick(3000)
    await started
    const next = desktop.call('turn/start', { threadId: thread.id, input: text('hello again') })
    await setImmediate()
    assert.equal(prompts, 0)
    assert.equal(server.report.tasks(thread.id).length, 0)
    release()
    t.mock.timers.reset()
    const result = await next
    await desktop.until('turn/completed', (p) => p.turn.id === result.turn.id)
    assert.equal(prompts, 1)
    assert.equal(server.live.get(thread.id)?.projection.turns.length, 2)
    assert.deepEqual([...violations], [])
  } finally {
    release()
    t.mock.timers.reset()
    await dispose(s)
  }
})

test('agy 完全访问的后台请求只允许本次且无卡片；用户停止后拒绝迟到请求', async () => {
  const isolated = await isolate({ CHA_ACP_AGENT: 'agy', FAKE_ACP_LATE_PERMISSION: '1' })
  isolated.env.CHA_AGY_CLI = isolated.env.CHA_ACP_CLI
  isolated.env.CHA_AGY_ARGS = isolated.env.CHA_ACP_ARGS
  const server = new AcpServer(isolated.home, isolated.env)
  const desktop = client(server)
  const s = { ...isolated, server, desktop }
  try {
    await desktop.call('initialize', {})
    const { thread } = await desktop.call('thread/start', {
      cwd: s.cwd,
      permissions: ':danger-full-access',
    })
    const agent = server.runtime.current()
    assert.ok(agent)
    const ask = () =>
      agent.connection.request('session/set_mode', { sessionId: thread.id, modeId: 'ask-late' })
    assert.deepEqual(await ask(), { outcome: { outcome: 'selected', optionId: 'once' } })
    assert.equal(desktop.requests.length, 0)
    assert.equal(server.live.get(thread.id)?.projection.turns.length, 0)
    await desktop.call('turn/interrupt', { threadId: thread.id })
    assert.deepEqual(await ask(), { outcome: { outcome: 'cancelled' } })
    await turn(s, thread.id, text('hello'))
    assert.deepEqual(await ask(), { outcome: { outcome: 'selected', optionId: 'once' } })
  } finally {
    await dispose(s)
  }
})
