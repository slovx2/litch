import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { SessionManager } from '../src/sdk.mjs'
import { PiServer } from '../src/server.mjs'
import { assertResponse } from './schema.mjs'

// 真实 Pi SDK 加本地假模型；每个用例独立的临时目录，结束时全部清掉。
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'pi-fork-'))
  const agentDir = join(root, 'agent'),
    cwd = join(root, 'project'),
    state = join(root, 'state')
  await mkdir(agentDir)
  await mkdir(cwd)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  // 假模型默认回一句带序号的话；scripted 里排队的步骤可以让某次请求失败或挂起。
  const requests: any[] = []
  const scripted: Array<(body: any) => unknown> = []
  const http = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const sequence = requests.length
    if ((await scripted.shift()?.(body)) === 'fail') {
      // 用 400：客户端库不会自动重试，这一轮确定以失败结束。
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '模拟的模型故障' } }))
      return
    }
    if (res.destroyed) return
    const base = {
      id: `mock_${sequence}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: `回答${sequence}` }, finish_reason: null }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
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
    JSON.stringify({
      defaultProvider: 'gate',
      defaultModel: 'gate',
      retry: { enabled: false },
      compaction: { keepRecentTokens: 0 },
    }),
  )
  let server = new PiServer(state)
  const messages: any[] = []
  const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void }> = []
  const peer: RpcPeer = {
    id: 'desktop',
    close() {},
    send(message: WireMessage) {
      messages.push(message)
      for (const waiter of [...waiters])
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(message)
        }
    },
  }
  let sequence = 0
  const call = async (method: string, params: any = {}) => {
    const id = ++sequence
    await server.handle(peer, { jsonrpc: '2.0', id, method, params })
    const reply = messages.find((m) => m.id === id && !m.method)
    assert.ok(reply, `缺少 ${method} 响应`)
    return reply
  }
  const ok = async (method: string, params: any = {}) => {
    const reply = await call(method, params)
    assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`)
    assertResponse(method, reply.result)
    return reply.result
  }
  const wait = (predicate: (m: any) => boolean): Promise<any> => {
    const existing = messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => waiters.push({ predicate, resolve }))
  }
  const completed = async (turnId: string) =>
    (await wait((m) => m.method === 'turn/completed' && m.params.turn.id === turnId)).params.turn
  const startTurn = async (threadId: string, text: string): Promise<string> =>
    (await ok('turn/start', { threadId, input: [{ type: 'text', text }] })).turn.id
  return {
    cwd,
    requests,
    scripted,
    call,
    ok,
    wait,
    completed,
    startTurn,
    get server() {
      return server
    },
    async runTurn(threadId: string, text: string): Promise<string> {
      const id = await startTurn(threadId, text)
      await completed(id)
      return id
    },
    async thread(texts: string[]): Promise<{ id: string; turnIds: string[] }> {
      const id = (await ok('thread/start', { cwd, model: 'gate/gate' })).thread.id
      const turnIds: string[] = []
      for (const text of texts) turnIds.push(await this.runTurn(id, text))
      return { id, turnIds }
    },
    read: async (threadId: string): Promise<any[]> =>
      (await ok('thread/read', { threadId, includeTurns: true })).thread.turns,
    // 假模型上一次收到的请求里的用户消息：分叉后的上下文里不能再有被切掉的回合。
    sentUserTexts: (): string[] =>
      requests
        .at(-1)
        .messages.filter((m: any) => m.role === 'user')
        .map((m: any) =>
          typeof m.content === 'string' ? m.content : m.content.map((c: any) => c.text).join(''),
        ),
    // 模拟适配器重启：同一个状态目录上重新起一个服务。
    async restart(): Promise<void> {
      await server.close()
      server = new PiServer(state)
      await ok('initialize')
    },
    async close(): Promise<void> {
      await server.close()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      await rm(root, { recursive: true, force: true })
    },
  }
}

// 一个回合里用户说了什么，用来辨认分叉后留下的是哪几轮。
const userTexts = (turns: any[]): string[] =>
  turns.map((t) =>
    t.items
      .filter((i: any) => i.type === 'userMessage')
      .flatMap((i: any) => i.content.map((c: any) => c.text))
      .join('|'),
  )

