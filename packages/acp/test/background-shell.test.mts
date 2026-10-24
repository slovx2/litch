import assert from 'node:assert/strict'
import test from 'node:test'
import { Projection } from '../src/projection.mjs'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, scene, text, turn } from './client.mjs'

// 注入的后台 shell 在通用 ACP 入口（acp）上：经会话的 MCP 桥交给 agent、入口自己执行；命令在回合结束后跑完，
// 入口把结果作为一句话交给 agent，另开一轮，记成后台任务唤醒的。gemini、qwen 不带。
// 假 agent 收到“tool gemini <工具> <参数>”就调 MCP 工具，别的话回“收到：<原话>”（fake-agent.mts）。

const ON = { CHA_BACKGROUND_SHELL: '1' }

/** 一条声明了 backgroundTasks 的连接 */
async function litch(server: AcpServer) {
  const peer = client(server)
  await peer.call('initialize', {
    clientInfo: { name: 'litch', version: '0' },
    capabilities: { litchExtensions: ['backgroundTasks'] },
  })
  return peer
}

const start = (args: object) =>
  text(`tool gemini shell_start ${JSON.stringify({ command: 'sleep 0.5; echo bg-done', ...args })}`)

test('ACP：后台 shell 跑完另开一轮；来历、集合只给声明过的连接；重启后来历还在', async () => {
  const s = await scene(ON)
  try {
    const peer = await litch(s.server)
    const info = await peer.call('runtime/info', {})
    assert.equal(info.features.backgroundTasks, true)
    assert.ok(info.extensions.includes('backgroundTasks'))
    const { thread } = await peer.call('thread/start', { cwd: s.cwd })
    await s.desktop.call('thread/resume', { threadId: thread.id })
    const first = await turn(s, thread.id, start({ title: '演示' }))
    assert.match(JSON.stringify(first.items), /Started background task shell-1/)
    const item = first.items.find((entry: any) => entry.type === 'dynamicToolCall')
    assert.equal(item?.namespace, 'litch_shell')
    const wake = (await peer.until('turn/completed', (p) => p.turn.id !== first.id)).turn
    assert.equal(wake.litchOrigin, 'backgroundTask')
    assert.equal(
      wake.items.some((entry: any) => entry.type === 'userMessage'),
      false,
    )
    // agent 收到的那句话是结果
    const reply = wake.items.find((entry: any) => entry.type === 'agentMessage')?.text ?? ''
    assert.match(reply, /<litch-background-event>/)
    assert.match(reply, /bg-done/)
    // 没声明的连接
    for (const done of s.desktop.notifications.filter((m: any) => m.method === 'turn/completed'))
      assert.equal(done.params.turn.litchOrigin, undefined)
    assert.equal(
      s.desktop.notifications.some((m: any) => m.method === 'litch/thread/background/changed'),
      false,
    )
    const read = (await peer.call('thread/read', { threadId: thread.id, includeTurns: true }))
      .thread
    assert.equal(read.litchBackground.tasks[0].status, 'completed')
    assert.equal(read.litchBackground.tasks[0].title, '演示')
    assert.equal(read.litchBackground.tasks[0].itemId, item.id)
    assert.equal(read.turns.at(-1).litchOrigin, 'backgroundTask')
    const plain = (await s.desktop.call('thread/read', { threadId: thread.id, includeTurns: true }))
      .thread
    assert.equal(plain.litchBackground, undefined)
    assert.equal(plain.turns.at(-1).litchOrigin, undefined)

    // 重启：回合和来历从库里摆回来，集合只在内存里
    await s.server.close()
    const again = new AcpServer(s.home, s.env)
    try {
      const reader = await litch(again)
      const restored = (
        await reader.call('thread/read', { threadId: thread.id, includeTurns: true })
      ).thread
      assert.deepEqual(
        restored.turns.map((one: any) => one.litchOrigin ?? null),
        [null, 'backgroundTask'],
      )
      assert.equal(restored.litchBackground, undefined)
    } finally {
      await again.close()
    }
  } finally {
    await s.restore()
  }
})

test('ACP：用户停掉的不唤醒，下一轮接在用户的话后面告诉 agent 一次；backgroundTerminals 列得出、停得掉', async () => {
  const s = await scene(ON)
  try {
    const peer = await litch(s.server)
    const { thread } = await peer.call('thread/start', { cwd: s.cwd })
    await turn(s, thread.id, start({ command: 'sleep 30' }))
    const listed = await peer.call('thread/backgroundTerminals/list', { threadId: thread.id })
    assert.equal(listed.data.length, 1)
    assert.equal(listed.data[0].command, 'sleep 30')
    const stopped = await peer.call('thread/backgroundTerminals/terminate', {
      threadId: thread.id,
      processId: listed.data[0].processId,
    })
    assert.equal(stopped.terminated, true)
    await peer.until('litch/thread/background/changed', (p) => p.tasks[0]?.status === 'stopped')
    await new Promise((resolve) => setTimeout(resolve, 800))
    const completed = peer.notifications.filter((m: any) => m.method === 'turn/completed')
    assert.equal(completed.length, 1, '没有唤醒')
    // 用户的下一句：agent 收到的那句后面接着“被用户停了”，画出来的用户的话还是原话；只交一次
    const next = await turn(s, thread.id, text('接着'))
    const reply = next.items.find((entry: any) => entry.type === 'agentMessage')?.text ?? ''
    assert.match(reply, /^收到：接着\n\n<litch-background-notice>/)
    assert.match(reply, /shell-1 was stopped by the user after \d+s\. Command: sleep 30/)
    const user = next.items.find((entry: any) => entry.type === 'userMessage')
    assert.deepEqual(
      user.content.map((part: any) => part.text),
      ['接着'],
    )
    const after = await turn(s, thread.id, text('再说'))
    assert.doesNotMatch(JSON.stringify(after.items), /stopped by the user/)
  } finally {
    await dispose(s)
  }
})

