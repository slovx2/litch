import assert from 'node:assert/strict'
import test from 'node:test'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

// 事件流半路断了：适配器重连，连上之后把打开着的会话从 OpenCode 重读一遍，漏掉的照常补发、发过的不重发。
test('OpenCode：事件流断线重连后补齐，回合照常收尾、文字不重不漏', {
  skip,
  timeout: 120000,
}, async () => {
  const chunks = Array.from({ length: 40 }, (_, i) => `字${i} `)
  const env = await isolate(scripted({ SLOW: [[{ type: 'text', chunks, delayMs: 50 }]] }))
  try {
    const desktop = client(env.server)
    await desktop.initialize()
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd })
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('SLOW 说'),
    })
    await desktop.until('item/agentMessage/delta', (p) => p.turnId === turn.id)
    // 掐断事件流（serve 还在），适配器自己重连
    ;(env.server.runtime as any).stream.abort()
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
    assert.equal(done.status, 'completed')
    const message = done.items.at(-1)
    assert.equal(message.text, chunks.join(''))
    const streamed = desktop
      .of('item/agentMessage/delta', thread.id)
      .filter((p) => p.itemId === message.id)
      .map((p) => p.delta)
      .join('')
    assert.equal(streamed, chunks.join(''), '逐字流补齐后和全文一致（断线那一段在结束时一次补上）')
    assert.equal(desktop.of('turn/completed', thread.id).length, 1)
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})

// 别的客户端（OpenCode 自己的界面、别的工具）直接对 OpenCode 发起的会话和回合：进线程清单，
// 打开之后它那边发起的回合照常投影成回合推给订阅的连接。
test('OpenCode：别处发起的会话进清单，打开后别处发起的回合照常推送', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      ELSEWHERE: [[{ type: 'text', chunks: ['别处的回答。'] }]],
      AGAIN: [[{ type: 'text', chunks: ['又一句。'] }]],
    }),
  )
  try {
    const desktop = client(env.server)
    await desktop.initialize()
    const api = await env.server.api()
    const options = { directory: env.cwd }
    const session = await api.request('POST', '/session', { ...options, body: {} })
    const idle = async () => {
      for (let waited = 0; waited < 30000; waited += 50) {
        const status = await api.request<any>('GET', '/session/status', options)
        if (!status?.[session.id]) return
        await pause(50)
      }
      throw new Error('别处的回合没跑完')
    }
    await api.request('POST', `/session/${session.id}/prompt_async`, {
      ...options,
      body: { parts: [{ type: 'text', text: 'ELSEWHERE 你好' }] },
    })
    await pause(200)
    await idle()
    const listed = await desktop.call('thread/list', {})
    const entry = listed.data.find((thread: any) => thread.id === session.id)
    assert.ok(entry, '别处的会话在清单里')
    assert.equal(entry.cwd, env.cwd)
    // 没打开过的别处会话，清单里只有 OpenCode 起的标题（预览要读消息才有，列清单时不读）
    assert.equal(entry.name, 'mock 标题')

    const resumed = await desktop.call('thread/resume', { threadId: session.id })
    assert.deepEqual(
      resumed.thread.turns.map((turn: any) => [
        turn.status,
        turn.items.map((item: any) => item.type),
      ]),
      [['completed', ['userMessage', 'agentMessage']]],
    )
    assert.equal(resumed.thread.preview, 'ELSEWHERE 你好')
    await api.request('POST', `/session/${session.id}/prompt_async`, {
      ...options,
      body: { parts: [{ type: 'text', text: 'AGAIN 再说' }] },
    })
    const started = await desktop.until('turn/started', (p) => p.threadId === session.id)
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === started.turn.id)).turn
    assert.equal(done.status, 'completed')
    assert.equal(done.items[0].content[0].text, 'AGAIN 再说')
    assert.equal(done.items.at(-1).text, '又一句。')
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
