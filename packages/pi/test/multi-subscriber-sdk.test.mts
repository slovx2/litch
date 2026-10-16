import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'
import { assertNotification, assertResponse, assertServerRequest } from './schema.mjs'

// 真实 Pi SDK 加本地假模型，两条连接同看一个会话（设计文档 03 第八节 A6）。
// 分发规则的细处在 multi-subscriber.test.mts 里对着服务对象测；这里看整轮过程。

type Reply = { text?: string; tools?: Array<{ name: string; args: unknown }> }

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'pi-multi-sdk-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(agentDir)
  await mkdir(cwd)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const requests: any[] = []
  const replies: Array<Reply | ((body: any) => Reply)> = []
  const http = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const step = replies.shift()
    if (!step) {
      res.writeHead(500).end()
      return
    }
    const reply = typeof step === 'function' ? step(body) : step
    const base = { id: `mock_${requests.length}`, object: 'chat.completion.chunk', created: 1 }
    const calls = reply.tools?.map((tool, index) => ({
      index,
      id: `call_${requests.length}_${index}`,
      type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.args) },
    }))
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      `data: ${JSON.stringify({ ...base, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(
      chunk(
        { role: 'assistant', ...(calls ? { tool_calls: calls } : { content: reply.text }) },
        null,
      ),
    )
    res.write(
      chunk({}, calls ? 'tool_calls' : 'stop', {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        gate: {
          baseUrl: `http://127.0.0.1:${(http.address() as any).port}/v1`,
          api: 'openai-completions',
          apiKey: 'test-only',
          models: [
            {
              id: 'gate',
              name: 'Gate',
              reasoning: false,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
  )
  const server = new PiServer(join(root, 'state'))
  const invalid: string[] = []
  const checked = (check: () => void) => {
    try {
      check()
    } catch (error) {
      invalid.push(String(error))
    }
  }
  let sequence = 0
  // 一条连接：服务端请求不自动回答，由用例决定谁先答。
  const connect = (id: string) => {
    const messages: any[] = []
    const peer: RpcPeer = {
      id,
      close() {},
      send(message: WireMessage) {
        const wire = message as any
        messages.push(wire)
        if (wire.method && wire.id === undefined)
          checked(() => assertNotification(wire.method, wire.params))
        if (wire.method && wire.id !== undefined)
          checked(() => assertServerRequest(wire.method, wire.params))
      },
    }
    const until = async (what: string, find: (m: any) => boolean): Promise<any> => {
      for (let waited = 0; waited < 20000; waited += 10) {
        const found = messages.find(find)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`${id} 等待超时：${what}`)
    }
    return {
      peer,
      messages,
      until,
      notifications: () => messages.filter((m) => m.method && m.id === undefined),
      requests: () => messages.filter((m) => m.method && m.id !== undefined),
      async ok(method: string, params: any = {}): Promise<any> {
        const requestId = ++sequence
        await server.handle(peer, { jsonrpc: '2.0', id: requestId, method, params })
        const reply = messages.find((m) => m.id === requestId && !m.method)
        assert.equal(reply?.error, undefined, `${method}: ${JSON.stringify(reply?.error)}`)
        assertResponse(method, reply.result)
        return reply.result
      },
      answer: (request: any, result: unknown) =>
        server.handle(peer, { jsonrpc: '2.0', id: request.id, result } as any),
      completed: (turnId: string) =>
        until(
          `回合 ${turnId} 结束`,
          (m) => m.method === 'turn/completed' && m.params.turn.id === turnId,
        ),
    }
  }
  return {
    cwd,
    server,
    requests,
    replies,
    invalid,
    connect,
    async dispose() {
      await server.close()
      await new Promise((resolve) => http.close(resolve))
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      await rm(root, { recursive: true, force: true })
    },
  }
}

const text = (value: string) => [{ type: 'text', text: value }]

