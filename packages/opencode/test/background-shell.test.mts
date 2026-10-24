import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import test from 'node:test'
import { serverName } from '../src/client-tools.mjs'
import { OpencodeServer } from '../src/server.mjs'
import { client, isolate, skip, text } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 注入的后台 shell 走一遍 OpenCode 入口（真的 opencode serve 加回环上的假模型）：模型调 shell_start 起一条命令、
// 说一句收场；回合结束后命令自己跑完，入口把结果作为一段不显示的话（synthetic）交给 OpenCode，另开一轮，
// 记成后台任务唤醒的。守着：集合、来历只给声明了 backgroundTasks 的连接；唤醒的那一轮没有用户的话；
// 适配器重启后重读历史，唤醒的那一轮还是单独一轮、还带着来历；关着时模型看不到这几个工具。

const toolNames = (body: any): string[] =>
  (body?.tools ?? []).map((tool: any) => String(tool.function?.name ?? tool.name))
const said = (body: any, needle: string) => JSON.stringify(body?.messages ?? []).includes(needle)

const startName = { value: '' }

test('OpenCode：后台 shell 回合结束后跑完，自己开一轮；来历和集合只给声明过的连接，重启后还在', {
  skip,
  timeout: 180000,
}, async () => {
  const env = await isolate(
    scripted({
      BG: [
        [
          {
            type: 'tool',
            get name() {
              return startName.value
            },
            input: { command: 'sleep 1; echo bg-done', title: '演示' },
          },
        ],
        [{ type: 'text', chunks: ['已经在后台跑了。'] }],
      ],
      'litch-background-event': [[{ type: 'text', chunks: ['后台的跑完了。'] }]],
    }),
    { server: { backgroundShell: true } },
  )
  try {
    const litch = client(env.server, ['backgroundTasks'])
    const plain = client(env.server)
    await litch.initialize()
    await plain.initialize()
    const info = await litch.call('runtime/info', {})
    assert.equal(info.features.backgroundTasks, true)
    const { thread } = await litch.call('thread/start', { cwd: env.cwd })
    startName.value = `${serverName(thread.id)}_shell_start`
    await plain.call('thread/resume', { threadId: thread.id })
    const { turn } = await litch.call('turn/start', { threadId: thread.id, input: text('BG 跑') })
    await litch.until('turn/completed', (p) => p.turn.id === turn.id, 60000)
    const wake = (await litch.until('turn/completed', (p) => p.turn.id !== turn.id, 60000)).turn
    assert.equal(wake.litchOrigin, 'backgroundTask')
    assert.equal(
      wake.items.some((item: any) => item.type === 'userMessage'),
      false,
      '唤醒的一轮没有用户的话',
    )
    assert.ok(
      env.model.requests.some((body) => toolNames(body).includes(startName.value)),
      '模型看得到工具',
    )
    const woke = env.model.requests.find((body) => said(body, '<litch-background-event>'))
    assert.ok(woke, '唤醒时模型拿到了结果')
    assert.ok(said(woke, 'bg-done'))
    // 起命令的那次调用画成动态工具条目
    const first = (await litch.call('thread/read', { threadId: thread.id, includeTurns: true }))
      .thread
    const item = first.turns[0].items.find((entry: any) => entry.type === 'dynamicToolCall')
    assert.equal(item?.namespace, 'litch_shell')
    assert.equal(item?.tool, 'start')
    assert.equal(first.litchBackground.tasks[0].status, 'completed')
    assert.equal(first.litchBackground.tasks[0].itemId, item.id)
    assert.equal(first.turns.at(-1).litchOrigin, 'backgroundTask')
    // 没声明的连接：没有集合通知，回合不带来历
    assert.equal(plain.of('litch/thread/background/changed').length, 0)
    for (const done of plain.of('turn/completed')) assert.equal(done.turn.litchOrigin, undefined)
    const plainRead = (await plain.call('thread/read', { threadId: thread.id, includeTurns: true }))
      .thread
    assert.equal(plainRead.litchBackground, undefined)
    assert.equal(plainRead.turns.at(-1).litchOrigin, undefined)
    const states = litch
      .of('litch/thread/background/changed', thread.id)
      .map((p) => p.tasks[0]?.status)
    assert.equal(states[0], 'running')
    assert.equal(states.at(-1), 'completed')

    // 适配器重启：从 OpenCode 重读历史，唤醒的那一轮单独成一轮、带着来历；集合只在内存里，没了
    await env.server.close()
    const again = new OpencodeServer(env.home, { backgroundShell: true })
    try {
      const reader = client(again, ['backgroundTasks'])
      await reader.initialize()
      const read = (await reader.call('thread/read', { threadId: thread.id, includeTurns: true }))
        .thread
      assert.equal(read.turns.length, 2)
      assert.equal(read.turns[0].litchOrigin, undefined)
      assert.equal(read.turns[1].litchOrigin, 'backgroundTask')
      assert.equal(
        read.turns[1].items.some((entry: any) => entry.type === 'userMessage'),
        false,
      )
      assert.equal(read.litchBackground, undefined)
    } finally {
      await again.close()
    }
  } finally {
    await env.restore()
  }
})

