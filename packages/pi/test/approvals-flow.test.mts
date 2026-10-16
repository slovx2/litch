import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { clientTools } from '../src/dynamic-tools.mjs'
import { approvalHarness, pause, toolResults } from './approval-harness.mjs'

// Pi 的审批，接 approvals.test.mts：等多久都行、作废、几条连接同看、别的工具、子代理。

const MODEL = 'gate/gate'
const bash = (command: string) => ({ tools: [{ name: 'bash', args: { command } }] })
const resolved = (connection: { notifications(method: string): any[] }) =>
  connection.notifications('serverRequest/resolved').map((m) => m.params.requestId)

test('APPROVAL-101：一直等到有答复，不设时限：等了几秒再答照样生效', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness()
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    h.steps.push(bash('touch waited.txt'))
    const turnId = await c.start(threadId, '等我一会儿')
    const asked = await c.approval()
    // 用例里等几秒代替真实的几分钟：适配器这边没有任何时限（ServerRequests 不设定时器），
    // Pi 的 tool_call 处理函数也没有时限，等待期间也没有开着的模型请求。
    await pause(4000)
    assert.equal(existsSync(join(h.cwd, 'waited.txt')), false)
    assert.deepEqual(resolved(c), [], '请求还在等')
    assert.equal(c.notifications('turn/completed').length, 0, '回合还在等')
    assert.equal(h.requests.length, 1, '等待期间没有再请求模型')
    assert.deepEqual((await c.ok('thread/read', { threadId, includeTurns: false })).thread.status, {
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    })
    await c.decide(asked, 'accept')
    assert.equal((await c.completed(turnId)).status, 'completed')
    assert.equal(existsSync(join(h.cwd, 'waited.txt')), true)
    assert.deepEqual(resolved(c), [asked.id])
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-102：等审批时打断回合、归档会话、关掉适配器：请求作废并通知，操作不执行', {
  timeout: 90000,
}, async () => {
  const h = await approvalHarness()
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    const file = (name: string) => join(h.cwd, name)

    // 打断。
    h.steps.push(bash('touch interrupted.txt'))
    const first = await c.start(threadId, '等着被打断')
    const asked = await c.approval()
    await c.ok('turn/interrupt', { threadId, turnId: first })
    assert.equal((await c.completed(first)).status, 'interrupted')
    assert.deepEqual(resolved(c), [asked.id])
    // 迟到的答复没有任何效果。
    await c.decide(asked, 'accept')
    await pause(300)
    assert.equal(existsSync(file('interrupted.txt')), false)
    assert.deepEqual(c.notifications('thread/status/changed').at(-1)?.params.status, {
      type: 'idle',
    })
    assert.equal(h.requests.length, 1)

    // 归档。
    h.steps.push(bash('touch archived.txt'))
    const second = await c.start(threadId, '等着被归档')
    const pending = await c.approval()
    await c.ok('thread/archive', { threadId })
    assert.equal((await c.completed(second)).status, 'interrupted')
    assert.deepEqual(resolved(c), [asked.id, pending.id])
    assert.equal(existsSync(file('archived.txt')), false)
    await c.ok('thread/unarchive', { threadId })

    // 适配器退出。
    h.steps.push(bash('touch shutdown.txt'))
    const third = await c.start(threadId, '等着适配器退出')
    const last = await c.approval()
    await h.shutdown()
    assert.equal((await c.completed(third)).status, 'interrupted')
    assert.deepEqual(resolved(c), [asked.id, pending.id, last.id])
    assert.equal(existsSync(file('shutdown.txt')), false)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-103：拿着请求的连接都断了：这次操作不执行，模型知道没等到答复', {
  timeout: 60000,
}, async () => {
  const h = await approvalHarness()
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    let seen: string[] = []
    h.steps.push(bash('touch orphan.txt'), (body) => {
      seen = toolResults(body)
      return { text: '没人答复，先不做' }
    })
    await c.start(threadId, '问完就断线')
    await c.approval()
    h.server.closePeer(c.peer)
    for (let waited = 0; h.requests.length < 2 && waited < 10000; waited += 10) await pause(10)
    assert.deepEqual(seen, ['not run: the approval request got no answer (客户端已断开)'])
    await pause(200)
    assert.equal(existsSync(join(h.cwd, 'orphan.txt')), false)
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-104：两条连接同看一个会话：同一条请求，各按自己的声明给参数，先答的生效，后来的补送', {
  timeout: 90000,
}, async () => {
  const h = await approvalHarness()
  try {
    const desktop = await h.connect('desktop')
    const litch = await h.connect('litch', ['declineWithNote'])
    const threadId = (await desktop.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    await litch.ok('thread/resume', { threadId })
    const file = (name: string) => join(h.cwd, name)

    h.steps.push(bash('touch shared.txt'))
    const first = await desktop.start(threadId, '两边都问')
    const standard = await desktop.approval()
    const noted = await litch.approval()
    assert.equal(noted.id, standard.id, '两条连接收到的是同一个请求号')
    // 没声明扩展的那条是标准的四种决定，声明了的多一种；别的字段一样。
    assert.deepEqual(standard.params.availableDecisions, [
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ])
    assert.deepEqual(noted.params, {
      ...standard.params,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'declineWithNote', 'cancel'],
    })
    // 后来才订阅的连接补收到这条还在等的请求，请求号不变。
    const late = await h.connect('late')
    await late.ok('thread/resume', { threadId })
    const replayed = await late.approval()
    assert.deepEqual([replayed.id, replayed.params], [standard.id, standard.params])
    // 没发起回合的那条先答拒绝；发起的那条随后答允许，被丢弃。
    await litch.decide(noted, 'decline')
    await desktop.decide(standard, 'accept')
    assert.equal((await desktop.completed(first)).status, 'completed')
    await pause(200)
    assert.equal(existsSync(file('shared.txt')), false, '先答的拒绝生效')
    for (const who of [desktop, litch, late]) {
      await who.completed(first)
      assert.deepEqual(resolved(who), [standard.id])
    }

    // 反过来：发起的那条先允许，另一条迟到的拒绝不起作用；说明也只有声明过的连接能带。
    h.steps.push(bash('touch second.txt'))
    const second = await desktop.start(threadId, '再问一次')
    const again = await desktop.approval()
    await litch.approval()
    await late.approval()
    await desktop.decide(again, 'accept')
    await litch.answer(again, { decision: { declineWithNote: { note: '晚了一步' } } })
    assert.equal((await litch.completed(second)).status, 'completed')
    assert.equal(existsSync(file('second.txt')), true, '先答的允许生效')

    // 一条连接断开只摘掉它自己：别的连接还拿着请求，照样能答。
    h.steps.push(bash('touch third.txt'))
    const third = await desktop.start(threadId, '问到一半有人断线')
    const kept = await litch.approval()
    await desktop.approval()
    h.server.closePeer(desktop.peer)
    await pause(100)
    assert.deepEqual(resolved(litch), [standard.id, again.id], '请求还在等')
    await litch.decide(kept, 'accept')
    assert.equal((await litch.completed(third)).status, 'completed')
    assert.equal(existsSync(file('third.txt')), true)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

// 代理目录里放一个 MCP 服务（一个没有标注的工具、一个标了只读的）、一个用户扩展（同样两种），
// 并把平时不开的几个内置工具打开。
async function withTools(agentDir: string, root: string): Promise<void> {
  const fixture = join(root, 'mcp-fixture.mjs')
  await writeFile(
    fixture,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 let result={};
 if(request.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}};
 if(request.method==='tools/list')result={tools:[
  {name:'echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}},
  {name:'peek',description:'peek',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{}}}]};
 if(request.method==='tools/call')result={content:[{type:'text',text:'MCP:'+request.params.name+':'+(request.params.arguments.text??'')}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`,
  )
  await writeFile(
    join(agentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: [fixture], exposure: 'direct' } },
    }),
  )
  await mkdir(join(agentDir, 'extensions'))
  await writeFile(
    join(agentDir, 'extensions', 'user.ts'),
    `export default function(pi) {
  const tool = (name, annotations) => pi.registerTool({name, description: name, annotations,
    parameters: {type:'object',properties:{}},
    execute: async () => ({content:[{type:'text',text:'EXT:'+name}]})})
  tool('user_tool', undefined)
  tool('safe_tool', {readOnlyHint: true})
}`,
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'gate',
      defaultModel: 'gate',
      retry: { enabled: false },
      defaultTools: ['+ls', '+grep', '+find', '+codemode'],
    }),
  )
}

test('APPROVAL-105：只读的不问；MCP 工具和扩展工具按标注问；客户端执行的工具不问；一批里的调用一个一个地问', {
  timeout: 120000,
}, async () => {
  const h = await approvalHarness({ prepare: withTools })
  try {
    const c = await h.connect('desktop')
    const dynamicTools = [
      {
        type: 'function',
        name: 'client_side',
        description: 'runs on the client',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL, dynamicTools })).thread
      .id
    const session = h.server.sessions.get(threadId)?.session
    // MCP 服务是会话起来之后才连上的，等它的工具登记好。
    for (let waited = 0; waited < 15000; waited += 20) {
      if (session?.getAllTools().some((tool) => tool.name === 'mcp__fixture__echo')) break
      await pause(20)
    }
    await writeFile(join(h.cwd, 'doc.txt'), 'needle\n')
    let seen: string[] = []
    const capture = (body: any) => {
      seen = toolResults(body)
      return { text: '看完了' }
    }
    const clientTool = clientTools(dynamicTools)[0]?.piName ?? ''

    // 这一批都不用问：读文件、列目录、搜索、标了只读的 MCP 工具和扩展工具、客户端执行的工具。
    h.steps.push(
      {
        tools: [
          { name: 'read', args: { path: join(h.cwd, 'doc.txt') } },
          { name: 'ls', args: { path: h.cwd } },
          { name: 'grep', args: { pattern: 'needle', path: h.cwd } },
          { name: 'find', args: { pattern: '*.txt', path: h.cwd } },
          { name: 'mcp__fixture__peek', args: {} },
          { name: 'safe_tool', args: {} },
          { name: clientTool, args: {} },
        ],
      },
      capture,
    )
    const first = await c.start(threadId, '只看不动')
    const clientCall = await c.until('客户端工具调用', (m) => m.method === 'item/tool/call')
    await c.answer(clientCall, {
      success: true,
      contentItems: [{ type: 'inputText', text: 'CLIENT:ok' }],
    })
    assert.equal((await c.completed(first)).status, 'completed')
    assert.deepEqual(c.approvals(), [], '没有一条审批请求')
    assert.equal(seen.length, 7)
    assert.match(seen[0] ?? '', /needle/)
    assert.match(seen[4] ?? '', /MCP:peek/)
    assert.match(seen[5] ?? '', /EXT:safe_tool/)
    assert.match(seen[6] ?? '', /CLIENT:ok/)

    // 没有标注的 MCP 工具：问，走文件改动审批，调用的内容在条目上。
    h.steps.push({ tools: [{ name: 'mcp__fixture__echo', args: { text: 'hi' } }] }, capture)
    const second = await c.start(threadId, '调 MCP 工具')
    const mcp = await c.approval()
    assert.equal(mcp.method, 'item/fileChange/requestApproval')
    assert.deepEqual(mcp.params, {
      threadId,
      turnId: second,
      itemId: mcp.params.itemId,
      startedAtMs: mcp.params.startedAtMs,
      reason: 'Pi 要调用工具 mcp__fixture__echo',
      grantRoot: null,
    })
    const item = c.messages.find(
      (m) => m.method === 'item/started' && m.params.item.id === mcp.params.itemId,
    )?.params.item
    assert.deepEqual(
      [item.type, item.server, item.tool, item.arguments],
      ['mcpToolCall', 'fixture', 'mcp__fixture__echo', { text: 'hi' }],
    )
    await c.decide(mcp, 'decline')
    await c.completed(second)
    // 模型看到的是整个会话到这一步为止的工具结果，前面七条是上一回合的。
    assert.deepEqual(seen.slice(7), ['denied by user'], 'MCP 服务没有被调用')
    const refused = c.item(mcp.params.itemId)
    assert.deepEqual([refused.status, refused.error], ['failed', { message: 'denied by user' }])
    h.steps.push({ tools: [{ name: 'mcp__fixture__echo', args: { text: 'again' } }] }, capture)
    const third = await c.start(threadId, '再调一次')
    await c.decide(await c.approval(), 'accept')
    await c.completed(third)
    assert.match(seen.at(-1) ?? '', /MCP:echo:again/)

    // 没有标注的扩展工具：问。这个会话里都允许是按工具记的。
    h.steps.push({ tools: [{ name: 'user_tool', args: {} }] })
    const fourth = await c.start(threadId, '调扩展工具')
    const extension = await c.approval()
    assert.equal(extension.params.reason, 'Pi 要调用工具 user_tool')
    await c.decide(extension, 'acceptForSession')
    await c.completed(fourth)
    const before = c.approvals().length
    h.steps.push({ tools: [{ name: 'user_tool', args: {} }] }, capture)
    await c.completed(await c.start(threadId, '同一个工具再来'))
    assert.match(seen.at(-1) ?? '', /EXT:user_tool/)
    assert.equal(c.approvals().length, before, '放行过的工具没有再问')

    // 一批里的两条命令：前一条有了答复才问后一条；两条都有了答复才一起执行。
    h.steps.push({
      tools: [
        { name: 'bash', args: { command: 'touch one.txt' } },
        { name: 'bash', args: { command: 'touch two.txt' } },
      ],
    })
    const fifth = await c.start(threadId, '两条命令')
    const one = await c.approval()
    await pause(300)
    assert.equal(c.approvals().length, before + 1, '后一条还没有问')
    await c.decide(one, 'accept')
    const two = await c.approval()
    assert.deepEqual([one.params.command, two.params.command], ['touch one.txt', 'touch two.txt'])
    await c.decide(two, 'decline')
    await c.completed(fifth)
    assert.deepEqual(
      [existsSync(join(h.cwd, 'one.txt')), existsSync(join(h.cwd, 'two.txt'))],
      [true, false],
    )
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-106：计划模式自己的拦截排在前面：它拦下的调用不来问，它自己的工具也不问', {
  timeout: 120000,
}, async () => {
  const h = await approvalHarness()
  try {
    // 声明了 planConfirmation（和 Litch 一样）：交计划之后插件的那一问在回合里问，看它不被当成审批
    const c = await h.connect('litch', ['planConfirmation'])
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    let seen: string[] = []
    h.steps.push(
      { tools: [{ name: 'write', args: { path: join(h.cwd, 'planned.txt'), content: 'x' } }] },
      (body: any) => {
        seen = toolResults(body)
        return { tools: [{ name: 'plan_mode_complete', args: { plan: '# Plan\n写一个文件。' } }] }
      },
    )
    const turnId = await c.start(threadId, '先做计划', { collaborationMode: { mode: 'plan' } })
    // 交计划之后插件来问“这份计划行不行”，那是提问，不是审批。
    const question = await c.until('计划确认', (m) => m.method === 'item/tool/requestUserInput')
    await c.answer(question, {
      answers: Object.fromEntries(
        question.params.questions.map((q: any) => [q.id, { answers: [] }]),
      ),
    })
    const turn = await c.completed(turnId)
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error))
    assert.deepEqual(c.approvals(), [], '计划模式拦下的写文件没有来问，交计划也不问')
    assert.match(seen[0] ?? '', /Plan mode blocks mutating tool 'write'/)
    assert.equal(existsSync(join(h.cwd, 'planned.txt')), false)
    assert.ok(turn.items.some((item: any) => item.type === 'plan'))
    // 计划模式没拦的那一份不带预先算的差异，也没有被标成“被否决”：它根本没到审批这一步。
    const blocked = turn.items.find((item: any) => item.type === 'fileChange')
    assert.deepEqual([blocked.status, blocked.changes], ['failed', []])
    assert.deepEqual(c.notifications('item/fileChange/patchUpdated'), [])

    // 退出计划模式之后同一个调用照常来问。
    h.steps.push({
      tools: [{ name: 'write', args: { path: join(h.cwd, 'planned.txt'), content: 'x' } }],
    })
    const next = await c.start(threadId, '照计划做', { collaborationMode: { mode: 'default' } })
    const request = await c.approval()
    assert.equal(request.method, 'item/fileChange/requestApproval')
    await c.decide(request, 'accept')
    await c.completed(next)
    assert.equal(readFileSync(join(h.cwd, 'planned.txt'), 'utf8'), 'x')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-107：启动子代理要问一次；子代理里面的命令和写文件不问（现状，声明里写着）', {
  timeout: 120000,
}, async () => {
  const h = await approvalHarness()
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    const marker = join(h.cwd, 'child-ran.txt')
    const written = join(h.cwd, 'child-wrote.txt')
    let parentSaw: string[] = []
    h.steps.push(
      {
        tools: [
          {
            name: 'subagent',
            args: {
              subagent_type: 'general-purpose',
              prompt: 'Run the command.',
              description: 'approval child',
              model: 'gate/gate',
              run_in_background: false,
            },
          },
        ],
      },
      // 下面两步是子代理自己的模型请求：它跑一条命令、写一个文件。
      {
        tools: [
          { name: 'bash', args: { command: `touch '${marker}'` } },
          { name: 'write', args: { path: written, content: 'from child' } },
        ],
      },
      { text: 'child done' },
      (body: any) => {
        parentSaw = toolResults(body)
        return { text: '父会话收尾' }
      },
    )
    const turnId = await c.start(threadId, '交给子代理')
    const request = await c.approval()
    assert.equal(request.method, 'item/fileChange/requestApproval')
    assert.equal(request.params.reason, 'Pi 要启动一个子代理。子代理里的操作不会再来问你')
    assert.equal(
      c.messages.find(
        (m) => m.method === 'item/started' && m.params.item.id === request.params.itemId,
      )?.params.item.type,
      'collabAgentToolCall',
    )
    assert.equal(h.requests.length, 1, '没放行之前子代理没有起来')
    await c.decide(request, 'accept')
    const turn = await c.completed(turnId)
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error))
    // 子代理里的两个操作都真的做了，而整个过程只问过启动子代理那一次。
    assert.equal(existsSync(marker), true)
    assert.equal(readFileSync(written, 'utf8'), 'from child')
    assert.equal(c.approvals().length, 1)
    assert.match(parentSaw.at(-1) ?? '', /child done/)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('APPROVAL-108：脚本工具（codemode）本身不问，它里面调的每个工具各自问', {
  timeout: 120000,
}, async () => {
  const h = await approvalHarness({ prepare: withTools })
  try {
    const c = await h.connect('desktop')
    const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: MODEL })).thread.id
    await writeFile(join(h.cwd, 'doc.txt'), 'needle\n')
    let seen: string[] = []
    h.steps.push(
      {
        tools: [
          {
            name: 'codemode',
            args: {
              code: `const text = await tools.read({ path: ${JSON.stringify(join(h.cwd, 'doc.txt'))} });
const ran = await tools.bash({ command: 'touch nested.txt' });
return JSON.stringify({ text, ran });`,
            },
          },
        ],
      },
      (body: any) => {
        seen = toolResults(body)
        return { text: '脚本跑完了' }
      },
    )
    const turnId = await c.start(threadId, '用脚本做')
    const request = await c.approval()
    // 来问的是脚本里的那条命令：读文件没有问，脚本工具本身也没有问。
    assert.equal(request.method, 'item/commandExecution/requestApproval')
    assert.equal(request.params.command, 'touch nested.txt')
    assert.match(request.params.itemId, /\/\d+$/, '脚本里的调用，标识是“外层调用/序号”')
    await c.decide(request, 'decline')
    await c.completed(turnId)
    assert.equal(c.approvals().length, 1)
    assert.equal(existsSync(join(h.cwd, 'nested.txt')), false)
    // 被否决的那一步在脚本里是一次抛错，模型从脚本的结果里看到理由，也看到前面的读文件已经做了。
    assert.match(seen[0] ?? '', /Error: denied by user/)
    assert.match(seen[0] ?? '', /read \(ok\), bash \(error\)/)
    const nested = c.item(request.params.itemId)
    assert.deepEqual([nested.type, nested.status], ['commandExecution', 'declined'])
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})
