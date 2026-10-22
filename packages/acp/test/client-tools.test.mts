import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  PRESENTATION_RULES,
  PRESENTATION_SPEC,
} from '../../protocol/src/client-tools-presentation.mjs'
import { dynamicToolSpecs, matchDynamicTool, toolInstructions } from '../src/client-tools.mjs'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, type Scene, scene, text, turn, violations } from './client.mjs'

// 动态工具（含 Litch 的客户端工具）：声明、按会话挂 MCP 桥、调用往返、出错、接回会话后还在。
// 假 agent 收到 mcpServers 就把 MCP 服务起起来，回合里按“tool <报法> <工具> <参数>”调（fake-agent.mts）。

const TOOLS = [
  {
    type: 'namespace',
    name: 'litch_echo',
    description: '测试用的回声。',
    instructions: '要回声时调 litch_echo。',
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: '原样回参数',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      {
        type: 'function',
        name: 'run',
        description: '跑一行命令',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  },
  {
    type: 'namespace',
    name: 'litch_tasks',
    description: '定时任务。',
    instructions: '用户要定时做事时用 litch_tasks。',
    tools: [
      { type: 'function', name: 'list', description: '列出任务', inputSchema: { type: 'object' } },
    ],
  },
]

/** 一个声明了能执行 litch_echo 的 Litch 连接，回声工具照参数答 */
async function litch(s: Scene, namespaces = ['litch_echo']) {
  const desktop = client(s.server)
  await desktop.call('initialize', {
    clientInfo: { name: 'litch', version: '0' },
    capabilities: { litchExtensions: ['clientTools'], litchClientTools: { namespaces } },
  })
  desktop.onRequest((request) =>
    request.method === 'item/tool/call'
      ? {
          success: true,
          contentItems: [
            { type: 'inputText', text: `回声：${JSON.stringify(request.params.arguments)}` },
          ],
        }
      : { decision: 'accept' },
  )
  return desktop
}

/** 假 agent 每次挂上 MCP 服务时记的那一行 */
async function mounts(s: Scene): Promise<any[]> {
  const raw = await readFile(join(s.root, 'agent-messages.jsonl'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.mcp)
    .map((entry) => entry.mcp)
}

const toolItems = (done: any) =>
  done.items.filter(
    (item: any) => !['userMessage', 'agentMessage', 'reasoning'].includes(item.type),
  )
const said = (done: any) =>
  done.items
    .filter((item: any) => item.type === 'agentMessage')
    .map((item: any) => item.text)
    .join('')

test('声明 clientTools；带动态工具的会话挂上 litch 的 MCP 服务，工具名和 instructions 交给 agent', async () => {
  const s = await scene()
  try {
    const info = await s.desktop.call('runtime/info', {})
    assert.ok(info.extensions.includes('clientTools'))
    const desktop = await litch(s)
    const plain = await desktop.call('thread/start', { cwd: s.cwd })
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, dynamicTools: TOOLS })
    const news = (await s.received()).filter((m) => m.method === 'session/new')
    assert.deepEqual(news[0].params.mcpServers, [])
    const [server] = news[1].params.mcpServers
    assert.equal(server.name, 'litch')
    assert.equal(server.command, process.execPath)
    assert.match(server.args[0], /mcp-bridge\.mjs$/)
    // 口令只在环境变量里，不在参数里
    assert.equal(server.env[0].name, 'LITCH_ACP_MCP_TOKEN')
    assert.ok(!server.args.includes(server.env[0].value))
    const mounted = (await mounts(s)).filter((entry) => entry.sessionId === thread.id)
    assert.deepEqual(mounted.at(-1).servers, [
      {
        name: 'litch',
        instructions:
          '# Tool instructions: litch_echo\n要回声时调 litch_echo。\n\n# Tool instructions: litch_tasks\n用户要定时做事时用 litch_tasks。',
        tools: ['echo_echo', 'echo_run', 'tasks_list'],
      },
    ])
    assert.ok(
      !(await mounts(s)).some(
        (entry) => entry.sessionId === plain.thread.id && entry.servers.length,
      ),
    )
    // 不合规矩的动态工具：不建会话
    const before = (await s.received()).filter((m) => m.method === 'session/new').length
    await assert.rejects(
      desktop.call('thread/start', { cwd: s.cwd, dynamicTools: [{ type: 'bogus' }] }),
      (error: any) => error.code === -32602,
    )
    assert.equal((await s.received()).filter((m) => m.method === 'session/new').length, before)
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('只带 Litch 的呈现风格（不带工具的命名空间）的会话也挂 litch 的 MCP 服务：工具清单是空的，instructions 交给 agent', async () => {
  const s = await scene()
  try {
    const desktop = await litch(s)
    const { thread } = await desktop.call('thread/start', {
      cwd: s.cwd,
      dynamicTools: [PRESENTATION_SPEC],
    })
    const news = (await s.received()).filter((m) => m.method === 'session/new')
    assert.equal(news.at(-1).params.mcpServers[0]?.name, 'litch')
    const mounted = (await mounts(s)).filter((entry) => entry.sessionId === thread.id)
    assert.deepEqual(mounted.at(-1).servers, [
      {
        name: 'litch',
        instructions: `# Tool instructions: litch_presentation\n${PRESENTATION_RULES}`,
        tools: [],
      },
    ])
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('调用往返：发 item/tool/call 给声明了的连接，条目号就是 callId，结果交回 agent', async () => {
  const s = await scene()
  try {
    const desktop = await litch(s)
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, dynamicTools: TOOLS })
    const done = await turn(
      { ...s, desktop },
      thread.id,
      text('tool gemini echo_echo {"text":"hi"}'),
    )
    const calls = desktop.requests.filter((r) => r.method === 'item/tool/call')
    assert.equal(calls.length, 1)
    const call = calls[0].params
    assert.deepEqual(
      {
        namespace: call.namespace,
        tool: call.tool,
        arguments: call.arguments,
        turnId: call.turnId,
      },
      { namespace: 'litch_echo', tool: 'echo', arguments: { text: 'hi' }, turnId: done.id },
    )
    const items = toolItems(done)
    assert.equal(items.length, 1)
    assert.deepEqual(
      { ...items[0], durationMs: null },
      {
        type: 'dynamicToolCall',
        id: call.callId,
        namespace: 'litch_echo',
        tool: 'echo',
        arguments: { text: 'hi' },
        status: 'completed',
        contentItems: [{ type: 'inputText', text: '回声：{"text":"hi"}' }],
        success: true,
        durationMs: null,
      },
    )
    assert.equal(said(done), '结果：回声：{"text":"hi"}')
    // 别的连接（没声明的）收不到这次调用
    assert.ok(!s.desktop.requests.some((r) => r.method === 'item/tool/call'))
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('各家报调用的样子：先问权限的不转给用户、认不出标题的按参数认领、不报的另起条目', async () => {
  const s = await scene()
  try {
    const desktop = await litch(s)
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, dynamicTools: TOOLS })
    const cases: Array<[string, string, (item: any) => boolean]> = [
      // 先问权限：直接允许这一次，用户那里没有审批卡
      ['ask', 'echo_echo {"text":"a"}', (item) => item.id.endsWith(':tool:call-echo_echo')],
      // 标题是参数里的命令（Gemini CLI）：普通条目改画成动态工具
      [
        'command',
        'echo_run {"command":"ls -la"}',
        (item) => item.id.endsWith(':tool:call-echo_run'),
      ],
      // 标题认不出、带原始参数：按参数认领
      ['raw', 'echo_echo {"text":"b"}', (item) => item.id.endsWith(':tool:call-echo_echo')],
      // 调用之后才报：等一会儿再认领
      ['late', 'echo_echo {"text":"c"}', (item) => item.id.endsWith(':tool:call-echo_echo')],
      // 一直不报：另起一个条目
      ['silent', 'echo_echo {"text":"d"}', (item) => item.id.includes(':litch')],
    ]
    for (const [style, rest, owned] of cases) {
      const done = await turn({ ...s, desktop }, thread.id, text(`tool ${style} ${rest}`))
      const items = toolItems(done)
      assert.equal(items.length, 1, `${style}：只有一个工具条目`)
      const [item] = items
      assert.equal(item.type, 'dynamicToolCall', style)
      assert.equal(item.success, true, style)
      assert.ok(owned(item), `${style}：条目号 ${item.id}`)
      const call = desktop.requests.filter((r) => r.method === 'item/tool/call').at(-1)
      assert.equal(call.params.callId, item.id, style)
      assert.deepEqual(item.arguments, JSON.parse(rest.slice(rest.indexOf(' ') + 1)), style)
    }
    assert.ok(!desktop.requests.some((r) => /requestApproval$/.test(r.method)))
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('出错：没有声明的连接回 noExecutor，执行方答错回 failed，条目都记成失败', async () => {
  const s = await scene()
  try {
    // 只声明了别的命名空间
    const desktop = await litch(s, ['litch_browser'])
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, dynamicTools: TOOLS })
    let done = await turn({ ...s, desktop }, thread.id, text('tool gemini echo_echo {"text":"x"}'))
    assert.ok(!desktop.requests.some((r) => r.method === 'item/tool/call'))
    let [item] = toolItems(done)
    assert.equal(item.status, 'failed')
    assert.equal(item.success, false)
    assert.match(item.contentItems[0].text, /^\[litch:noExecutor\] /)
    assert.match(said(done), /^结果：\[litch:noExecutor\] /)

    // 声明了，但执行时出错（JSON-RPC 错误）
    const other = await litch(s)
    other.onRequest(() => undefined)
    await other.call('thread/resume', { threadId: thread.id })
    const started = turn(
      { ...s, desktop: other },
      thread.id,
      text('tool gemini echo_echo {"text":"y"}'),
    )
    let pending: any
    for (let waited = 0; !pending && waited < 5000; waited += 20) {
      pending = other.requests.find((r) => r.method === 'item/tool/call')
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(pending, '收到了调用')
    await s.server.handle(other.peer, {
      jsonrpc: '2.0',
      id: pending.id,
      error: { code: -32603, message: '页面打不开' },
    } as any)
    done = await started
    ;[item] = toolItems(done)
    assert.equal(item.success, false)
    assert.match(item.contentItems[0].text, /^\[litch:failed\] .*页面打不开/)
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('打断：在等执行方的调用撤回，agent 收到失败，回合按打断收尾', async () => {
  const s = await scene()
  try {
    const desktop = await litch(s)
    desktop.onRequest(() => undefined)
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, dynamicTools: TOOLS })
    const { turn: started } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('tool gemini echo_echo {"text":"z"}'),
    })
    for (let waited = 0; waited < 5000; waited += 20) {
      if (desktop.requests.some((r) => r.method === 'item/tool/call')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await desktop.call('turn/interrupt', { threadId: thread.id, turnId: started.id })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === started.id)).turn
    const [item] = toolItems(done)
    assert.equal(item.type, 'dynamicToolCall')
    assert.equal(item.success, false)
    // 撤回的那条请求有 serverRequest/resolved
    assert.ok(desktop.notifications.some((n) => n.method === 'serverRequest/resolved'))
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('接回会话后还在：适配器重启后 resume 带上 MCP 服务；分叉出来的会话也带着', async () => {
  const s = await scene()
  try {
    let desktop = await litch(s)
    const { thread } = await desktop.call('thread/start', { cwd: s.cwd, dynamicTools: TOOLS })
    await turn({ ...s, desktop }, thread.id, text('hello'))
    await s.server.close()
    // 同一个状态目录起一个新的入口：会话从库里摆回来，下一回合接回 agent 时重新挂桥
    const server = new AcpServer(s.home, s.env)
    const again: Scene = { ...s, server, desktop: client(server) }
    try {
      desktop = await litch(again)
      await desktop.call('thread/resume', { threadId: thread.id })
      const done = await turn(
        { ...again, desktop },
        thread.id,
        text('tool gemini echo_echo {"text":"again"}'),
      )
      assert.equal(said(done), '结果：回声：{"text":"again"}')
      const resumed = (await s.received()).filter((m) => m.method === 'session/resume').at(-1)
      assert.equal(resumed.params.mcpServers[0].name, 'litch')
      // 分叉
      const forked = await desktop.call('thread/fork', { threadId: thread.id })
      const fork = (await s.received()).filter((m) => m.method === 'session/fork').at(-1)
      assert.equal(fork.params.mcpServers[0].name, 'litch')
      const child = await turn(
        { ...again, desktop },
        forked.thread.id,
        text('tool gemini tasks_list {}'),
      )
      // 分叉出来的会话里工具也在；只声明了 litch_echo，litch_tasks 没有执行方，不发给它
      assert.ok(
        !desktop.requests.some(
          (r) => r.method === 'item/tool/call' && r.params.namespace === 'litch_tasks',
        ),
      )
      assert.match(said(child), /\[litch:noExecutor\]/)
      assert.deepEqual([...violations], [])
    } finally {
      await server.close()
    }
  } finally {
    await s.restore()
  }
})

test('认标题：几家 agent 写 MCP 工具的样子都认得，名字是别的工具的前缀时不认错', () => {
  const specs = dynamicToolSpecs(TOOLS)
  const name = (title: string) => matchDynamicTool(specs, { title })?.mcpName ?? null
  assert.equal(name('echo_echo (litch MCP Server)'), 'echo_echo')
  assert.equal(name('litch_echo_run'), 'echo_run')
  assert.equal(name('mcp_litch_echo_echo'), 'echo_echo')
  assert.equal(name('mcp__litch__tasks_list'), 'tasks_list')
  assert.equal(name('litch/echo_echo'), 'echo_echo')
  assert.equal(name('litch_echo_echo_more'), null)
  assert.equal(name('echo_echo'), null)
  assert.equal(name('ls -la'), null)
  assert.equal(matchDynamicTool(specs, {}), null)
})

test('Litch 的呈现风格（不带工具的命名空间）进 MCP 服务的 instructions、排在工具的规则后面，不多出工具', () => {
  const echo = {
    type: 'namespace',
    name: 'litch_echo',
    description: 'echo',
    instructions: 'ECHO-RULES',
    tools: [
      { type: 'function', name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
    ],
  }
  assert.equal(
    toolInstructions([echo, PRESENTATION_SPEC]),
    `# Tool instructions: litch_echo\nECHO-RULES\n\n# Tool instructions: litch_presentation\n${PRESENTATION_RULES}`,
  )
  assert.deepEqual(
    dynamicToolSpecs([echo, PRESENTATION_SPEC]).map((spec) => spec.namespace),
    ['litch_echo'],
  )
})

test('Litch 的 MCP 桥起不来（临时目录用不了）：不挂桥，会话照建、回合照跑；之后起得来了接回时照挂', async () => {
  const s = await scene()
  const tmp = process.env.TMPDIR
  // 桥的套接字放在 tmpdir() 下新建的目录里：TMPDIR 指到不存在的地方，监听就起不来
  const broken = join(s.root, 'no-such-tmp')
  try {
    let desktop = await litch(s)
    process.env.TMPDIR = broken
    let thread: any
    let done: any
    try {
      thread = (await desktop.call('thread/start', { cwd: s.cwd, dynamicTools: TOOLS })).thread
      const created = (await s.received()).filter((m) => m.method === 'session/new').at(-1)
      assert.deepEqual(created.params.mcpServers, [])
      done = await turn({ ...s, desktop }, thread.id, text('hello'))
      assert.equal(done.status, 'completed')
    } finally {
      await s.server.close()
    }
    // 适配器重启后头一回合接回 agent 时才挂桥：这时还起不来，回合照跑
    let server = new AcpServer(s.home, s.env)
    let again: Scene = { ...s, server, desktop: client(server) }
    try {
      desktop = await litch(again)
      await desktop.call('thread/resume', { threadId: thread.id })
      done = await turn({ ...again, desktop }, thread.id, text('hello'))
      assert.equal(done.status, 'completed')
      const resumed = (await s.received()).filter((m) => m.method === 'session/resume').at(-1)
      assert.deepEqual(resumed.params.mcpServers, [])
    } finally {
      await server.close()
    }
    // 临时目录好了：会话记着的动态工具还在，再接回时桥照挂上，工具能用
    process.env.TMPDIR = tmp
    server = new AcpServer(s.home, s.env)
    again = { ...s, server, desktop: client(server) }
    try {
      desktop = await litch(again)
      await desktop.call('thread/resume', { threadId: thread.id })
      done = await turn(
        { ...again, desktop },
        thread.id,
        text('tool gemini echo_echo {"text":"back"}'),
      )
      assert.equal(said(done), '结果：回声：{"text":"back"}')
      assert.deepEqual([...violations], [])
    } finally {
      await server.close()
    }
  } finally {
    process.env.TMPDIR = tmp
    await s.restore()
  }
})
