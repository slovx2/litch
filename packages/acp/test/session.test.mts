import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, scene, text, turn, violations } from './client.mjs'

// 会话层面的：设置、计划模式、标题、技能、分叉、打断、agent 退出后接回、重开之后的历史。

test('模型、强度、计划模式：先记下，下一回合前交给 agent；不认识的值拒绝', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const listed = await s.desktop.call('model/list', {})
    assert.deepEqual(
      listed.data.map((model: any) => [model.id, model.isDefault]),
      [
        ['fake-small', true],
        ['fake-large', false],
      ],
    )
    assert.deepEqual(
      listed.data[0].supportedReasoningEfforts.map((e: any) => e.reasoningEffort),
      ['low', 'high'],
    )
    const modes = await s.desktop.call('collaborationMode/list', {})
    assert.deepEqual(
      modes.data.map((mode: any) => mode.mode),
      ['default', 'plan'],
    )
    await assert.rejects(
      s.desktop.call('thread/settings/update', { threadId: thread.id, model: 'gpt-5' }),
      (error: any) => error.code === -32602,
    )
    // 会话接上着：立刻交
    await s.desktop.call('thread/settings/update', {
      threadId: thread.id,
      model: 'fake-large',
      effort: 'high',
    })
    const updated = await s.desktop.until('thread/settings/updated')
    assert.equal(updated.threadSettings.model, 'fake-large')
    assert.equal(updated.threadSettings.reasoningEffort, 'high')
    const sent = (await s.received()).filter((m) => m.method === 'session/set_config_option')
    assert.deepEqual(
      sent.map((m) => [m.params.configId, m.params.value]),
      [
        ['model', 'fake-large'],
        ['effort', 'high'],
      ],
    )
    // 计划模式跟着回合走：进计划模式、再出来换回原来的模式
    await turn(s, thread.id, text('hello'), {
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'fake-large', reasoning_effort: null, developer_instructions: null },
      },
    })
    await turn(s, thread.id, text('hello'), {
      collaborationMode: {
        mode: 'default',
        settings: { model: 'fake-large', reasoning_effort: null, developer_instructions: null },
      },
    })
    const modeChanges = (await s.received()).filter((m) => m.method === 'session/set_mode')
    assert.deepEqual(
      modeChanges.map((m) => m.params.modeId),
      ['plan', 'default'],
    )
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('agent 起的标题、命令清单：标题转成改名通知，命令当技能列出来', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const before = await s.desktop.call('skills/list', { cwds: [s.cwd] })
    await turn(s, thread.id, text('title'))
    const named = await s.desktop.until('thread/name/updated')
    assert.equal(named.threadName, 'Fake 标题')
    const skills = await s.desktop.call('skills/list', { cwds: [s.cwd] })
    assert.deepEqual(
      skills.data[0].skills.map((skill: any) => skill.name),
      ['review', 'init'],
    )
    assert.ok(skills.data[0].skills.every((skill: any) => skill.path.startsWith('acp://acp/')))
    // 问过清单的连接在清单变了时收到 skills/changed（命令清单在 session/new 之后才到）
    if (!before.data[0].skills.length)
      assert.ok(s.desktop.notifications.some((n) => n.method === 'skills/changed'))
    // 用户改的名字之后不被 agent 的标题盖掉
    await s.desktop.call('thread/name/set', { threadId: thread.id, name: '我的名字' })
    await turn(s, thread.id, text('title'))
    const read = await s.desktop.call('thread/read', { threadId: thread.id, includeTurns: false })
    assert.equal(read.thread.name, '我的名字')
    // 技能交给 agent 时是打头的斜杠命令
    await turn(s, thread.id, [
      { type: 'skill', name: 'review', path: 'acp://acp/commands/review' },
      ...text('看看'),
    ])
    const prompts = (await s.received()).filter((m) => m.method === 'session/prompt')
    assert.equal(prompts.at(-1).params.prompt[0].text, '/review 看看')
    const user = s.desktop.notifications
      .filter((n) => n.method === 'item/completed' && n.params.item.type === 'userMessage')
      .at(-1).params.item
    assert.equal(user.content[0].type, 'skill')
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('分叉：从末尾分出新会话，回合照抄；指定了中间的回合拒绝', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const first = await turn(s, thread.id, text('hello'))
    await turn(s, thread.id, text('second'))
    await assert.rejects(
      s.desktop.call('thread/fork', { threadId: thread.id, lastTurnId: first.id }),
      (error: any) => error.code === -32602,
    )
    const forked = await s.desktop.call('thread/fork', { threadId: thread.id })
    assert.notEqual(forked.thread.id, thread.id)
    assert.equal(forked.thread.forkedFromId, thread.id)
    assert.equal(forked.thread.turns.length, 2)
    const next = await turn(s, forked.thread.id, text('after fork'))
    assert.equal(next.status, 'completed')
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('打断：发 session/cancel，回合记成 interrupted；挂着的审批撤回并回 agent 取消', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const { turn: waiting } = await s.desktop.call('turn/start', {
      threadId: thread.id,
      input: text('wait'),
    })
    await s.desktop.until('item/agentMessage/delta', (p) => p.delta === '等着')
    await s.desktop.call('turn/interrupt', { threadId: thread.id, turnId: waiting.id })
    const done = await s.desktop.until('turn/completed', (p) => p.turn.id === waiting.id)
    assert.equal(done.turn.status, 'interrupted')
    assert.ok((await s.received()).some((m) => m.method === 'session/cancel'))
    // 审批挂着时打断
    s.desktop.onRequest(() => undefined)
    const { turn: asking } = await s.desktop.call('turn/start', {
      threadId: thread.id,
      input: text('run'),
    })
    await s.desktop.until('thread/status/changed', (p) =>
      p.status.activeFlags?.includes('waitingOnApproval'),
    )
    await s.desktop.call('turn/interrupt', { threadId: thread.id, turnId: asking.id })
    const stopped = await s.desktop.until('turn/completed', (p) => p.turn.id === asking.id)
    assert.equal(stopped.turn.status, 'interrupted')
    const command = stopped.turn.items.find((item: any) => item.type === 'commandExecution')
    assert.notEqual(command.status, 'completed')
    const cancelled = (await s.received()).filter((m) => m.result?.outcome?.outcome === 'cancelled')
    assert.equal(cancelled.length, 1)
    assert.ok(s.desktop.notifications.some((n) => n.method === 'serverRequest/resolved'))
  } finally {
    await dispose(s)
  }
})

