import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { clientTools } from '../src/dynamic-tools.mjs'
import { SessionManager } from '../src/sdk.mjs'
import { PiServer } from '../src/server.mjs'
import { continueWithCli } from './native-cli.mjs'
import { assertNotification, assertResponse, assertServerRequest } from './schema.mjs'

test('Pi：真实 SDK、双客户端、幂等、原生恢复、Plan、文件与停止', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-harness-adapter-pi-adapter-'))
  const agentDir = join(root, 'agent'),
    cwd = join(root, 'project')
  await mkdir(agentDir)
  await mkdir(cwd)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const replies: any[] = [],
    requests: any[] = [],
    unexpected: string[] = []
  const http = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const step = replies.shift()
    if (!step) {
      unexpected.push(req.url ?? '')
      res.writeHead(500).end()
      return
    }
    const reply = typeof step === 'function' ? await step(body) : step
    if (res.destroyed) return
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const base = {
      id: `mock_${requests.length}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
    }
    const calls = reply.tools?.map((t: any, index: number) => ({
      index,
      id: `call_${requests.length}_${index}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }))
    if (reply.thinking)
      for (const text of reply.thinking)
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] })}\n\n`,
        )
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(calls ? { tool_calls: calls } : { content: reply.text ?? 'ok' }) }, finish_reason: null }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as any).port
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        gate: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'test-only',
          models: [
            {
              id: 'gate',
              name: 'Gate',
              reasoning: false,
              input: ['text', 'image'],
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
  const mcpFixture = join(root, 'mcp-fixture.mjs')
  await writeFile(
    mcpFixture,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 let result={};
 if(request.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}};
 if(request.method==='tools/list')result={tools:[{name:'echo',description:'Native MCP echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
 if(request.method==='tools/call')result={content:[{type:'text',text:'NATIVE_MCP:'+request.params.arguments.text}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`,
  )
  await writeFile(
    join(agentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: [mcpFixture], exposure: 'direct' },
      },
    }),
  )
  await mkdir(join(agentDir, 'extensions'))
  await writeFile(
    join(agentDir, 'extensions', 'duplicate.ts'),
    `export default function(pi) {
    pi.registerTool({name:'plan_mode_complete',description:'old duplicate',parameters:{type:'object',properties:{}},execute:async()=>{throw new Error('旧插件不应执行')}})
  }`,
  )
  await writeFile(
    join(agentDir, 'extensions', 'unrelated.ts'),
    `export default function(pi) {
    pi.registerTool({name:'unrelated_tool',description:'user extension',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'kept'}]})})
  }`,
  )
  let server = new PiServer(join(root, 'state'))
  let dynamicResult: any = { success: true, contentItems: [{ type: 'inputText', text: '' }] }
  const dynamicCalls: any[] = []
  const messages: Record<string, any[]> = { desktop: [], mobile: [] }
  const invalidEvents: string[] = []
  const waiters: Array<{
    peer: string
    predicate: (m: any) => boolean
    resolve: (m: any) => void
  }> = []
  const peer = (id: string): RpcPeer => ({
    id,
    close() {},
    send(message: WireMessage) {
      messages[id]!.push(message)
      if ('method' in message && !('id' in message))
        try {
          assertNotification(message.method, message.params)
        } catch (error) {
          invalidEvents.push(String(error))
        }
      for (const waiter of [...waiters])
        if (waiter.peer === id && waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(message)
        }
      if (
        'method' in message &&
        'id' in message &&
        message.method === 'item/tool/requestUserInput'
      ) {
        assertServerRequest(message.method, message.params)
        const questions = (message.params as any).questions
        queueMicrotask(
          () =>
            void server.handle(peers[id]!, {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                answers: Object.fromEntries(
                  questions.map((q: any) => [
                    q.id,
                    { answers: q.question.includes('Protocol choice') ? [q.options[0].label] : [] },
                  ]),
                ),
              },
            }),
        )
      }
      if ('method' in message && 'id' in message && message.method === 'item/tool/call') {
        dynamicCalls.push(message.params)
        if (dynamicResult !== null)
          queueMicrotask(
            () =>
              void server.handle(peers[id]!, {
                jsonrpc: '2.0',
                id: message.id,
                result: dynamicResult,
              }),
          )
      }
    },
  })
  const peers: Record<string, RpcPeer> = { desktop: peer('desktop'), mobile: peer('mobile') }
  let sequence = 0
  const call = async (id: string, method: string, params: any = {}) => {
    const requestId = ++sequence
    await server.handle(peers[id]!, { jsonrpc: '2.0', id: requestId, method, params })
    const reply = messages[id]!.find((m) => m.id === requestId && !m.method)
    assert.ok(reply, `缺少 ${method} 响应`)
    return reply
  }
  const ok = async (id: string, method: string, params: any = {}) => {
    const reply = await call(id, method, params)
    assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`)
    assertResponse(method, reply.result)
    return reply.result
  }
  const wait = (id: string, predicate: (m: any) => boolean): Promise<any> => {
    const existing = messages[id]!.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => waiters.push({ peer: id, predicate, resolve }))
  }
  const completed = (turnId: string, id = 'desktop') =>
    wait(id, (m) => m.method === 'turn/completed' && m.params.turn.id === turnId)
  try {
    await ok('desktop', 'initialize')
    await ok('mobile', 'initialize')
    assert.ok((await ok('desktop', 'model/list')).data.some((m: any) => m.id === 'gate/gate'))
    const started = await ok('desktop', 'thread/start', { cwd, model: 'gate/gate' })
    const threadId = started.thread.id
    await ok('mobile', 'thread/resume', { threadId })
    let release: (value: any) => void = () => {}
    const waiting = new Promise((resolve) => {
      release = resolve
    })
    replies.push(() => waiting)
    const first = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hello' }],
      clientUserMessageId: 'first',
    })
    assert.equal(
      (
        await call('mobile', 'turn/start', {
          threadId,
          input: [{ type: 'text', text: 'competing' }],
        })
      ).error.code,
      -32009,
    )
    assert.equal(
      (
        await ok('mobile', 'turn/start', {
          threadId,
          input: [{ type: 'text', text: 'hello' }],
          clientUserMessageId: 'first',
        })
      ).turn.id,
      first.turn.id,
    )
    release({ text: 'shared reply' })
    assert.equal((await completed(first.turn.id)).params.turn.status, 'completed')
    await completed(first.turn.id, 'mobile')
    assert.equal(requests.length, 1)
    assert.ok(requests[0].tools.some((tool: any) => tool.function.name === 'unrelated_tool'))
    const mcpTool = requests[0].tools.find((tool: any) =>
      tool.function.name.startsWith('mcp__fixture__'),
    )
    assert.ok(mcpTool, '官方 MCP factory 应加载原生 mcp.json')
    replies.push(
      { tools: [{ name: mcpTool.function.name, args: { text: 'echo test' } }] },
      (body: any) => {
        assert.ok(JSON.stringify(body.messages).includes('NATIVE_MCP:echo test'))
        return { text: 'native MCP completed' }
      },
    )
    const mcpTurn = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'use native MCP' }],
    })
    assert.equal((await completed(mcpTurn.turn.id)).params.turn.status, 'completed')
    replies.push(
      {
        tools: [
          { name: 'write', args: { path: join(cwd, 'result.txt'), content: 'written by Pi' } },
        ],
      },
      { text: 'done' },
    )
    const second = await ok('mobile', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'write file' }],
      permissions: ':read-only',
    })
    assert.equal((await completed(second.turn.id)).params.turn.status, 'completed')
    assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'written by Pi')
    await ok('desktop', 'thread/name/set', { threadId, name: '原生 Pi 标题' })
    // 归档只改变适配器列表状态：默认列表隐藏，archived=true 可见，取消归档后恢复。
    const listed = async (params: any = {}) =>
      (await ok('desktop', 'thread/list', params)).data.map((t: any) => t.id)
    assert.deepEqual(await ok('desktop', 'thread/archive', { threadId }), {})
    await wait('desktop', (m) => m.method === 'thread/archived' && m.params.threadId === threadId)
    assert.ok(!(await listed()).includes(threadId))
    assert.ok(!(await listed({ archived: false })).includes(threadId))
    assert.ok((await listed({ archived: true })).includes(threadId))
    assert.equal((await ok('desktop', 'thread/unarchive', { threadId })).thread.id, threadId)
    await wait('desktop', (m) => m.method === 'thread/unarchived' && m.params.threadId === threadId)
    assert.ok((await listed()).includes(threadId))
    assert.ok(!(await listed({ archived: true })).includes(threadId))
    assert.equal(
      (await call('desktop', 'thread/archive', { threadId: 'missing' })).error.code,
      -32602,
    )
    const before = (await ok('desktop', 'thread/read', { threadId, includeTurns: true })).thread
    const change = before.turns
      .find((t: any) => t.id === second.turn.id)
      .items.find((i: any) => i.type === 'fileChange')
    assert.equal(change.changes[0].kind.type, 'add')
    assert.equal(change.changes[0].diff, 'written by Pi')
    const streamedChange = messages.desktop!.find(
      (m: any) => m.method === 'item/completed' && m.params?.item?.id === change.id,
    )
    assert.deepEqual(streamedChange?.params.item.changes, change.changes)
    assert.equal(before.name, '原生 Pi 标题')
    await server.close()
    server = new PiServer(join(root, 'state'))
    const readOnly = (await ok('desktop', 'thread/read', { threadId })).thread
    assert.equal(server.sessions.size, 0, '只读历史不能启动 AgentSession 或 MCP')
    assert.deepEqual(
      readOnly.turns.map((t: any) => t.id),
      before.turns.map((t: any) => t.id),
    )
    const after = (await ok('desktop', 'thread/resume', { threadId })).thread
    assert.deepEqual(
      after.turns
        .find((t: any) => t.id === second.turn.id)
        .items.find((i: any) => i.id === change.id).changes,
      change.changes,
    )
    assert.deepEqual(
      after.turns.map((t: any) => t.id),
      before.turns.map((t: any) => t.id),
    )
    assert.deepEqual(
      after.turns.flatMap((t: any) => t.items.map((i: any) => i.id)),
      before.turns.flatMap((t: any) => t.items.map((i: any) => i.id)),
    )
    replies.push(
      {
        tools: [
          {
            name: 'plan_mode_question',
            args: {
              questions: [
                {
                  id: 'protocol_choice',
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
      (body: any) => {
        assert.ok(JSON.stringify(body.messages).includes('Native Pi'))
        return {
          tools: [
            { name: 'plan_mode_complete', args: { plan: '# Plan\nUse the original Pi engine.' } },
          ],
        }
      },
    )
    const plan = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'plan' }],
      collaborationMode: { mode: 'plan' },
    })
    const ready = (await completed(plan.turn.id)).params.turn
    assert.equal(
      ready.status,
      'completed',
      JSON.stringify({
        error: ready.error,
        items: ready.items,
        warnings: messages.desktop!.filter((m) => m.method === 'warning'),
      }),
    )
    assert.ok(ready.items.some((i: any) => i.type === 'plan'))
    assert.ok(
      messages.desktop!.some(
        (m) =>
          m.method === 'item/tool/requestUserInput' &&
          m.params.questions.some((q: any) => q.question.includes('Protocol choice')),
      ),
    )
    // 扩展问的时候只给题目、没有短标签：header 留空，不拿题目截一段充数
    const asked = messages
      .desktop!.filter((m) => m.method === 'item/tool/requestUserInput')
      .flatMap((m) => m.params.questions)
    assert.ok(asked.length >= 1, JSON.stringify(asked))
    // 交了计划之后插件的那一问（就绪菜单）没有问：这条连接和官方桌面端一样没声明 planConfirmation，
    // 回合结束后由它自己问，选了执行就是下面那个回合
    assert.ok(
      !asked.some((q: any) => q.question.startsWith('Proposed plan ready')),
      JSON.stringify(asked),
    )
    assert.deepEqual(
      asked.map((q: any) => q.header),
      asked.map(() => ''),
    )
    // 等回答的这段时间会话被标成在等用户，答完改回进行中
    const statuses = messages
      .desktop!.filter(
        (m) => m.method === 'thread/status/changed' && m.params.threadId === threadId,
      )
      .map((m) => m.params.status)
    const asking = (status: any) => status.activeFlags?.includes('waitingOnUserInput') === true
    const askedAt = statuses.findIndex(asking)
    assert.ok(askedAt >= 0, JSON.stringify(statuses))
    assert.deepEqual(
      statuses.slice(askedAt).find((status) => !asking(status)),
      { type: 'active', activeFlags: [] },
    )
    const planItem = ready.items.find((i: any) => i.type === 'plan'),
      count = requests.length
    replies.push({ text: 'implemented' })
    const implementation = {
      threadId,
      input: [{ type: 'text', text: `PLEASE IMPLEMENT THIS PLAN:\n${planItem.text}` }],
      clientUserMessageId: `plan:${threadId}:${planItem.id}`,
      collaborationMode: { mode: 'default' },
    }
    const executing = await ok('desktop', 'turn/start', implementation)
    assert.equal((await completed(executing.turn.id)).params.turn.status, 'completed')
    assert.equal(requests.length, count + 1)
    assert.equal((await ok('desktop', 'turn/start', implementation)).turn.id, executing.turn.id)
    const target = join(cwd, 'ui-file')
    await ok('desktop', 'fs/writeFile', {
      path: target,
      dataBase64: Buffer.from('file UI').toString('base64'),
    })
    assert.equal(
      Buffer.from(
        (await ok('desktop', 'fs/readFile', { path: target })).dataBase64,
        'base64',
      ).toString(),
      'file UI',
    )
    const shell = await ok('desktop', 'command/exec', {
      command: ['/bin/sh', '-c', 'printf terminal'],
      cwd,
      permissionProfile: ':read-only',
    })
    assert.equal(shell.stdout, 'terminal')
    assert.deepEqual(
      await ok('desktop', 'thread/shellCommand', {
        threadId,
        command: 'printf shell-out; printf shell-error >&2',
      }),
      {},
    )
    const output = await wait(
      'desktop',
      (m) =>
        m.method === 'command/exec/outputDelta' &&
        Buffer.from(m.params.deltaBase64, 'base64').toString().includes('shell-out'),
    )
    assert.equal(output.params.stream, 'stdout')
    assert.equal(typeof output.params.processId, 'string')
    // 原生 CLI 使用同一个 SessionManager 接续，适配器重新读取原生内容。
    const native = SessionManager.open(server.store.thread(threadId).path!, undefined, cwd)
    native.appendSessionInfo('CLI 改名')
    native.appendMessage({ role: 'user', content: 'CLI added context', timestamp: Date.now() })
    const reloaded = (await ok('desktop', 'thread/resume', { threadId })).thread
    assert.equal(reloaded.name, 'CLI 改名')
    assert.ok(
      reloaded.turns.some((t: any) =>
        t.items.some((i: any) => i.content?.some((c: any) => c.text === 'CLI added context')),
      ),
    )
    const list = await ok('desktop', 'thread/turns/list', { threadId, limit: 2, itemsView: 'full' })
    assert.equal(list.data.length, 2)
    replies.push((body: any) => {
      assert.ok(JSON.stringify(body.messages).includes('shared reply'))
      return { text: 'CLI executable reply' }
    })
    await continueWithCli(server.store.thread(threadId).path!, cwd, agentDir)
    const cliResumed = (await ok('desktop', 'thread/resume', { threadId })).thread
    assert.equal(cliResumed.name, '真实 CLI 名称')
    assert.ok(
      cliResumed.turns.some((t: any) =>
        t.items.some((i: any) => i.type === 'agentMessage' && i.text === 'CLI executable reply'),
      ),
    )
    await ok('desktop', 'thread/items/list', { threadId, limit: 2 })
    const cwd2 = join(root, 'project2')
    await mkdir(cwd2)
    const other = await ok('mobile', 'thread/start', {
      cwd: cwd2,
      model: 'gate/gate',
      historyMode: 'paginated',
    })
    // 客户端创建时选择的历史契约须在创建响应与之后读会话时如实回报；未指定时为 legacy。
    // 还没说过话的会话照上游不进列表，所以这里读会话
    assert.equal(other.thread.historyMode, 'paginated')
    assert.equal(
      (await ok('mobile', 'thread/read', { threadId: other.thread.id, includeTurns: false })).thread
        .historyMode,
      'paginated',
    )
    assert.equal(
      (await ok('desktop', 'thread/read', { threadId, includeTurns: false })).thread.historyMode,
      'legacy',
    )
    const invalid = await call('mobile', 'thread/start', { cwd: cwd2, historyMode: 'bogus' })
    assert.equal(invalid.error?.code, -32602)
    assert.match(invalid.error?.message ?? '', /historyMode 无效/)
    replies.push({ text: 'different cwd' })
    const otherTurn = await ok('mobile', 'turn/start', {
      threadId: other.thread.id,
      input: [{ type: 'text', text: 'where' }],
    })
    await completed(otherTurn.turn.id, 'mobile')
    // 桌面对 paginated 线程要求 thread/resume 带两个头部游标，再用它们向后拉回合与条目。
    replies.push({ text: 'second reply' })
    const otherTurn2 = await ok('mobile', 'turn/start', {
      threadId: other.thread.id,
      input: [{ type: 'text', text: 'again' }],
    })
    await completed(otherTurn2.turn.id, 'mobile')
    const paged = await ok('mobile', 'thread/resume', { threadId: other.thread.id })
    assert.equal(typeof paged.turnsBackwardsCursor, 'string')
    assert.equal(typeof paged.itemsBackwardsCursor, 'string')
    const pagedTurns = await ok('mobile', 'thread/turns/list', {
      threadId: other.thread.id,
      cursor: paged.turnsBackwardsCursor,
      limit: 5,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
    })
    assert.deepEqual(
      pagedTurns.data.map((t: any) => t.id),
      [otherTurn2.turn.id, otherTurn.turn.id],
      '头部游标包含最新回合',
    )
    // 桌面对每个回合都用同一个线程级条目游标取该回合的条目。
    for (const turn of paged.thread.turns) {
      const collected: any[] = []
      let cursor: string | null = paged.itemsBackwardsCursor
      for (let page = 0; page < 10; page++) {
        const items = await ok('mobile', 'thread/items/list', {
          threadId: other.thread.id,
          turnId: turn.id,
          cursor,
          limit: 1,
          sortDirection: 'desc',
        })
        assert.ok(items.data.every((entry: any) => entry.turnId === turn.id))
        collected.push(...items.data.map((entry: any) => entry.item.id))
        cursor = items.nextCursor
        if (cursor == null) break
      }
      assert.equal(cursor, null, '条目分页必须收敛')
      assert.deepEqual(
        collected.reverse(),
        turn.items.map((item: any) => item.id),
      )
    }
    assert.equal(server.sessions.get(other.thread.id)!.session.sessionManager.getCwd(), cwd2)
    assert.equal(server.sessions.get(threadId)!.session.sessionManager.getCwd(), cwd)
    await ok('mobile', 'thread/unsubscribe', { threadId: other.thread.id })
    await server.releaseUnused()
    assert.equal(server.sessions.has(other.thread.id), false, '无订阅且空闲时释放 MCP 与扩展')
    const loads = await Promise.all(
      Array.from({ length: 8 }, () =>
        server.load(server.store.thread(other.thread.id), peers.mobile!, true),
      ),
    )
    assert.ok(
      loads.every((live) => live === loads[0]),
      '并发加载共享同一实例',
    )
    server.subscribe(peers.mobile!, other.thread.id)
    let blockedRelease: (value: any) => void = () => {}
    let requestStarted: () => void = () => {}
    const arrived = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    replies.push(() => {
      requestStarted()
      return new Promise((resolve) => {
        blockedRelease = resolve
      })
    })
    const stopped = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'stop me' }],
    })
    await arrived
    await ok('desktop', 'thread/queue/add', {
      threadId,
      clientUserMessageId: 'queued',
      input: [{ type: 'text', text: 'queued work' }],
    })
    await ok('mobile', 'turn/interrupt', { threadId, turnId: stopped.turn.id })
    blockedRelease({ text: 'ignored after stop' })
    assert.equal((await completed(stopped.turn.id)).params.turn.status, 'interrupted')
    assert.equal(server.active.size, 0)
    // 被打断的请求没有用量，不能把桌面的上下文占用清零。
    assert.equal(
      messages.desktop!.some(
        (m) =>
          m.method === 'thread/tokenUsage/updated' && m.params.tokenUsage.last.totalTokens === 0,
      ),
      false,
    )
    const beforeResume = messages.mobile!.length
    await ok('mobile', 'thread/resume', { threadId })
    const restoredUsage = await wait(
      'mobile',
      (m) =>
        messages.mobile!.indexOf(m) >= beforeResume && m.method === 'thread/tokenUsage/updated',
    )
    assert.equal(restoredUsage.params.tokenUsage.last.totalTokens, 15)
    assert.equal(restoredUsage.params.tokenUsage.modelContextWindow, 32000)
    assert.equal((await ok('desktop', 'thread/queue/list', { threadId })).data.length, 1)
    replies.push({ text: 'queue resumed' })
    const queued = await ok('desktop', 'thread/queue/start', { threadId })
    await completed(queued.turn.id)
    assert.equal((await ok('desktop', 'thread/queue/list', { threadId })).data.length, 0)
    replies.push(
      {
        tools: [
          {
            name: 'subagent',
            args: {
              subagent_type: 'Explore',
              prompt: 'Return child result.',
              description: 'Pi adapter child',
              model: 'gate/gate',
              run_in_background: false,
            },
          },
        ],
      },
      { text: 'child result' },
      { text: 'parent result' },
    )
    const delegated = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'delegate' }],
    })
    const delegatedTurn = (await completed(delegated.turn.id)).params.turn
    assert.equal(delegatedTurn.status, 'completed', JSON.stringify(delegatedTurn.error))
    const collab = delegatedTurn.items.find((i: any) => i.type === 'collabAgentToolCall')
    assert.ok(collab.receiverThreadIds.length)
    assert.equal(collab.agentsStates[collab.receiverThreadIds[0]].status, 'completed')
    const children = (
      await ok('desktop', 'thread/list', {
        ancestorThreadId: threadId,
        sourceKinds: ['subAgentThreadSpawn'],
      })
    ).data
    assert.equal(children.length, 1)
    assert.equal(children[0].parentThreadId, threadId)
    assert.deepEqual(children[0].source, {
      subAgent: { thread_spawn: { parent_thread_id: threadId, depth: 1 } },
    })
    assert.equal(
      (await ok('desktop', 'thread/list')).data.some((t: any) => t.id === children[0].id),
      false,
    )
    replies.push({ thinking: ['先分析。', '再核对。'], text: '思考结束' })
    const thinking = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'show reasoning' }],
    })
    const thinkingTurn = (await completed(thinking.turn.id)).params.turn
    const reasoning = thinkingTurn.items.find((i: any) => i.type === 'reasoning')
    assert.deepEqual(reasoning.summary, ['先分析。再核对。'])
    assert.deepEqual(reasoning.content, [])
    const reasoningEvents = messages.desktop!.filter((m) => m.params?.turnId === thinking.turn.id)
    assert.equal(
      reasoningEvents.filter((m) => m.method === 'item/reasoning/summaryPartAdded').length,
      1,
    )
    assert.equal(
      reasoningEvents
        .filter((m) => m.method === 'item/reasoning/summaryTextDelta')
        .map((m) => m.params.delta)
        .join(''),
      reasoning.summary[0],
    )
    assert.equal(
      reasoningEvents.some((m) => m.method === 'item/reasoning/textDelta'),
      false,
    )
    // 回答的字只由增量给出：条目开始时不带内容。带了的话，客户端按“开始时的字加上增量”算就多出一遍
    const answer = thinkingTurn.items.find((i: any) => i.type === 'agentMessage')
    assert.equal(answer.text, '思考结束')
    assert.equal(
      reasoningEvents.find((m) => m.method === 'item/started' && m.params.item.id === answer.id)
        .params.item.text,
      '',
    )
    assert.equal(
      reasoningEvents
        .filter((m) => m.method === 'item/agentMessage/delta' && m.params.itemId === answer.id)
        .map((m) => m.params.delta)
        .join(''),
      answer.text,
    )
    const thinkingReplay = (await ok('desktop', 'thread/read', { threadId, includeTurns: true }))
      .thread.turns
    assert.deepEqual(
      thinkingReplay
        .find((t: any) => t.id === thinking.turn.id)
        .items.find((i: any) => i.type === 'reasoning'),
      reasoning,
    )
    // fork 保留两个会话独立的投影；原生回退只改变上下文分支。
    const sourceTurns = (await ok('desktop', 'thread/read', { threadId, includeTurns: true }))
      .thread.turns
    const fork = (await ok('desktop', 'thread/fork', { threadId })).thread
    assert.deepEqual(
      fork.turns.map((t: any) => t.id),
      sourceTurns.map((t: any) => t.id),
    )
    assert.deepEqual(
      (await ok('desktop', 'thread/read', { threadId, includeTurns: true })).thread.turns,
      sourceTurns,
    )
    const rolled = await ok('desktop', 'thread/rollback', { threadId: fork.id, numTurns: 1 })
    assert.equal(rolled.thread.turns.length, sourceTurns.length - 1)
    assert.equal(
      (await ok('desktop', 'thread/resume', { threadId: fork.id })).thread.turns.length,
      sourceTurns.length - 1,
    )
    assert.equal(
      (await ok('desktop', 'thread/read', { threadId, includeTurns: true })).thread.turns.length,
      sourceTurns.length,
    )
    replies.push({ text: 'Native compact summary' }, { text: 'Native turn prefix summary' })
    const compactEventStart = messages.desktop!.length
    await ok('desktop', 'thread/compact/start', { threadId: fork.id })
    const compacted = (
      await wait(
        'desktop',
        (m) =>
          m.method === 'turn/completed' &&
          m.params.threadId === fork.id &&
          messages.desktop!.indexOf(m) >= compactEventStart,
      )
    ).params.turn
    assert.equal(compacted.status, 'completed', JSON.stringify(compacted.error))
    assert.ok(compacted.items.some((i: any) => i.type === 'contextCompaction'))
    const compactHistory = (
      await ok('desktop', 'thread/resume', { threadId: fork.id })
    ).thread.turns.at(-1)
    assert.deepEqual(compactHistory.items, compacted.items)
    // 官方技能配置真正控制下次加载，而不是只改变 UI。
    const skillDir = join(agentDir, 'skills', 'gate-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: gate-skill\ndescription: A test skill.\n---\nRead this skill.',
    )
    const skills = (await ok('desktop', 'skills/list', { cwds: [cwd] })).data[0].skills
    const skill = skills.find((s: any) => s.name === 'gate-skill')
    assert.ok(skill?.enabled)
    assert.equal(
      (await ok('desktop', 'skills/config/write', { cwd, path: skill.path, enabled: false }))
        .effectiveEnabled,
      false,
    )
    assert.equal(
      (await ok('desktop', 'skills/list', { cwds: [cwd] })).data[0].skills.find(
        (s: any) => s.name === 'gate-skill',
      ).enabled,
      false,
    )
    assert.equal(
      (await ok('desktop', 'skills/config/write', { cwd, path: skill.path, enabled: true }))
        .effectiveEnabled,
      true,
    )
    // Worker namespace 动态工具保留原调用标识、成功、失败和取消。
    const dynamicTools = [
      {
        type: 'namespace',
        name: 'native_ui',
        description: 'UI tools',
        tools: [
          {
            type: 'function',
            name: 'echo',
            description: 'Echo',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ]
    const dynamic = (await ok('desktop', 'thread/start', { cwd, model: 'gate/gate', dynamicTools }))
      .thread
    const dynamicName = clientTools(dynamicTools)[0]!.piName
    replies.push({ tools: [{ name: dynamicName, args: {} }] }, { text: 'dynamic done' })
    const d1 = await ok('desktop', 'turn/start', {
      threadId: dynamic.id,
      input: [{ type: 'text', text: 'call dynamic' }],
    })
    assert.equal((await completed(d1.turn.id)).params.turn.status, 'completed')
    assert.equal(dynamicCalls.at(-1).namespace, 'native_ui')
    assert.equal(dynamicCalls.at(-1).tool, 'echo')
    assert.match(dynamicCalls.at(-1).callId, /^call_/)
    // 参数是标准形状：以前多带的 itemId（和请求号相同）不再带
    assert.equal('itemId' in dynamicCalls.at(-1), false)
    const dynamicHistory = (
      await ok('desktop', 'thread/read', { threadId: dynamic.id, includeTurns: true })
    ).thread
    assert.ok(
      dynamicHistory.turns[0].items.some(
        (i: any) =>
          i.type === 'dynamicToolCall' && i.namespace === 'native_ui' && i.success === true,
      ),
    )
    dynamicResult = {
      success: false,
      contentItems: [{ type: 'inputText', text: 'expected tool failure' }],
    }
    replies.push({ tools: [{ name: dynamicName, args: {} }] }, (body: any) => {
      assert.ok(JSON.stringify(body.messages).includes('expected tool failure'))
      return { text: 'failure handled' }
    })
    const d2 = await ok('desktop', 'turn/start', {
      threadId: dynamic.id,
      input: [{ type: 'text', text: 'fail dynamic' }],
    })
    await completed(d2.turn.id)
    dynamicResult = null
    replies.push({ tools: [{ name: dynamicName, args: {} }] })
    const d3 = await ok('desktop', 'turn/start', {
      threadId: dynamic.id,
      input: [{ type: 'text', text: 'cancel dynamic' }],
    })
    await wait('desktop', (m) => m.method === 'item/tool/call' && m.params.turnId === d3.turn.id)
    await ok('desktop', 'turn/interrupt', { threadId: dynamic.id, turnId: d3.turn.id })
    assert.equal((await completed(d3.turn.id)).params.turn.status, 'interrupted')
    const firstUser = after.turns[0].items.find((i: any) => i.type === 'userMessage')
    assert.equal(firstUser.clientId, 'first')
    // 插话属于同一个主回合，重试不得再次入队。
    let steerRelease: (value: any) => void = () => {},
      steerStarted: () => void = () => {}
    const steerArrived = new Promise<void>((resolve) => {
      steerStarted = resolve
    })
    replies.push(
      () => {
        steerStarted()
        return new Promise((resolve) => {
          steerRelease = resolve
        })
      },
      { text: 'steer applied' },
    )
    const steering = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'before steer' }],
    })
    await steerArrived
    const steerParams = {
      threadId,
      expectedTurnId: steering.turn.id,
      clientUserMessageId: 'steer-once',
      input: [
        { type: 'text', text: 'additional instruction' },
        {
          type: 'image',
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVh0AAAAASUVORK5CYII=',
        },
      ],
    }
    await ok('mobile', 'turn/steer', steerParams)
    await ok('mobile', 'turn/steer', steerParams)
    steerRelease({ text: 'first response' })
    const steered = (await completed(steering.turn.id)).params.turn
    assert.ok(
      steered.items
        .find((i: any) => i.clientId === 'steer-once')
        ?.content.some((c: any) => c.type === 'image'),
    )
    assert.equal(
      steered.items.filter((i: any) => i.type === 'userMessage' && i.clientId === 'steer-once')
        .length,
      1,
    )
    const steeredHistory = (await ok('desktop', 'thread/resume', { threadId })).thread.turns.find(
      (t: any) => t.id === steering.turn.id,
    )
    assert.equal(
      steeredHistory.items.filter(
        (i: any) => i.type === 'userMessage' && i.clientId === 'steer-once',
      ).length,
      1,
    )
    // 外部实例写入时明确失败，并保留 CLI 写入的分支供恢复。
    let conflictRelease: (value: any) => void = () => {},
      conflictStarted: () => void = () => {}
    const conflictArrived = new Promise<void>((resolve) => {
      conflictStarted = resolve
    })
    replies.push(() => {
      conflictStarted()
      return new Promise((resolve) => {
        conflictRelease = resolve
      })
    })
    const conflict = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'external conflict' }],
    })
    await conflictArrived
    SessionManager.open(server.store.thread(threadId).path!, undefined, cwd).appendSessionInfo(
      '外部并发修改',
    )
    const conflicted = (await completed(conflict.turn.id)).params.turn
    conflictRelease({ text: 'discarded' })
    assert.equal(conflicted.status, 'failed')
    assert.match(conflicted.error.message, /其他实例修改/)
    assert.equal((await ok('desktop', 'thread/resume', { threadId })).thread.name, '外部并发修改')
    // 后台子代理仍由 gotgenes 管理；停止入口调用官方 shutdown 结束子执行。
    let childRelease: (value: any) => void = () => {},
      childStarted: () => void = () => {}
    let childArrived = new Promise<void>((resolve) => {
      childStarted = resolve
    })
    const backgroundRequest = {
      tools: [
        {
          name: 'subagent',
          args: {
            subagent_type: 'Explore',
            prompt: 'wait in child',
            description: 'background child',
            model: 'gate/gate',
            run_in_background: true,
          },
        },
      ],
    }
    replies.push(backgroundRequest)
    const childOrParent = (body: any) => {
      if (
        JSON.stringify(body.messages).includes('wait in child') &&
        !JSON.stringify(body.messages).includes('background child')
      ) {
        childStarted()
        return new Promise((resolve) => {
          childRelease = resolve
        })
      }
      return { text: 'parent submitted child' }
    }
    replies.push(childOrParent, childOrParent)
    const background = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'start background' }],
    })
    await childArrived
    await completed(background.turn.id)
    let nativeRelease: (value: any) => void = () => {},
      nativeStarted = () => {}
    const nativeArrived = new Promise<void>((resolve) => {
      nativeStarted = resolve
    })
    replies.push(() => {
      nativeStarted()
      return new Promise((resolve) => {
        nativeRelease = resolve
      })
    })
    childRelease({ text: 'child result wakes parent' })
    await nativeArrived
    const nativeTurn = server.active.get(threadId)!
    assert.ok(nativeTurn.native)
    assert.notEqual(nativeTurn.turn.id, background.turn.id)
    assert.equal(
      (
        await call('mobile', 'turn/start', {
          threadId,
          input: [{ type: 'text', text: 'compete with Pi' }],
        })
      ).error.code,
      -32009,
    )
    nativeRelease({ text: 'Pi spontaneous reply' })
    const nativeDone = (await completed(nativeTurn.turn.id)).params.turn
    assert.ok(nativeDone.items.some((i: any) => i.text === 'Pi spontaneous reply'))
    const replay = (await ok('desktop', 'thread/read', { threadId })).thread.turns.find(
      (t: any) => t.id === nativeTurn.turn.id,
    )
    assert.deepEqual(
      replay.items.map((i: any) => i.id),
      nativeDone.items.map((i: any) => i.id),
    )
    childArrived = new Promise<void>((resolve) => {
      childStarted = resolve
    })
    replies.push(backgroundRequest, childOrParent, childOrParent)
    const stopping = await ok('desktop', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'start another background' }],
    })
    await childArrived
    await ok('desktop', 'turn/interrupt', { threadId, turnId: stopping.turn.id })
    childRelease({ text: 'must not continue' })
    assert.equal(server.sessions.has(threadId), false)
    const deletedPath = server.store.thread(other.thread.id).path!
    await ok('mobile', 'thread/delete', { threadId: other.thread.id })
    await assert.rejects(readFile(deletedPath), { code: 'ENOENT' })
    await writeFile(
      join(agentDir, 'extensions', 'mcp-replacement.ts'),
      `export default function(pi) {
      pi.registerCommand('mcp', {description:'user MCP manager', handler:async()=>{}})
    }`,
    )
    const replacing = await ok('desktop', 'thread/start', { cwd, model: 'gate/gate' })
    const extensions = server.sessions.get(replacing.thread.id)!.loader.getExtensions().extensions
    assert.ok(extensions.some((e) => e.path === 'builtin:llama.cpp'))
    assert.ok(extensions.some((e) => e.path === 'builtin:tool-search'))
    assert.ok(
      !extensions.some((e) => e.path === 'builtin:mcp'),
      '原生可替换 MCP 规则必须与 CLI 相同',
    )
    assert.deepEqual(unexpected, [])
    assert.deepEqual(invalidEvents, [])
    server.closePeer(peers.desktop!)
    server.closePeer(peers.mobile!)
    await server.releaseUnused()
    assert.equal(server.sessions.size, 0, '两端断线后释放全部空闲会话和扩展')
  } finally {
    await server.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