test('Pi 分叉位置：只留该留的回合，各读取入口、模型上下文与重启后一致，源会话不变', {
  timeout: 60000,
}, async () => {
  const h = await harness()
  try {
    await h.ok('initialize')
    const source = await h.thread(['第一轮', '第二轮', '第三轮'])
    const [t1, t2, t3] = source.turnIds as [string, string, string]
    // 线程名在第三轮之后才设置；排队的消息和用量都挂在源线程上。
    await h.ok('thread/name/set', { threadId: source.id, name: '源线程' })
    await h.ok('thread/queue/add', {
      threadId: source.id,
      clientUserMessageId: 'queued',
      input: [{ type: 'text', text: '排队的消息' }],
    })
    const sourceTurns = await h.read(source.id)
    assert.deepEqual(userTexts(sourceTurns), ['第一轮', '第二轮', '第三轮'])
    const sourcePath = h.server.store.thread(source.id).path!
    const sourceFile = readFileSync(sourcePath, 'utf8')
    assert.ok(h.server.store.getMeta('usage', source.id))

    // 桌面端实际走的路径：只发一条带位置的 thread/fork（excludeTurns:true），再用 thread/turns/list 读历史。
    const desktop = (
      await h.ok('thread/fork', {
        threadId: source.id,
        beforeTurnId: t2,
        path: null,
        cwd: h.cwd,
        excludeTurns: true,
      })
    ).thread
    assert.notEqual(desktop.id, source.id)
    assert.equal(desktop.forkedFromId, source.id)
    assert.equal(desktop.name, '源线程', '改名记录在被切掉的回合之后，分叉仍沿用线程名')
    assert.equal(desktop.preview, '第一轮')
    assert.deepEqual(
      (await h.ok('thread/turns/list', { threadId: desktop.id, sortDirection: 'asc' })).data,
      sourceTurns.slice(0, 1),
    )
    assert.equal((await h.ok('thread/turns/list', { threadId: desktop.id })).data.length, 1)
    assert.deepEqual(await h.read(desktop.id), sourceTurns.slice(0, 1))
    assert.deepEqual(
      (await h.ok('thread/resume', { threadId: desktop.id })).thread.turns,
      sourceTurns.slice(0, 1),
    )
    // 与回合挂钩的数据留在源线程：分叉没有用量、没有排队的消息，原生文件里也没有被切掉的回合。
    assert.equal(h.server.store.getMeta('usage', desktop.id), null)
    assert.equal(h.server.store.getMeta('usage-last', desktop.id), null)
    assert.deepEqual((await h.ok('thread/queue/list', { threadId: desktop.id })).data, [])
    const desktopFile = readFileSync(h.server.store.thread(desktop.id).path!, 'utf8')
    assert.ok(desktopFile.includes(t1))
    for (const cut of [t2, t3, '第二轮', '第三轮', '回答2', '回答3'])
      assert.ok(!desktopFile.includes(cut), `分叉的原生会话里不应有 ${cut}`)
    // 分叉后的第一次模型请求只带留下的回合。
    await h.runTurn(desktop.id, '分叉后的新消息')
    assert.deepEqual(h.sentUserTexts(), ['第一轮', '分叉后的新消息'])
    const sent = JSON.stringify(h.requests.at(-1).messages)
    assert.ok(sent.includes('回答1'))
    for (const cut of ['第二轮', '第三轮', '回答2', '回答3'])
      assert.ok(!sent.includes(cut), `发给模型的历史里不应有 ${cut}`)

    // lastTurnId 保留到该回合为止（含）；回包带回合时与源线程的前几轮逐项相同。
    const through2 = (await h.ok('thread/fork', { threadId: source.id, lastTurnId: t2 })).thread
    assert.deepEqual(through2.turns, sourceTurns.slice(0, 2))
    assert.deepEqual(await h.read(through2.id), sourceTurns.slice(0, 2))
    await h.runTurn(through2.id, '分叉后的新消息')
    assert.deepEqual(h.sentUserTexts(), ['第一轮', '第二轮', '分叉后的新消息'])
    const through1 = (await h.ok('thread/fork', { threadId: source.id, lastTurnId: t1 })).thread
    assert.deepEqual(through1.turns, sourceTurns.slice(0, 1))
    // 保留到最后一轮没有要切掉的，等同不带位置的整份分叉。
    const through3 = (await h.ok('thread/fork', { threadId: source.id, lastTurnId: t3 })).thread
    assert.deepEqual(through3.turns, sourceTurns)
    assert.deepEqual((await h.ok('thread/fork', { threadId: source.id })).thread.turns, sourceTurns)

    // 源线程的回合、原生会话文件、排队的消息都没有变。
    assert.deepEqual(await h.read(source.id), sourceTurns)
    assert.equal(readFileSync(sourcePath, 'utf8'), sourceFile)
    assert.equal((await h.ok('thread/queue/list', { threadId: source.id })).data.length, 1)

    // 适配器重启后从原生文件重新读取，结果不变；继续对话时上下文仍只有留下的回合。
    await h.restart()
    assert.deepEqual(userTexts(await h.read(desktop.id)), ['第一轮', '分叉后的新消息'])
    assert.deepEqual(
      (await h.ok('thread/turns/list', { threadId: through1.id, sortDirection: 'asc' })).data,
      sourceTurns.slice(0, 1),
    )
    const reread = (await h.ok('thread/read', { threadId: through1.id })).thread
    assert.deepEqual(reread.turns, sourceTurns.slice(0, 1))
    assert.equal(reread.forkedFromId, source.id)
    assert.equal(reread.name, '源线程')
    assert.deepEqual(
      (await h.ok('thread/resume', { threadId: through2.id })).thread.turns.map((t: any) => t.id),
      [t1, t2, (await h.read(through2.id))[2].id],
    )
    assert.deepEqual(await h.read(source.id), sourceTurns)
    await h.runTurn(through1.id, '重启后的新消息')
    assert.deepEqual(h.sentUserTexts(), ['第一轮', '重启后的新消息'])
    // 关闭会话时 Pi 的计划插件会在文件末尾追加自己的状态，所以重启后只核对原有内容没被改动。
    assert.ok(readFileSync(sourcePath, 'utf8').startsWith(sourceFile))
  } finally {
    await h.close()
  }
})