test('agent 进程退出：在跑的回合失败，下一回合起新进程、用 session/resume 接回会话', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const crashed = await turn(s, thread.id, text('crash'))
    assert.equal(crashed.status, 'failed')
    assert.match(crashed.error.message, /进程已退出/)
    const next = await turn(s, thread.id, text('hello'))
    assert.equal(next.status, 'completed')
    const messages = await s.received()
    assert.equal(messages.filter((m) => m.method === 'initialize').length, 2)
    assert.equal(messages.filter((m) => m.method === 'session/resume').length, 1)
  } finally {
    await dispose(s)
  }
})

test('不支持 resume 和 load 的 agent：进程换了之后会话接不上，回合失败并说明原因', async () => {
  const s = await scene({ FAKE_ACP_CAPS: JSON.stringify({ loadSession: false }) })
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    await turn(s, thread.id, text('crash'))
    const next = await turn(s, thread.id, text('hello'))
    assert.equal(next.status, 'failed')
    assert.match(next.error.message, /不支持接回旧会话/)
  } finally {
    await dispose(s)
  }
})

test('重开适配器：经这里建的会话照库里记的摆回来，不起 agent；agent 自己的会话用 session/load 回放', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    s.desktop.onRequest(() => ({ decision: 'accept' }))
    await turn(s, thread.id, text('run'))
    await s.server.close()
    // 同一个状态目录：历史从库里来
    const again = new AcpServer(s.home, s.env)
    const desktop = client(again)
    const before = (await s.received()).length
    const read = await desktop.call('thread/read', { threadId: thread.id })
    assert.equal(read.thread.turns.length, 1)
    assert.equal(read.thread.turns[0].items[1].type, 'commandExecution')
    assert.equal((await s.received()).length, before, '读库里的会话不该起 agent')
    await again.close()
    // 换一个状态目录（库里没有）：从 agent 的清单里找到，回放出来
    const other = new AcpServer(join(s.root, 'other-home'), s.env)
    const viewer = client(other)
    const listed = await viewer.call('thread/list', {})
    assert.ok(listed.data.some((entry: any) => entry.id === thread.id))
    const replayed = await viewer.call('thread/read', { threadId: thread.id })
    assert.equal(replayed.thread.turns.length, 1)
    assert.equal(replayed.thread.turns[0].items[0].content[0].text, 'run')
    assert.ok((await s.received()).some((m) => m.method === 'session/load'))
    await other.close()
    assert.deepEqual([...violations], [])
  } finally {
    await s.restore()
  }
})
