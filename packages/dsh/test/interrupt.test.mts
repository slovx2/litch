import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 回合刚开始就打断。回合是适配器先建的，提示词随后才交给 dsh；dsh 的取消只停正在跑的回合。
// 此前 turn/start 的应答一到就发 turn/interrupt，取消先于提示词到了 dsh，它没有回合可停，
// 回合照常说完、以 completed 结束。话流出来之后再打断的情形在 adapter.test.mts 和 declaration.test.mts 里。
// 回合刚开始就插话是同一个毛病：插话先于提示词到了 dsh，它拿插话起了回合，原来那句成了后面另一个回合。

const text = (value: string) => [{ type: 'text', text: value }]
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// 记号 SLOW 的回合要说 8 秒：没打断成的话用例等得到它以 completed 结束。
const respond = scripted({
  SLOW: [[{ type: 'text', chunks: Array.from({ length: 80 }, (_, i) => `慢${i} `), delayMs: 100 }]],
  AFTER: [[{ type: 'text', chunks: ['接着说。'] }]],
  // 说一秒：插话是在这一步结束之后并进回合的
  FIRST: [
    [{ type: 'text', chunks: Array.from({ length: 10 }, (_, i) => `先${i} `), delayMs: 100 }],
  ],
  SECOND: [[{ type: 'text', chunks: ['插话收到。'] }]],
})

test('dsh：回合刚开始就打断也生效，回合以 interrupted 结束；之后会话照常能用，重新读出来的历史一致', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const home = join(env.root, 'home')
  let server = new DshServer(home)
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const threads: { id: string; turns: string[] }[] = []
    // null：应答一到紧接着就打断，这时提示词还没交给 dsh。
    // 别的是隔几毫秒：提示词正在路上、dsh 那边回合刚起来、第一步刚开始的各个时刻。
    for (const wait of [null, 0, 15, 40]) {
      const { thread } = await desktop.call('thread/start', {
        cwd: env.cwd,
        permissions: ':workspace',
      })
      const { turn } = await desktop.call('turn/start', {
        threadId: thread.id,
        input: text('SLOW 慢慢说。'),
      })
      if (wait !== null) await pause(wait)
      assert.deepEqual(
        await desktop.call('turn/interrupt', { threadId: thread.id, turnId: turn.id }),
        {},
      )
      const stopped = await desktop.until(
        'turn/completed',
        (params) => params.threadId === thread.id && params.turn.id === turn.id,
      )
      assert.equal(stopped.turn.status, 'interrupted', `隔 ${wait} 毫秒打断`)

      // 打断之后同一个会话接着用：dsh 那边没有留下还在跑的回合，也没有压着没发的提示词
      const next = await desktop.call('turn/start', {
        threadId: thread.id,
        input: text('AFTER 说一句话。'),
      })
      const finished = await desktop.until(
        'turn/completed',
        (params) => params.threadId === thread.id && params.turn.id === next.turn.id,
      )
      assert.equal(finished.turn.status, 'completed', `隔 ${wait} 毫秒打断之后的回合`)
      const said = finished.turn.items.filter((item: any) => item.type === 'agentMessage')
      assert.deepEqual(
        said.map((item: any) => item.text),
        ['接着说。'],
      )

      threads.push({ id: thread.id, turns: [turn.id, next.turn.id] })
    }

    // 适配器重启后从 dsh 重新读：两个回合、各自的结局，和刚才实时看到的一样
    await server.close()
    server = new DshServer(home)
    const again = client(server)
    await again.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    for (const thread of threads) {
      const read = await again.call('thread/read', { threadId: thread.id, includeTurns: true })
      assert.deepEqual(
        read.thread.turns.map((entry: any) => [entry.id, entry.status]),
        [
          [thread.turns[0], 'interrupted'],
          [thread.turns[1], 'completed'],
        ],
      )
    }
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})

