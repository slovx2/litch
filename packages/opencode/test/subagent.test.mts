import assert from 'node:assert/strict'
import test from 'node:test'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

const SLOW = ['子代理', '的', '结果', '，', '慢', '慢', '说', '完', '。']
const RESULT = SLOW.join('')

// OpenCode 的子代理（task）：每次调用建一个子会话。父线程里画成上游派子代理的条目，指向子线程；
// 子线程能打开（thread/read、thread/resume）、事件照常投影，也能直接对它说话（canAcceptDirectInput）。
test('OpenCode：task 画成派子代理的条目，子线程能读、能订阅、能直接发话', {
  skip,
  timeout: 180000,
}, async () => {
  const env = await isolate(
    scripted({
      SPAWN: [
        [
          {
            type: 'tool',
            name: 'task',
            input: { description: '查一下', prompt: 'CHILD 去查', subagent_type: 'general' },
          },
        ],
        [{ type: 'text', chunks: ['父会话收尾。'] }],
      ],
      // 子代理慢慢说：父线程里的条目一出来就订阅子线程，看它跑着的事件推不推过来
      CHILD: [[{ type: 'text', chunks: SLOW, delayMs: 150 }]],
      DIRECT: [[{ type: 'text', chunks: ['直接回你。'] }]],
    }),
  )
  try {
    const desktop = client(env.server)
    await desktop.initialize()
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('SPAWN 派一个'),
    })
    // 子代理还在跑的时候就打开子线程：之后的事件照常投影给订阅者
    const spawning = await desktop.until(
      'item/started',
      (p) => p.threadId === thread.id && p.item.type === 'collabAgentToolCall',
      60000,
    )
    const running = spawning.item.receiverThreadIds[0]
    const live = await desktop.call('thread/resume', { threadId: running })
    assert.equal(live.thread.status.type, 'active', '打开时子线程正在跑')
    const childDone = await desktop.until('turn/completed', (p) => p.threadId === running, 60000)
    assert.equal(childDone.turn.status, 'completed')
    assert.ok(
      desktop.of('item/agentMessage/delta', running).length > 0,
      '子线程跑着时的流式事件推给了订阅者',
    )
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 90000)).turn
    assert.equal(done.status, 'completed')
    const agent = done.items.find((item: any) => item.type === 'collabAgentToolCall')
    assert.ok(
      agent,
      `父回合里有派子代理的条目：${JSON.stringify(done.items.map((i: any) => i.type))}`,
    )
    assert.equal(agent.tool, 'spawnAgent')
    assert.equal(agent.status, 'completed')
    assert.equal(agent.senderThreadId, thread.id)
    assert.equal(agent.prompt, 'CHILD 去查')
    assert.equal(agent.receiverThreadIds.length, 1)
    const childId = agent.receiverThreadIds[0]
    assert.match(childId, /^ses_/)
    assert.deepEqual(agent.agentsStates, {
      [childId]: { status: 'completed', message: RESULT },
    })
    // 条目一出来（item/started）就指向子线程
    const started = desktop.of('item/started', thread.id).find((p) => p.item.id === agent.id)?.item
    assert.deepEqual(started?.receiverThreadIds, [childId])
    assert.deepEqual(started?.agentsStates, { [childId]: { status: 'running', message: null } })

    // 子线程：带父子关系和子代理的种类，读得到子代理那一轮
    const listed = await desktop.call('thread/list', { parentThreadId: thread.id })
    assert.deepEqual(
      listed.data.map((entry: any) => entry.id),
      [childId],
    )
    const read = (await desktop.call('thread/read', { threadId: childId, includeTurns: true }))
      .thread
    assert.equal(read.parentThreadId, thread.id)
    assert.equal(read.threadSource, 'subagent')
    assert.equal(read.agentNickname, 'general')
    assert.equal(read.agentRole, 'general')
    assert.equal(read.canAcceptDirectInput, true)
    assert.ok(
      read.turns.some((entry: any) =>
        entry.items.some((item: any) => item.type === 'agentMessage' && item.text === RESULT),
      ),
      '子线程里有子代理的回答',
    )

    // 订阅子线程、直接对它说话：照常起回合、推事件
    const resumed = await desktop.call('thread/resume', { threadId: childId })
    assert.equal(resumed.thread.parentThreadId, thread.id)
    const direct = (
      await desktop.call('turn/start', { threadId: childId, input: text('DIRECT 再说') })
    ).turn
    const answered = (await desktop.until('turn/completed', (p) => p.turn.id === direct.id, 60000))
      .turn
    assert.equal(answered.status, 'completed')
    assert.equal(answered.items.at(-1)?.text, '直接回你。')
    assert.ok(
      desktop.of('item/agentMessage/delta', childId).some((p) => p.turnId === direct.id),
      '子线程的流式事件推给了订阅者',
    )
    // 直接对子线程发话时照子代理的默认：拿不到 task、todowrite
    const asked = env.model.requests.filter((body) => body.tools?.length).at(-1)
    const names = (asked?.tools ?? []).map((tool: any) => tool.function?.name)
    assert.ok(!names.includes('task') && !names.includes('todowrite'), names.join(', '))
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