test('ACP：acp 默认带后台 shell，不带动态工具的会话也挂 litch 的 MCP 服务', async () => {
  const s = await scene()
  try {
    assert.notEqual(s.server.shells, null)
    const peer = await litch(s.server)
    await peer.call('thread/start', { cwd: s.cwd })
    const created = (await s.received()).filter((m: any) => m.method === 'session/new')
    assert.equal(created.at(-1).params.mcpServers[0]?.name, 'litch')
  } finally {
    await dispose(s)
  }
})

test('ACP：gemini、qwen 不带后台 shell；acp 关着时也不带', async () => {
  for (const extra of [
    { ...ON, CHA_ACP_AGENT: 'gemini' },
    { ...ON, CHA_ACP_AGENT: 'qwen' },
    { CHA_BACKGROUND_SHELL: '0' },
  ]) {
    const s = await scene(extra)
    try {
      assert.equal(s.server.shells, null, JSON.stringify(extra))
    } finally {
      await dispose(s)
    }
  }
})

test('ACP：回放历史时，交给 agent 的后台结果另起一轮、记来历，不画成用户的话', () => {
  const projection = new Projection({
    id: 's1',
    cwd: '/tmp',
    name: null,
    preview: '',
    createdAt: 1,
    updatedAt: 2,
    forkedFromId: null,
    ephemeral: false,
  })
  const quiet = () => {}
  const user = (value: string) => ({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: value },
  })
  const agent = (value: string) => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: value },
  })
  projection.startReplay()
  projection.update(user('跑一下'), quiet)
  projection.update(agent('在跑了'), quiet)
  projection.update(user('<litch-background-event>\nBackground task shell-1 exited'), quiet)
  projection.update(user(' 后半段'), quiet)
  projection.update(agent('跑完了'), quiet)
  // agent 对后台结果什么都没说（出错了），紧跟着就是用户的下一句：不能被当成结果的后半段吞掉
  projection.update({ ...user('<litch-background-event>\nshell-2 exited'), messageId: 'm1' }, quiet)
  projection.update({ ...user('还有一句'), messageId: 'm2' }, quiet)
  projection.update(agent('好的'), quiet)
  projection.endReplay()
  assert.equal(projection.turns.length, 4)
  const [first, second, third, fourth] = projection.turns
  assert.equal(projection.origins.get(first?.id ?? ''), undefined)
  assert.equal(projection.origins.get(second?.id ?? ''), 'backgroundTask')
  assert.deepEqual(
    second?.items.map((item: any) => item.type),
    ['agentMessage'],
  )
  assert.equal(projection.origins.get(third?.id ?? ''), 'backgroundTask')
  assert.deepEqual(third?.items, [])
  assert.equal(projection.origins.get(fourth?.id ?? ''), undefined)
  assert.equal((fourth?.items[0] as any)?.content[0].text, '还有一句')
})

test('ACP：回放历史时，接在用户的话后面的“被用户停了”不另起一轮，照记下的整句找回原话', () => {
  const sent =
    '接着\n\n<litch-background-notice>\nBackground task shell-1 was stopped by the user after 3s. Command: sleep 30\n</litch-background-notice>'
  const projection = new Projection(
    {
      id: 's1',
      cwd: '/tmp',
      name: null,
      preview: '',
      createdAt: 1,
      updatedAt: 2,
      forkedFromId: null,
      ephemeral: false,
    },
    (value) =>
      value === sent
        ? { content: [{ type: 'text', text: '接着', text_elements: [] }], clientId: 'c1' }
        : null,
  )
  const quiet = () => {}
  projection.startReplay()
  projection.update(
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: sent } },
    quiet,
  )
  projection.update(
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } },
    quiet,
  )
  projection.endReplay()
  assert.equal(projection.turns.length, 1)
  assert.equal(projection.origins.get(projection.turns[0]?.id ?? ''), undefined)
  const user = projection.turns[0]?.items[0] as any
  assert.deepEqual(user.content, [{ type: 'text', text: '接着', text_elements: [] }])
  assert.equal(user.clientId, 'c1')
})