test('dsh：提示词没交成的回合按失败结束，紧跟着的打断不挂住、也不把它改成 interrupted', {
  timeout: 120000,
}, async () => {
  const env = await isolate(respond)
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await desktop.call('thread/start', {
      cwd: env.cwd,
      permissions: ':workspace',
    })
    // 图片读不到：提示词在交给 dsh 之前就失败了
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'localImage', path: join(env.cwd, '没有这张图.png') }],
    })
    assert.deepEqual(
      await desktop.call('turn/interrupt', { threadId: thread.id, turnId: turn.id }),
      {},
    )
    const ended = await desktop.until('turn/completed', (params) => params.turn.id === turn.id)
    assert.equal(ended.turn.status, 'failed')
    assert.equal(
      desktop.notifications.filter((entry) => entry.method === 'turn/completed').length,
      1,
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})

test('dsh：回合刚开始就插话，插话并进这个回合、排在原来那句后面，不另起回合；提示词没交成的回合上插话如实拒绝', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    // 模型请求里第几条用户消息带着这句话；没有是 -1。dsh 会在用户的话旁边附上运行环境的说明，所以按包含找
    const asked = (body: any, mark: string): number =>
      (body.messages ?? [])
        .filter((message: any) => message.role === 'user')
        .findIndex((message: any) => JSON.stringify(message.content).includes(mark))
    // null：应答一到紧接着就插话，这时提示词还没交给 dsh。别的是隔几毫秒。
    for (const wait of [null, 0, 15]) {
      const { thread } = await desktop.call('thread/start', {
        cwd: env.cwd,
        permissions: ':workspace',
      })
      const seen = env.model.requests.length
      const { turn } = await desktop.call('turn/start', {
        threadId: thread.id,
        input: text('FIRST 第一句'),
      })
      if (wait !== null) await pause(wait)
      assert.deepEqual(
        await desktop.call('turn/steer', {
          threadId: thread.id,
          expectedTurnId: turn.id,
          input: text('SECOND 插一句'),
        }),
        { turnId: turn.id },
      )
      const done = await desktop.until(
        'turn/completed',
        (params) => params.threadId === thread.id && params.turn.id === turn.id,
      )
      assert.equal(done.turn.status, 'completed', `隔 ${wait} 毫秒插话`)

      // 还是那一个回合，两句话按说的先后在里面
      const read = await desktop.call('thread/read', { threadId: thread.id, includeTurns: true })
      assert.deepEqual(
        read.thread.turns.map((entry: any) =>
          entry.items.flatMap((item: any) =>
            item.type === 'userMessage'
              ? [item.content.map((part: any) => part.text).join('')]
              : item.type === 'agentMessage'
                ? [item.text]
                : [],
          ),
        ),
        [
          [
            'FIRST 第一句',
            Array.from({ length: 10 }, (_, i) => `先${i} `).join(''),
            'SECOND 插一句',
            '插话收到。',
          ],
        ],
        `隔 ${wait} 毫秒插话`,
      )
      // 模型那头也是：头一次请求里只有第一句，带着插话的那次第一句在前
      const requests = env.model.requests.slice(seen).filter((body) => body.tools?.length)
      assert.equal(asked(requests[0], 'SECOND'), -1)
      const last = requests.at(-1)
      assert.ok(asked(last, 'FIRST') >= 0 && asked(last, 'FIRST') < asked(last, 'SECOND'))
    }

    // 图片读不到：提示词在交给 dsh 之前就失败了，回合已经按失败收尾，没有回合可插
    const { thread } = await desktop.call('thread/start', {
      cwd: env.cwd,
      permissions: ':workspace',
    })
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'localImage', path: join(env.cwd, '没有这张图.png') }],
    })
    await assert.rejects(
      desktop.call('turn/steer', {
        threadId: thread.id,
        expectedTurnId: turn.id,
        input: text('SECOND 插一句'),
      }),
      (error: any) => error.code === -32009,
    )
    const ended = await desktop.until(
      'turn/completed',
      (params) => params.threadId === thread.id && params.turn.id === turn.id,
    )
    assert.equal(ended.turn.status, 'failed')
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})