test('OpenCode：用户停掉的不唤醒，下一轮作为不显示的一段交给模型一次', {
  skip,
  timeout: 180000,
}, async () => {
  const env = await isolate(
    scripted({
      BG: [
        [
          {
            type: 'tool',
            get name() {
              return startName.value
            },
            input: { command: 'sleep 30' },
          },
        ],
        [{ type: 'text', chunks: ['在跑了。'] }],
      ],
      NEXT: [[{ type: 'text', chunks: ['知道了。'] }]],
      AGAIN: [[{ type: 'text', chunks: ['好。'] }]],
    }),
    { server: { backgroundShell: true } },
  )
  try {
    const litch = client(env.server, ['backgroundTasks'])
    await litch.initialize()
    const { thread } = await litch.call('thread/start', { cwd: env.cwd })
    startName.value = `${serverName(thread.id)}_shell_start`
    const { turn } = await litch.call('turn/start', { threadId: thread.id, input: text('BG 跑') })
    await litch.until('turn/completed', (p) => p.turn.id === turn.id, 60000)
    const listed = await litch.call('thread/backgroundTerminals/list', { threadId: thread.id })
    assert.equal(listed.data.length, 1)
    const stopped = await litch.call('thread/backgroundTerminals/terminate', {
      threadId: thread.id,
      processId: listed.data[0].processId,
    })
    assert.equal(stopped.terminated, true)
    await litch.until(
      'litch/thread/background/changed',
      (p) => p.tasks[0]?.status === 'stopped',
      10000,
    )
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(litch.of('turn/completed').length, 1, '没有唤醒')
    const notices = (body: any) =>
      JSON.stringify(body?.messages ?? []).split('was stopped by the user').length - 1
    const next = await litch.call('turn/start', { threadId: thread.id, input: text('NEXT') })
    await litch.until('turn/completed', (p) => p.turn.id === next.turn.id, 60000)
    assert.equal(notices(env.model.requests.at(-1)), 1)
    const again = await litch.call('turn/start', { threadId: thread.id, input: text('AGAIN') })
    await litch.until('turn/completed', (p) => p.turn.id === again.turn.id, 60000)
    assert.equal(notices(env.model.requests.at(-1)), 1, '记在历史里，不重复加')
    // 画出来的用户的话里没有这段
    const read = (await litch.call('thread/read', { threadId: thread.id, includeTurns: true }))
      .thread
    assert.doesNotMatch(JSON.stringify(read.turns), /stopped by the user/)
  } finally {
    await env.restore()
  }
})

test('OpenCode：后台 shell 关着时模型看不到这几个工具', { skip, timeout: 120000 }, async () => {
  const env = await isolate(scripted({ HI: [[{ type: 'text', chunks: ['好。'] }]] }))
  try {
    const litch = client(env.server, ['backgroundTasks'])
    await litch.initialize()
    const info = await litch.call('runtime/info', {})
    assert.equal(info.features.backgroundTasks, undefined)
    const { thread } = await litch.call('thread/start', { cwd: env.cwd })
    const { turn } = await litch.call('turn/start', { threadId: thread.id, input: text('HI') })
    await litch.until('turn/completed', (p) => p.turn.id === turn.id, 60000)
    for (const body of env.model.requests)
      assert.equal(
        toolNames(body).some((name) => name.includes('shell_start')),
        false,
      )
  } finally {
    await env.restore()
  }
})

test('OpenCode：后台命令要在项目外跑时照 OpenCode 的默认先问；拒了不起命令，模型拿到拒绝', {
  skip,
  timeout: 180000,
}, async () => {
  const outside = { value: '' }
  const env = await isolate(
    scripted({
      OUT: [
        [
          {
            type: 'tool',
            get name() {
              return startName.value
            },
            get input() {
              return { command: 'echo outside', cwd: outside.value }
            },
          },
        ],
        [{ type: 'text', chunks: ['那就不跑了。'] }],
      ],
    }),
    { server: { backgroundShell: true } },
  )
  try {
    const litch = client(env.server, ['backgroundTasks'])
    await litch.initialize()
    const asked: any[] = []
    litch.onRequest((request) => {
      asked.push(request)
      return request.method === 'item/commandExecution/requestApproval'
        ? { decision: 'decline' }
        : {}
    })
    const { thread } = await litch.call('thread/start', { cwd: env.cwd })
    startName.value = `${serverName(thread.id)}_shell_start`
    outside.value = dirname(thread.cwd)
    const { turn } = await litch.call('turn/start', { threadId: thread.id, input: text('OUT 跑') })
    await litch.until('turn/completed', (p) => p.turn.id === turn.id, 60000)
    assert.equal(asked.length, 1)
    assert.equal(asked[0].method, 'item/commandExecution/requestApproval')
    assert.match(asked[0].params.command, /^external_directory: /)
    assert.ok(asked[0].params.command.includes(outside.value))
    // 没起命令；模型拿到的工具结果是拒绝
    assert.deepEqual(env.server.shells?.list(thread.id), [])
    const after = env.model.requests.at(-1)
    assert.ok(said(after, 'denied by user'))
  } finally {
    await env.restore()
  }
})