// 上游发给所有连接的会话级通知（rust-v0.162.0-alpha.20 里经全局的 OutgoingMessageSender 发的那些），
// 没订阅、没读过这个会话的连接也靠它们跟着别处的会话变（侧栏上的状态记号、名字、归档）。
// 回合、条目、设置、用量、队列、服务端请求的结果只给订阅者。这里写成字面的，不引用实现里的那一份。
const EVERYONE = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/name/updated',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
  'thread/deleted',
  'thread/reverted',
  'thread/project/updated',
  'thread/attachment/updated',
])
const about = (m: any): string | undefined => m.params?.threadId ?? m.params?.thread?.id

test('MULTI-PI-SDK：两条连接同看一个会话，通知逐条相同；提问两边都到，先答的生效；断开与退订互不影响', {
  timeout: 60000,
}, async () => {
  const h = await harness()
  try {
    const desktop = h.connect('desktop')
    const mobile = h.connect('mobile')
    // 发起回合的这条声明了 planConfirmation（和 Litch 一样）：计划插件交了计划之后的那一问才在回合里问，
    // 下面拿它看第二道提问怎么分发。没声明的话引擎不问，由客户端在回合结束后自己问
    await desktop.ok('initialize', {
      clientInfo: { name: 'desktop', version: '0' },
      capabilities: { litchExtensions: ['planConfirmation'] },
    })
    await mobile.ok('initialize')
    const threadId = (await desktop.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread
      .id
    await mobile.ok('thread/resume', { threadId })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const mark = { desktop: desktop.messages.length, mobile: mobile.messages.length }
    const since = (who: typeof desktop, from: number) =>
      who.messages.slice(from).filter((m) => m.method && m.id === undefined)

    // 计划模式里模型向用户提问：两条连接都收到同一条请求。
    h.replies.push(
      {
        tools: [
          {
            name: 'plan_mode_question',
            args: {
              questions: [
                {
                  id: 'choice',
                  header: 'Protocol',
                  question: 'Protocol choice?',
                  options: [
                    { label: 'Native Pi', description: 'Keep native engine' },
                    { label: 'Other', description: 'Alternative' },
                  ],
                },
              ],
            },
          },
        ],
      },
      (body) => {
        assert.match(JSON.stringify(body.messages), /Native Pi/, '模型拿到的是先答的那一个')
        return { tools: [{ name: 'plan_mode_complete', args: { plan: '# Plan\nUse Pi.' } }] }
      },
    )
    const plan = await desktop.ok('turn/start', {
      threadId,
      input: text('plan'),
      collaborationMode: { mode: 'plan' },
    })
    const asked = await desktop.until('提问', (m) => m.method === 'item/tool/requestUserInput')
    assert.deepEqual(mobile.requests(), [asked], '没发起回合的连接收到同一条提问，请求号相同')
    // 每道题选第 index 个选项；index 为 null 表示不答。
    const pick = (request: any, index: number | null) => ({
      answers: Object.fromEntries(
        request.params.questions.map((q: any) => [
          q.id,
          { answers: index === null ? [] : [q.options[index].label] },
        ]),
      ),
    })
    assert.match(asked.params.questions[0].options[0].label, /Native Pi/)
    // 没发起回合的那条先答；发起的那条随后答了别的，被丢弃。
    await mobile.answer(asked, pick(asked, 0))
    await desktop.answer(asked, pick(asked, 1))
    // 计划写好之后插件问下一步：这回发起回合的那条先答（留在计划模式），另一条的迟到应答同样被丢弃。
    const next = await mobile.until(
      '计划的下一步',
      (m) => m.method === 'item/tool/requestUserInput' && m.id !== asked.id,
    )
    assert.deepEqual(desktop.requests(), [asked, next])
    await desktop.answer(next, pick(next, null))
    await mobile.answer(next, pick(next, 0))
    assert.equal((await desktop.completed(plan.turn.id)).params.turn.status, 'completed')
    await mobile.completed(plan.turn.id)
    assert.equal(h.requests.length, 2, '迟到的应答没有让模型多跑一轮')
    assert.deepEqual(
      since(mobile, mark.mobile),
      since(desktop, mark.desktop),
      '同一个回合的通知两条连接逐条相同',
    )
    for (const who of [desktop, mobile])
      assert.deepEqual(
        who.notifications().filter((m) => m.method === 'serverRequest/resolved'),
        [asked, next].map((request) => ({
          method: 'serverRequest/resolved',
          params: { threadId, requestId: request.id },
        })),
      )

    // 先订阅的连接断开：后订阅的照常发起回合、收到全部通知。
    h.server.closePeer(desktop.peer)
    const quiet = desktop.messages.length
    h.replies.push({ text: '第二轮' })
    const second = await mobile.ok('turn/start', {
      threadId,
      input: text('again'),
      collaborationMode: { mode: 'default' },
    })
    assert.equal((await mobile.completed(second.turn.id)).params.turn.status, 'completed')
    assert.equal(desktop.messages.length, quiet, '断开的连接不再收到任何东西')

    // 换一条连接进来再退订：退订的不再收到回合和条目，留下的照常。
    const tablet = h.connect('tablet')
    await tablet.ok('initialize')
    await tablet.ok('thread/resume', { threadId })
    assert.deepEqual(await mobile.ok('thread/unsubscribe', { threadId }), {
      status: 'unsubscribed',
    })
    const silent = mobile.messages.length
    h.replies.push({ text: '第三轮' })
    const third = await tablet.ok('turn/start', { threadId, input: text('third') })
    assert.equal((await tablet.completed(third.turn.id)).params.turn.status, 'completed')
    // 会话级的那几种（状态变了）和上游一样照样发给退订了的连接，回合和条目的不再给它
    const after = mobile.messages.slice(silent).map((m) => m.method)
    assert.ok(after.includes('thread/status/changed'), `${after}`)
    assert.deepEqual(
      after.filter((method) => !EVERYONE.has(method)),
      [],
      '退订之后不再收到回合和条目的通知',
    )
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})

// 上游的 thread/read 只读不订阅（带不带 includeTurns 都一样），订阅靠 thread/start、thread/resume 这些。
// 官方桌面端找一个置顶会话在哪台机器上时，拿会话号向每个入口都读一遍：读一下就订阅的话，这条连接之后平白收这个会话的全部通知。
test('MULTI-PI-SDK-002：只 thread/read 过的连接不算订阅，收不到回合和条目的通知，thread/resume 过的照收', {
  timeout: 60000,
}, async () => {
  const h = await harness()
  try {
    const owner = h.connect('owner')
    const reader = h.connect('reader')
    const resumer = h.connect('resumer')
    for (const each of [owner, reader, resumer]) await each.ok('initialize')
    const threadId = (await owner.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    // 先跑一轮，读到的是有内容的会话
    h.replies.push({ text: '第一轮' })
    const first = await owner.ok('turn/start', { threadId, input: text('first') })
    await owner.completed(first.turn.id)
    for (const includeTurns of [true, false])
      assert.equal((await reader.ok('thread/read', { threadId, includeTurns })).thread.id, threadId)
    await resumer.ok('thread/resume', { threadId })
    const quiet = reader.messages.length
    h.replies.push({ text: '第二轮' })
    const second = await owner.ok('turn/start', { threadId, input: text('second') })
    for (const each of [owner, resumer]) await each.completed(second.turn.id)
    // 会话级的那几种（状态变了）发给所有连接，回合和条目的不给它
    const read = reader.messages.slice(quiet).map((m) => m.method)
    assert.ok(read.includes('thread/status/changed'), `${read}`)
    assert.deepEqual(
      read.filter((method) => !EVERYONE.has(method)),
      [],
      '只读过的连接不该收到回合和条目的通知',
    )
    assert.deepEqual(await reader.ok('thread/unsubscribe', { threadId }), {
      status: 'notSubscribed',
    })
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})

test('MULTI-PI-SDK-003：没订阅、没读过的连接照样收到会话的新建、状态、改名、归档、删除，收不到回合和条目；临时会话的不给它', {
  timeout: 60000,
}, async () => {
  const h = await harness()
  try {
    const owner = h.connect('owner')
    const bystander = h.connect('bystander')
    for (const each of [owner, bystander]) await each.ok('initialize')
    const threadId = (await owner.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    await bystander.until(
      '新会话',
      (m) => m.method === 'thread/started' && m.params.thread.id === threadId,
    )
    h.replies.push({ text: '别处在跑' })
    const turn = await owner.ok('turn/start', { threadId, input: text('hi') })
    await owner.completed(turn.turn.id)
    await owner.ok('thread/name/set', { threadId, name: '别处改的名字' })
    await owner.ok('thread/archive', { threadId })
    await owner.ok('thread/unarchive', { threadId })
    // 临时会话（官方桌面端起标题用的）不进列表，它的通知只给建它的连接
    const helper = (
      await owner.ok('thread/start', { cwd: h.cwd, model: 'gate/gate', ephemeral: true })
    ).thread.id
    await owner.until(
      '临时会话开始',
      (m) => m.method === 'thread/started' && m.params.thread.id === helper,
    )
    await owner.ok('thread/delete', { threadId })
    await bystander.until(
      '删除',
      (m) => m.method === 'thread/deleted' && m.params.threadId === threadId,
    )
    const seen = bystander.notifications().filter((m) => about(m) === threadId)
    for (const m of seen) assert.ok(EVERYONE.has(m.method), `没订阅的连接不该收到 ${m.method}`)
    const statuses = seen
      .filter((m) => m.method === 'thread/status/changed')
      .map((m) => m.params.status.type)
    assert.ok(statuses.includes('active') && statuses.at(-1) === 'idle', `状态：${statuses}`)
    // 改一次名只有一条（上游也是），改名的那条连接上也是
    for (const who of [owner, bystander])
      assert.deepEqual(
        who
          .notifications()
          .filter((m) => m.method === 'thread/name/updated' && about(m) === threadId)
          .map((m) => m.params.threadName),
        ['别处改的名字'],
        who.peer.id,
      )
    for (const method of ['thread/archived', 'thread/unarchived', 'thread/deleted'])
      assert.equal(seen.filter((m) => m.method === method).length, 1, method)
    assert.deepEqual(
      bystander.notifications().filter((m) => about(m) === helper),
      [],
      '临时会话的通知不给别的连接',
    )
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})

// 上游分叉出来的会话和新建的一样发 thread/started（rust-v0.162.0-alpha.20 的 thread_processor.rs，thread/fork 那一段）：
// 应答之后、发给所有连接，会话对象就是应答里的那份、不带回合。没订阅的连接靠它知道多了一个会话。
test('MULTI-PI-SDK-004：分叉出来的会话发 thread/started，在应答之后，所有连接都收到，不带回合', {
  timeout: 60000,
}, async () => {
  const h = await harness()
  try {
    const owner = h.connect('owner')
    const bystander = h.connect('bystander')
    for (const each of [owner, bystander]) await each.ok('initialize')
    const threadId = (await owner.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    h.replies.push({ text: '第一轮' })
    const turn = await owner.ok('turn/start', { threadId, input: text('hi') })
    await owner.completed(turn.turn.id)
    await owner.ok('thread/name/set', { threadId, name: '源会话' })
    const reply = owner.messages.length
    const forked = await owner.ok('thread/fork', { threadId })
    assert.equal(forked.thread.forkedFromId, threadId)
    assert.equal(forked.thread.turns.length, 1, '前提：应答里带着回合')
    const started = (who: typeof owner) =>
      who.until(
        '分叉的 thread/started',
        (m) => m.method === 'thread/started' && m.params.thread.id === forked.thread.id,
      )
    // 参数顶层多一份 threadId 是新建时就有的出入（兼容基线里记着），这里只看会话对象
    for (const who of [owner, bystander])
      assert.deepEqual((await started(who)).params.thread, { ...forked.thread, turns: [] })
    // 在应答之后
    const after = owner.messages.slice(reply)
    assert.ok(
      after.findIndex((m) => m.result === forked) <
        after.findIndex((m) => m.method === 'thread/started'),
    )
    for (const who of [owner, bystander])
      assert.equal(
        who
          .notifications()
          .filter((m) => m.method === 'thread/started' && about(m) === forked.thread.id).length,
        1,
      )
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})

// 上游在卸载会话时发 thread/closed（rust-v0.162.0-alpha.20 的 thread_lifecycle.rs，unload_thread_without_subscribers）：
// 会话没有订阅者、也不在跑了，过一阵（默认 60 秒）就把它关掉，发给所有连接。Pi 入口对应的是释放原生会话
//（releaseUnused：没有订阅者、闲着就当场释放），所以在那时发。只是为了改名这类事临时载入、从没被订阅过的不发；
// 删掉的会话只发 thread/deleted（上游也是）。
test('MULTI-PI-SDK-005：最后一个订阅者退订或断开、会话释放时发 thread/closed，所有连接都收到；没订阅过的、删掉的不发', {
  timeout: 60000,
}, async () => {
  const h = await harness()
  try {
    const owner = h.connect('owner')
    const bystander = h.connect('bystander')
    for (const each of [owner, bystander]) await each.ok('initialize')
    const threadId = (await owner.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    h.replies.push({ text: '第一轮' })
    const turn = await owner.ok('turn/start', { threadId, input: text('hi') })
    await owner.completed(turn.turn.id)
    const closed = (who: typeof owner, id = threadId) =>
      who.notifications().filter((m) => m.method === 'thread/closed' && about(m) === id)
    assert.deepEqual(closed(bystander), [], '还有订阅者时不发')

    // 退订：会话释放了，两条连接都收到一条
    assert.deepEqual(await owner.ok('thread/unsubscribe', { threadId }), { status: 'unsubscribed' })
    for (const who of [owner, bystander])
      await who.until('thread/closed', (m) => m.method === 'thread/closed' && about(m) === threadId)
    assert.deepEqual(closed(bystander), [{ method: 'thread/closed', params: { threadId } }])
    assert.equal((await owner.ok('thread/loaded/list')).data.includes(threadId), false)

    // 再打开、这回断开连接：留下的那条收到第二条
    await owner.ok('thread/resume', { threadId })
    h.server.closePeer(owner.peer)
    await bystander.until(
      '第二条 thread/closed',
      (m) =>
        m.method === 'thread/closed' && about(m) === threadId && closed(bystander).length === 2,
    )
    assert.equal(closed(owner).length, 1, '断开的连接不再收到')

    // 只为改名载入、没被订阅过：释放了也不发（释放是请求应答之后的事，等它释放完）
    await bystander.ok('thread/name/set', { threadId, name: '改个名' })
    for (let waited = 0; ; waited += 10) {
      if (!(await bystander.ok('thread/loaded/list')).data.includes(threadId)) break
      assert.ok(waited < 10000, '改名之后会话一直没释放')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // 删掉的：只发 thread/deleted
    const other = h.connect('other')
    await other.ok('initialize')
    await other.ok('thread/resume', { threadId })
    await other.ok('thread/delete', { threadId })
    h.server.closePeer(other.peer)
    await bystander.until('删除', (m) => m.method === 'thread/deleted' && about(m) === threadId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(closed(bystander).length, 2)
    assert.deepEqual(h.invalid, [], '往来消息必须符合协议 schema')
  } finally {
    await h.dispose()
  }
})