test('Pi 分叉位置：参数校验、空分叉、进行中、失败与被打断的回合', { timeout: 60000 }, async () => {
  const h = await harness()
  const code = async (params: any) => (await h.call('thread/fork', params)).error?.code
  // 让下一次模型请求挂起，返回“已到达”和“放行”。
  const hold = () => {
    let release = () => {}
    let arrived = () => {}
    const reached = new Promise<void>((resolve) => {
      arrived = resolve
    })
    h.scripted.push(() => {
      arrived()
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    return { reached, release: () => release() }
  }
  try {
    await h.ok('initialize')
    const source = await h.thread(['第一轮'])
    const t1 = source.turnIds[0]!
    h.scripted.push(() => 'fail')
    const failed = await h.runTurn(source.id, '会失败的一轮')
    const stopping = hold()
    const interrupted = await h.startTurn(source.id, '会被打断的一轮')
    await stopping.reached
    await h.ok('turn/interrupt', { threadId: source.id, turnId: interrupted })
    await h.completed(interrupted)
    stopping.release()
    const t4 = await h.runTurn(source.id, '第四轮')
    const sourceTurns = await h.read(source.id)
    assert.deepEqual(
      sourceTurns.map((t) => [t.id, t.status]),
      [
        [t1, 'completed'],
        [failed, 'failed'],
        [interrupted, 'interrupted'],
        [t4, 'completed'],
      ],
    )
    const other = await h.thread(['别的线程'])

    // 两个位置参数不能同时给；回合必须在该线程当前的历史里。
    assert.equal(await code({ threadId: source.id, lastTurnId: t1, beforeTurnId: t4 }), -32602)
    assert.equal(await code({ threadId: source.id, lastTurnId: 'missing' }), -32602)
    assert.equal(await code({ threadId: source.id, beforeTurnId: 'missing' }), -32602)
    assert.equal(await code({ threadId: source.id, beforeTurnId: other.turnIds[0] }), -32602)
    assert.equal(await code({ threadId: source.id, lastTurnId: other.turnIds[0] }), -32602)

    // 失败、被打断的回合都是已结束的回合，可以作为分叉位置，状态原样带到分叉里。
    const fork = async (params: any): Promise<any> =>
      (await h.ok('thread/fork', { threadId: source.id, ...params })).thread
    assert.deepEqual((await fork({ lastTurnId: failed })).turns, sourceTurns.slice(0, 2))
    assert.deepEqual((await fork({ beforeTurnId: failed })).turns, sourceTurns.slice(0, 1))
    assert.deepEqual((await fork({ lastTurnId: interrupted })).turns, sourceTurns.slice(0, 3))
    assert.deepEqual((await fork({ beforeTurnId: interrupted })).turns, sourceTurns.slice(0, 2))

    // 已被回退掉的回合不在当前历史里，不能再作为分叉位置。
    const rolled = await fork({})
    await h.ok('thread/rollback', { threadId: rolled.id, numTurns: 1 })
    assert.equal(await code({ threadId: rolled.id, beforeTurnId: t4 }), -32602)
    assert.equal(await code({ threadId: rolled.id, lastTurnId: t4 }), -32602)
    assert.deepEqual(
      (await h.ok('thread/fork', { threadId: rolled.id, beforeTurnId: interrupted })).thread.turns,
      sourceTurns.slice(0, 2),
    )
    assert.deepEqual(
      (await h.ok('thread/fork', { threadId: rolled.id, lastTurnId: interrupted })).thread.turns,
      sourceTurns.slice(0, 3),
    )

    // beforeTurnId 指向第一轮：得到空分叉，预览不沿用被切掉的第一条消息；之后照常对话。
    const empty = await fork({ beforeTurnId: t1, excludeTurns: true })
    assert.equal(empty.forkedFromId, source.id)
    assert.equal(empty.preview, '')
    assert.deepEqual((await h.ok('thread/turns/list', { threadId: empty.id })).data, [])
    assert.deepEqual(await h.read(empty.id), [])
    assert.deepEqual((await h.ok('thread/resume', { threadId: empty.id })).thread.turns, [])
    await h.runTurn(empty.id, '空分叉里的第一句')
    assert.deepEqual(h.sentUserTexts(), ['空分叉里的第一句'])
    assert.deepEqual(userTexts(await h.read(empty.id)), ['空分叉里的第一句'])
    const untouched = await fork({ beforeTurnId: t1 })
    assert.deepEqual(untouched.turns, [])

    // 回合进行中：lastTurnId 指向它是无效参数；照上游，截在它（或更早的回合）之前可以分叉，
    // 只带走已经结束的回合；其余分叉、回退沿用“活动会话不能变更”的限制。
    const running = hold()
    const active = await h.startTurn(source.id, '进行中的一轮')
    await running.reached
    assert.equal(await code({ threadId: source.id, lastTurnId: active }), -32602)
    assert.equal(await code({ threadId: source.id, lastTurnId: t1, beforeTurnId: active }), -32602)
    assert.equal(await code({ threadId: source.id, lastTurnId: t1 }), -32009)
    assert.equal(await code({ threadId: source.id }), -32009)
    assert.equal(
      (await h.call('thread/rollback', { threadId: source.id, numTurns: 1 })).error?.code,
      -32009,
    )
    const atActive = await fork({ beforeTurnId: active })
    assert.deepEqual(atActive.turns, sourceTurns)
    assert.deepEqual((await fork({ beforeTurnId: t4 })).turns, sourceTurns.slice(0, 3))
    assert.deepEqual(await h.read(atActive.id), sourceTurns)
    // 源会话照跑：回合照常结束，源会话的历史里有这一轮。
    running.release()
    assert.equal((await h.completed(active)).status, 'completed')
    assert.deepEqual(userTexts(await h.read(source.id)).at(-1), '进行中的一轮')
    assert.deepEqual((await fork({ beforeTurnId: active })).turns, sourceTurns)
    // 分叉接着聊：模型上下文里没有分叉时还在跑的那一轮。
    await h.runTurn(atActive.id, '分叉里的一句')
    assert.ok(!h.sentUserTexts().includes('进行中的一轮'))
    assert.deepEqual(userTexts(await h.read(atActive.id)).slice(-1), ['分叉里的一句'])
    assert.equal((await h.read(atActive.id)).length, sourceTurns.length + 1)

    // 重启后空分叉仍可读取（还没有任何消息的那个没有原生文件），有消息的那个只有自己的一轮。
    await h.restart()
    assert.deepEqual(await h.read(untouched.id), [])
    assert.deepEqual(userTexts(await h.read(empty.id)), ['空分叉里的第一句'])
    await h.runTurn(untouched.id, '重启后的第一句')
    assert.deepEqual(h.sentUserTexts(), ['重启后的第一句'])

    // 源会话还没有落盘（唯一的回合没产生任何消息）时不能按位置分叉。
    const unsaved = (await h.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
    const rejected = (await h.ok('turn/start', { threadId: unsaved, input: [{ type: 'bogus' }] }))
      .turn.id
    assert.equal((await h.completed(rejected)).status, 'failed')
    assert.equal(existsSync(h.server.store.thread(unsaved).path!), false)
    assert.equal(await code({ threadId: unsaved, beforeTurnId: rejected }), -32602)
  } finally {
    await h.close()
  }
})

test('Pi 分叉位置：原生 Pi 写出的回合也能作为分叉位置', { timeout: 60000 }, async () => {
  const h = await harness()
  try {
    await h.ok('initialize')
    // 用真实消息拼一个没有适配器标记的原生会话：第一条消息就是根条目，回合以条目 ID 命名。
    const seed = await h.thread(['原生第一轮', '原生第二轮', '原生第三轮'])
    const seedPath = h.server.store.thread(seed.id).path!
    const seedEntries = readFileSync(seedPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const nativeId = randomUUID()
    let parentId: string | null = null
    const nativeEntries = [
      { ...seedEntries[0], id: nativeId },
      ...seedEntries
        .filter((e) => e.type === 'message')
        .map((e) => {
          const entry = { ...e, parentId }
          parentId = e.id
          return entry
        }),
    ]
    const nativePath = join(dirname(seedPath), `native_${nativeId}.jsonl`)
    await writeFile(nativePath, `${nativeEntries.map((e) => JSON.stringify(e)).join('\n')}\n`)
    const sourceTurns = await h.read(nativeId)
    assert.deepEqual(userTexts(sourceTurns), ['原生第一轮', '原生第二轮', '原生第三轮'])
    assert.ok(sourceTurns.every((t) => t.id.startsWith('native:')))
    const [n1, n2, n3] = sourceTurns.map((t) => t.id) as [string, string, string]

    const before3 = (await h.ok('thread/fork', { threadId: nativeId, beforeTurnId: n3 })).thread
    assert.deepEqual(before3.turns, sourceTurns.slice(0, 2))
    const through1 = (
      await h.ok('thread/fork', { threadId: nativeId, lastTurnId: n1, excludeTurns: true })
    ).thread
    assert.deepEqual(
      (await h.ok('thread/turns/list', { threadId: through1.id, sortDirection: 'asc' })).data,
      sourceTurns.slice(0, 1),
    )
    await h.runTurn(through1.id, '分叉后的新消息')
    assert.deepEqual(h.sentUserTexts(), ['原生第一轮', '分叉后的新消息'])
    // 第一轮就是根条目：切到它之前得到一个全新的空会话。
    const empty = (await h.ok('thread/fork', { threadId: nativeId, beforeTurnId: n1 })).thread
    assert.deepEqual(empty.turns, [])
    assert.equal(empty.forkedFromId, nativeId)
    await h.runTurn(empty.id, '空分叉里的第一句')
    assert.deepEqual(h.sentUserTexts(), ['空分叉里的第一句'])
    assert.equal(
      (await h.call('thread/fork', { threadId: nativeId, beforeTurnId: `${n2}x` })).error.code,
      -32602,
    )
    assert.deepEqual(await h.read(nativeId), sourceTurns)

    await h.restart()
    assert.deepEqual(await h.read(before3.id), sourceTurns.slice(0, 2))
    assert.deepEqual(userTexts(await h.read(through1.id)), ['原生第一轮', '分叉后的新消息'])
    assert.deepEqual(userTexts(await h.read(empty.id)), ['空分叉里的第一句'])
    assert.deepEqual(userTexts(await h.read(nativeId)), ['原生第一轮', '原生第二轮', '原生第三轮'])
  } finally {
    await h.close()
  }
})

test('Pi 分叉位置：压缩前后的位置都能分叉', { timeout: 60000 }, async () => {
  const h = await harness()
  try {
    await h.ok('initialize')
    const source = await h.thread(['第一轮', '第二轮'])
    await h.ok('thread/compact/start', { threadId: source.id })
    const compacted = (
      await h.wait(
        (m) =>
          m.method === 'turn/completed' &&
          m.params.threadId === source.id &&
          m.params.turn.items.some((i: any) => i.type === 'contextCompaction'),
      )
    ).params.turn
    assert.equal(compacted.status, 'completed', JSON.stringify(compacted.error))
    await h.runTurn(source.id, '第三轮')
    const sourceTurns = await h.read(source.id)
    assert.equal(sourceTurns[2].id, compacted.id)
    assert.equal(sourceTurns.length, 4)

    // 保留到压缩那一轮：分叉里有压缩记录，发给模型的是摘要而不是最早的原文。
    const through = (await h.ok('thread/fork', { threadId: source.id, lastTurnId: compacted.id }))
      .thread
    assert.deepEqual(through.turns, sourceTurns.slice(0, 3))
    await h.runTurn(through.id, '分叉后的新消息')
    assert.equal(h.sentUserTexts().at(-1), '分叉后的新消息')
    assert.ok(!h.sentUserTexts().includes('第一轮'))
    assert.ok(!h.sentUserTexts().includes('第三轮'))
    // 切在压缩之前：分叉里没有压缩，发给模型的是完整原文。
    const before = (await h.ok('thread/fork', { threadId: source.id, beforeTurnId: compacted.id }))
      .thread
    assert.deepEqual(before.turns, sourceTurns.slice(0, 2))
    await h.runTurn(before.id, '分叉后的新消息')
    assert.deepEqual(h.sentUserTexts(), ['第一轮', '第二轮', '分叉后的新消息'])
    assert.deepEqual(await h.read(source.id), sourceTurns)
  } finally {
    await h.close()
  }
})

// Pi 自己分出来的会话（命令行里的 /fork，agent-session-runtime.mjs 的 fork）：新文件头里的 parentSession 是源会话的
// 文件路径，不是会话号。入口按路径换成会话号报进 forkedFromId，客户端靠它写“分叉自 某某”；源会话不在这个入口上
//（路径对不上、被删了）的照旧报 null，不报错。
test('Pi 分叉位置：Pi 自己分出来的会话，列会话、读会话、恢复会话都报 forkedFromId；上级不在这个入口上的报 null', {
  timeout: 60000,
}, async () => {
  const h = await harness()
  try {
    await h.ok('initialize')
    const source = await h.thread(['第一轮', '第二轮'])
    const sourcePath = String(h.server.store.thread(source.id).path)
    // 照 Pi 的 /fork 做：打开源文件，从当前位置建一个分支会话
    const manager = SessionManager.open(sourcePath, dirname(sourcePath))
    assert.ok(manager.createBranchedSession(String(manager.getLeafId())), '前提：建出了分支会话')
    const forkId = manager.getSessionId()
    const [first] = readFileSync(String(manager.getSessionFile()), 'utf8').split('\n')
    const header = JSON.parse(String(first))
    assert.equal(header.parentSession, sourcePath, '前提：Pi 记的上级是文件路径')
    const reported = async () => ({
      list: (await h.ok('thread/list', { cwd: h.cwd })).data.find((t: any) => t.id === forkId)
        ?.forkedFromId,
      read: (await h.ok('thread/read', { threadId: forkId })).thread.forkedFromId,
      resume: (await h.ok('thread/resume', { threadId: forkId })).thread.forkedFromId,
    })
    const expected = { list: source.id, read: source.id, resume: source.id }
    assert.deepEqual(await reported(), expected)
    // 不是子代理
    assert.equal((await h.ok('thread/read', { threadId: forkId })).thread.parentThreadId, null)
    await h.restart()
    assert.deepEqual(await reported(), expected)

    // 上级的路径对不上：照旧报 null
    const strayId = randomUUID()
    const strayPath = join(dirname(sourcePath), `stray_${strayId}.jsonl`)
    const [top, ...rest] = readFileSync(sourcePath, 'utf8').trim().split('\n')
    const strayHeader = {
      ...JSON.parse(String(top)),
      id: strayId,
      parentSession: join(dirname(sourcePath), 'gone.jsonl'),
    }
    await writeFile(strayPath, `${[JSON.stringify(strayHeader), ...rest].join('\n')}\n`)
    assert.equal((await h.ok('thread/read', { threadId: strayId })).thread.forkedFromId, null)
    // 上级被删了：也是 null
    await h.ok('thread/delete', { threadId: source.id })
    assert.deepEqual(await reported(), { list: null, read: null, resume: null })
  } finally {
    await h.close()
  }
})

test('Pi 分叉的时间：照上游，分叉出来的会话建立和最后活动都是分叉那一刻；列会话、重读、重启后一样，源会话不变', {
  timeout: 60000,
}, async () => {
  const h = await harness()
  try {
    await h.ok('initialize')
    const source = await h.thread(['第一轮'])
    const before = (await h.ok('thread/read', { threadId: source.id })).thread.updatedAt
    // 时间按秒算：隔开两秒，分叉那一刻和源会话最后的活动才分得开
    await new Promise((resolve) => setTimeout(resolve, 2100))
    const at = Math.floor(Date.now() / 1000)
    assert.ok(before < at, '前提：源会话最后的活动在分叉之前')
    const stamps = (thread: any) => ({
      createdAt: thread.createdAt >= at,
      updatedAt: thread.updatedAt >= at,
      recencyAt: thread.recencyAt === thread.updatedAt,
    })
    const fresh = { createdAt: true, updatedAt: true, recencyAt: true }
    const forked = (
      await h.ok('thread/fork', { threadId: source.id, lastTurnId: source.turnIds[0] })
    ).thread
    assert.deepEqual(stamps(forked), fresh, '分叉的应答')
    const started = await h.wait(
      (m) => m.method === 'thread/started' && m.params.thread.id === forked.id,
    )
    assert.deepEqual(stamps(started.params.thread), fresh, 'thread/started')
    // Pi 自己分出来的（命令行里的 /fork）：入口扫到它的文件时也按分叉那一刻算
    const sourcePath = String(h.server.store.thread(source.id).path)
    const manager = SessionManager.open(sourcePath, dirname(sourcePath))
    assert.ok(manager.createBranchedSession(String(manager.getLeafId())), '前提：建出了分支会话')
    const native = manager.getSessionId()
    const seen = async () => {
      const listed = (await h.ok('thread/list', { cwd: h.cwd })).data
      const row = (id: string) => listed.find((t: any) => t.id === id)
      return {
        list: [stamps(row(forked.id)), stamps(row(native))],
        read: [
          stamps((await h.ok('thread/read', { threadId: forked.id })).thread),
          stamps((await h.ok('thread/read', { threadId: native })).thread),
        ],
        source: row(source.id).updatedAt,
      }
    }
    const expected = { list: [fresh, fresh], read: [fresh, fresh], source: before }
    assert.deepEqual(await seen(), expected)
    // 重启之后各会话从原生会话文件重新扫出来：分叉文件里的消息还是源会话那时的，不能拿它当最后的活动
    await h.restart()
    assert.deepEqual(await seen(), expected, '重启之后')
  } finally {
    await h.close()
  }
})
