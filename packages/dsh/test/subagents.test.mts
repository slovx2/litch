import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// dsh 的子代理（决 274）：subagent 工具映射成子代理条目（collabAgentToolCall，spawnAgent），接收方是子代理的会话号；
// 子代理的会话按派它的会话的地址打开（普通地址 dsh 报 session/agent-busy），后台可继续的能经 subagents/prompt
// 接着发消息，跑完就结束的不能；dsh 自己分叉出来的会话记 forkedFromId，不当子代理藏起来。
// 这几处的前提是对着 dsh 0.2.0-rc.2 实测的：subagent 默认后台、可继续，结果是“started subagent <号>”，
// 派它的会话里先记一条 subagent/catalog；run_in_background 为 false 时前台跑完、结果就是子代理的回答。

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
const respond = scripted({
  SPAWN: [
    [
      {
        type: 'tool_use',
        name: 'subagent',
        input: { description: 'probe child', prompt: 'CHILDTASK 做事' },
      },
    ],
    [{ type: 'text', chunks: ['派出去了。'] }],
  ],
  SOLO: [
    [
      {
        type: 'tool_use',
        name: 'subagent',
        input: {
          description: 'once child',
          prompt: 'CHILDONCE 做完就走',
          run_in_background: false,
        },
      },
    ],
    [{ type: 'text', chunks: ['它做完了。'] }],
  ],
  CHILDTASK: [[{ type: 'text', chunks: ['子代理完成'] }]],
  CHILDONCE: [[{ type: 'text', chunks: ['一次就完'] }]],
  MORE: [[{ type: 'text', chunks: ['子代理第二次'] }]],
  LINGER: [[{ type: 'text', chunks: Array.from({ length: 60 }, () => '慢'), delayMs: 100 }]],
})

const spawned = (turn: any) =>
  turn.items.find((item: any) => item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent')

async function eventually<T>(probe: () => Promise<T | null | undefined>, what: string): Promise<T> {
  for (let waited = 0; waited < 30000; waited += 100) {
    const value = await probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`等${what}超时`)
}

test('dsh 子代理：派出去是子代理条目、接收方是子会话号；子会话按父地址打开、可继续的能接着发消息；分叉不当子代理', {
  timeout: 300000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const parent = (await desktop.call('thread/start', { cwd: env.cwd })).thread.id
    const { turn } = await desktop.call('turn/start', {
      threadId: parent,
      input: text('SPAWN 派一个'),
    })
    const done = await desktop.until(
      'turn/completed',
      (params) => params.threadId === parent && params.turn.id === turn.id,
    )
    const item = spawned(done.turn)
    const child = item?.receiverThreadIds?.[0]
    assert.equal(typeof child, 'string')
    assert.deepEqual(item, {
      type: 'collabAgentToolCall',
      id: item.id,
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: parent,
      receiverThreadIds: [child],
      prompt: 'CHILDTASK 做事',
      model: null,
      reasoningEffort: null,
      agentsStates: { [child]: { status: 'running', message: null } },
    })
    // 子代理跑完，dsh 替父会话开一个回合把结果告诉模型（没有发起的连接），订阅着的照样收到
    await desktop.until(
      'turn/completed',
      (params) => params.threadId === parent && params.turn.id !== turn.id,
    )

    // 线程列表：默认不列子代理，按父会话问才列；它是子代理、能接着对话、昵称是派它时的标签
    const listed = await desktop.call('thread/list', { limit: 50 })
    assert.deepEqual(
      listed.data.map((thread: any) => thread.id),
      [parent],
    )
    const children = await desktop.call('thread/list', { limit: 50, parentThreadId: parent })
    assert.deepEqual(
      children.data.map((thread: any) => thread.id),
      [child],
    )
    const row = children.data[0]
    assert.deepEqual(
      [
        row.parentThreadId,
        row.forkedFromId,
        row.threadSource,
        row.canAcceptDirectInput,
        row.agentNickname,
      ],
      [parent, null, 'subagent', true, 'probe child'],
    )
    assert.deepEqual(row.source, {
      subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1 } },
    })
    const bySource = await desktop.call('thread/list', {
      limit: 50,
      sourceKinds: ['subAgentThreadSpawn'],
    })
    assert.deepEqual(
      bySource.data.map((thread: any) => thread.id),
      [child],
    )

    // 子会话读得出来（dsh 只让按父会话的地址跟随）
    const read = await desktop.call('thread/read', { threadId: child, includeTurns: true })
    assert.equal(read.thread.parentThreadId, parent)
    assert.deepEqual(
      read.thread.turns.flatMap((one: any) =>
        one.items
          .filter((entry: any) => entry.type === 'agentMessage')
          .map((entry: any) => entry.text),
      ),
      ['子代理完成'],
    )

    // 后台可继续的子代理能在它自己的会话里接着发消息（经 subagents/prompt）
    await desktop.call('thread/resume', { threadId: child })
    const more = await desktop.call('turn/start', { threadId: child, input: text('MORE 接着做') })
    const answered = await desktop.until(
      'turn/completed',
      (params) => params.threadId === child && params.turn.id === more.turn.id,
    )
    assert.equal(answered.turn.status, 'completed')
    assert.deepEqual(
      answered.turn.items
        .map((entry: any) => [entry.type, entry.text ?? null])
        .filter(([type]: any) => type !== 'reasoning'),
      [
        ['userMessage', null],
        ['agentMessage', '子代理第二次'],
      ],
    )

    // 打断子代理的回合：经派它的会话的地址（subagents/interruptByParent），dsh 那边真停下来
    const slow = await desktop.call('turn/start', { threadId: child, input: text('LINGER 慢慢说') })
    await desktop.until(
      'item/agentMessage/delta',
      (params) => params.threadId === child && params.turnId === slow.turn.id,
    )
    const asked = Date.now()
    await desktop.call('turn/interrupt', { threadId: child, turnId: slow.turn.id })
    const stopped = await desktop.until(
      'turn/completed',
      (params) => params.threadId === child && params.turn.id === slow.turn.id,
    )
    assert.equal(stopped.turn.status, 'interrupted')
    // 假模型要 6 秒才说完，适配器自己收尾要等 10 秒：这么快结束的是 dsh 停下来了
    assert.ok(Date.now() - asked < 4000, `打断用了 ${Date.now() - asked} 毫秒`)

    // dsh 自己分叉出来的会话：会话头也带 parentSession，但没有 origin。照普通会话列出来，记分叉来源
    const remote = await server.remote()
    const { sessionId: fork } = await remote.rpc('session/fork', { request: { sessionId: parent } })
    const all = await eventually(async () => {
      const page = await desktop.call('thread/list', { limit: 50 })
      return page.data.some((thread: any) => thread.id === fork) ? page : null
    }, '分叉出来的会话进列表')
    const forked = all.data.find((thread: any) => thread.id === fork)
    assert.deepEqual(
      [forked.parentThreadId, forked.forkedFromId, forked.threadSource, forked.source],
      [null, parent, 'user', 'appServer'],
    )
    const forkRead = await desktop.call('thread/read', { threadId: fork, includeTurns: false })
    assert.deepEqual([forkRead.thread.parentThreadId, forkRead.thread.forkedFromId], [null, parent])
    assert.deepEqual([...violations], [])
  } finally {
    await server.close()
    await env.restore()
  }
})

test('dsh 子代理：前台跑完就结束的子代理，条目带它的回答，会话读得出来但不能接着发消息', {
  timeout: 300000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const parent = (await desktop.call('thread/start', { cwd: env.cwd })).thread.id
    const { turn } = await desktop.call('turn/start', { threadId: parent, input: text('SOLO 派') })
    const done = await desktop.until(
      'turn/completed',
      (params) => params.threadId === parent && params.turn.id === turn.id,
    )
    const item = spawned(done.turn)
    const child = item?.receiverThreadIds?.[0]
    assert.equal(typeof child, 'string')
    assert.equal(item.status, 'completed')
    assert.equal(item.agentsStates[child].status, 'completed')
    assert.match(item.agentsStates[child].message ?? '', /一次就完/)

    const children = await desktop.call('thread/list', { limit: 50, parentThreadId: parent })
    assert.deepEqual(
      children.data.map((thread: any) => [
        thread.id,
        thread.canAcceptDirectInput,
        thread.agentNickname,
      ]),
      [[child, false, 'once child']],
    )
    const read = await desktop.call('thread/read', { threadId: child, includeTurns: true })
    assert.equal(read.thread.canAcceptDirectInput, false)
    await desktop.call('thread/resume', { threadId: child })
    await assert.rejects(
      desktop.call('turn/start', { threadId: child, input: text('还能说吗') }),
      (error: any) => error.code === -32602 && /不能接着对话/.test(error.message),
    )
    assert.deepEqual([...violations], [])
  } finally {
    await server.close()
    await env.restore()
  }
})
