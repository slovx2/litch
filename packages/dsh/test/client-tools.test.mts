import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { clientToolSpecs, ECHO_TOOLS } from '../../protocol/src/client-tools-specs.mjs'
import { EXTENSION, EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'
import { dshClientTools, NAMESPACE_DESCRIPTION_LIMIT } from '../src/client-tools.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'
import { type MockBlock, scripted } from './mock-model.mjs'

// 客户端工具（决 276）：thread/start.dynamicTools 记到会话上，经适配器插进 dsh 的插件交给模型（client-tools.mts），
// 模型调用时照 client-tools.json 的规矩向执行方发标准的 item/tool/call。真实的 dsh（0.2.0-rc.2）加回环假模型。

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
// 1×1 的 PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const ECHO_NAME = 'litch_echo__echo'
const echoing: MockBlock[][] = [
  [{ type: 'tool_use', name: ECHO_NAME, input: { text: 'hi', image: true } }],
  [{ type: 'text', chunks: ['收到。'] }],
]
const respond = scripted({ ECHO: echoing })

// 握手：声明了 clientTools、能执行 litch_echo 的（Litch 桌面端），和什么都没声明的（官方桌面端、移动端）
const declaring = {
  clientInfo: { name: 'litch', version: '0' },
  capabilities: {
    [EXTENSIONS_CAPABILITY]: [EXTENSION.clientTools],
    litchClientTools: { namespaces: [CLIENT_TOOL_NAMESPACE.echo] },
  },
}
const plain = { clientInfo: { name: 'other', version: '0' } }

// 模型收到的某次调用的工具结果：[字, 是不是报错, 内容块的种类]，还没收到是 null
function told(requests: any[], callId: string): [string, boolean, string[]] | null {
  const block = requests
    .flatMap((body) => body.messages ?? [])
    .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
    .find((entry: any) => entry.type === 'tool_result' && entry.tool_use_id === callId)
  if (!block) return null
  const parts: any[] = Array.isArray(block.content) ? block.content : [block.content]
  return [
    parts.map((entry: any) => (typeof entry === 'string' ? entry : (entry.text ?? ''))).join(''),
    block.is_error === true,
    parts.map((entry: any) => (typeof entry === 'string' ? 'text' : entry.type)),
  ]
}

// 第 n 次（从 1 数）出现的、给模型的这个工具的调用号
function callIds(requests: any[], name: string): string[] {
  return requests
    .flatMap((body) => body.messages ?? [])
    .filter((message: any) => message.role === 'assistant' && Array.isArray(message.content))
    .flatMap((message: any) => message.content)
    .filter((block: any) => block.type === 'tool_use' && block.name === name)
    .map((block: any) => String(block.id))
    .filter((id: string, index: number, all: string[]) => all.indexOf(id) === index)
}

test('dsh 客户端工具：摊平成模型看到的工具，命名空间说明接在第一个工具前面，形状不对整份拒绝', () => {
  const tools = dshClientTools([
    ECHO_TOOLS,
    {
      type: 'function',
      name: 'plain',
      description: '没有命名空间',
      inputSchema: { type: 'object' },
    },
  ])
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.namespace, tool.tool]),
    [
      [ECHO_NAME, 'litch_echo', 'echo'],
      ['functions__plain', null, 'plain'],
    ],
  )
  assert.equal(
    tools[0]?.description,
    `[litch_echo.echo] ${ECHO_TOOLS.description}\n\n${ECHO_TOOLS.tools[0]?.description}`,
  )
  assert.equal(tools[0]?.parameters, ECHO_TOOLS.tools[0]?.inputSchema)
  assert.equal(tools[1]?.description, '[functions.plain] 没有命名空间')
  assert.deepEqual(dshClientTools(undefined), [])
  // 现有的命名空间都摊得开，名字都合模型接口的要求
  const all = dshClientTools(
    clientToolSpecs(Object.values(CLIENT_TOOL_NAMESPACE), {
      machine: null,
      desktopPlatform: 'darwin',
    }),
  )
  assert.ok(all.length > 20)
  for (const tool of all) assert.match(tool.name, /^litch_[a-z]+__[a-zA-Z0-9_-]+$/)
  const reject = (raw: unknown, pattern: RegExp) =>
    assert.throws(
      () => dshClientTools(raw),
      (error: any) => error.code === -32602 && pattern.test(error.message),
    )
  reject({}, /数组/)
  reject([{ type: 'other' }], /function 或 namespace/)
  reject([{ type: 'function', name: 'x' }], /inputSchema/)
  reject(
    [{ ...ECHO_TOOLS, description: 'x'.repeat(NAMESPACE_DESCRIPTION_LIMIT + 1) }],
    new RegExp(`${NAMESPACE_DESCRIPTION_LIMIT}`),
  )
  reject([ECHO_TOOLS, ECHO_TOOLS], /重复/)
  reject([{ type: 'function', name: 'bad name', inputSchema: {} }], /字母、数字/)
})

test('dsh 客户端工具：建会话带的工具模型看得到，调用交给声明了的连接，答复连图片回到模型；没人能执行当场失败；重启后还在', {
  timeout: 300000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const home = join(env.root, 'home')
  let server = new DshServer(home)
  try {
    const desktop = client(server)
    const other = client(server)
    await desktop.call('initialize', declaring)
    await other.call('initialize', plain)
    const answered: any[] = []
    desktop.onRequest((request) => {
      if (request.method !== 'item/tool/call') return {}
      answered.push(request)
      return {
        success: true,
        contentItems: [
          { type: 'inputText', text: `echo:${request.params.arguments.text}` },
          { type: 'inputImage', imageUrl: PNG },
        ],
      }
    })
    other.onRequest(() => ({}))
    const { thread } = await desktop.call('thread/start', {
      cwd: env.cwd,
      dynamicTools: [ECHO_TOOLS],
    })
    const threadId = thread.id

    // 一、发起回合的连接声明了：调用交给它，参数是标准形状，答复回到模型，条目是动态工具条目
    const { turn } = await desktop.call('turn/start', { threadId, input: text('ECHO 一下') })
    const done = await desktop.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === turn.id,
    )
    const sent = env.model.requests.find((body) =>
      body.tools?.some((tool: any) => tool.name === ECHO_NAME),
    )
    const spec = sent.tools.find((tool: any) => tool.name === ECHO_NAME)
    assert.equal(spec.description.startsWith('[litch_echo.echo] Litch test tools.'), true)
    assert.deepEqual(spec.input_schema, ECHO_TOOLS.tools[0]?.inputSchema)
    const [callId] = callIds(env.model.requests, ECHO_NAME)
    assert.equal(answered.length, 1)
    assert.deepEqual(answered[0].params, {
      threadId,
      turnId: turn.id,
      callId,
      namespace: 'litch_echo',
      tool: 'echo',
      arguments: { text: 'hi', image: true },
    })
    assert.equal(other.requests.length, 0)
    const result = told(env.model.requests, callId as string)
    assert.equal(result?.[0].includes('echo:hi'), true)
    assert.equal(result?.[1], false)
    // 图片存进了 dsh 的附件，到模型那里是一张图（dsh 在前面加一句说明，写着附件存在哪）
    assert.equal(result?.[0].includes('图片没能交给模型'), false, String(result?.[0]))
    assert.equal(result?.[2].includes('image'), true)
    const item = done.turn.items.find((entry: any) => entry.type === 'dynamicToolCall')
    assert.deepEqual(
      { ...item, durationMs: null },
      {
        type: 'dynamicToolCall',
        id: callId,
        namespace: 'litch_echo',
        tool: 'echo',
        arguments: { text: 'hi', image: true },
        status: 'completed',
        contentItems: [{ type: 'inputText', text: 'echo:hi' }],
        success: true,
        durationMs: null,
      },
    )
    // 重读历史是同一个条目
    const read = await desktop.call('thread/read', { threadId, includeTurns: true })
    assert.deepEqual(
      read.thread.turns.at(-1).items.find((entry: any) => entry.type === 'dynamicToolCall'),
      item,
    )

    // 二、没声明的连接发起回合、声明了的连着订阅：交给订阅着的那条
    await other.call('thread/resume', { threadId })
    const second = await other.call('turn/start', { threadId, input: text('ECHO 再来') })
    await other.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === second.turn.id,
    )
    assert.equal(answered.length, 2)
    assert.equal(answered[1].params.turnId, second.turn.id)
    assert.equal(other.requests.length, 0)

    // 三、只有没声明的连接在：当场回 noExecutor，不发给它，回合照常结束
    const lonely = await other.call('thread/start', { cwd: env.cwd, dynamicTools: [ECHO_TOOLS] })
    const third = await other.call('turn/start', {
      threadId: lonely.thread.id,
      input: text('ECHO 没人'),
    })
    await other.until(
      'turn/completed',
      (params) => params.threadId === lonely.thread.id && params.turn.id === third.turn.id,
    )
    assert.equal(other.requests.length, 0)
    assert.equal(answered.length, 2)
    const missing = told(env.model.requests, callIds(env.model.requests, ECHO_NAME)[2] as string)
    assert.equal(missing?.[1], true)
    assert.match(missing?.[0] ?? '', /\[litch:noExecutor\] /)

    // 四、没带工具的会话模型看不到它
    const bare = await desktop.call('thread/start', { cwd: env.cwd })
    const before = env.model.requests.length
    const fourth = await desktop.call('turn/start', {
      threadId: bare.thread.id,
      input: text('随便说一句'),
    })
    await desktop.until(
      'turn/completed',
      (params) => params.threadId === bare.thread.id && params.turn.id === fourth.turn.id,
    )
    const bareRequests = env.model.requests.slice(before).filter((body) => body.tools?.length)
    assert.ok(bareRequests.length > 0)
    for (const body of bareRequests)
      assert.equal(
        body.tools.some((tool: any) => tool.name.startsWith('litch_')),
        false,
      )

    // 五、适配器（连同 dsh）重启：工具记在会话上，恢复会话后照样能调
    await server.close()
    server = new DshServer(home)
    const again = client(server)
    await again.call('initialize', declaring)
    const later: any[] = []
    again.onRequest((request) => {
      if (request.method !== 'item/tool/call') return {}
      later.push(request)
      return { success: true, contentItems: [{ type: 'inputText', text: 'echo:again' }] }
    })
    await again.call('thread/resume', { threadId })
    const fifth = await again.call('turn/start', { threadId, input: text('ECHO 重启以后') })
    await again.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === fifth.turn.id,
    )
    assert.equal(later.length, 1)
    assert.equal(later[0].params.namespace, 'litch_echo')
    const lastCall = callIds(env.model.requests, ECHO_NAME).at(-1) as string
    assert.equal(told(env.model.requests, lastCall)?.[0], 'echo:again')
    assert.deepEqual([...violations], [])
  } finally {
    await server.close()
    await env.restore()
  }
})

test('dsh 客户端工具：现有的命名空间（浏览器、Computer Use、litch_machine、litch_tasks、litch_sessions）都装得上，模型全看得到', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length
      ? [{ type: 'text', chunks: ['好的。'] }]
      : [{ type: 'text', chunks: ['标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    await desktop.call('initialize', declaring)
    const specs = clientToolSpecs(Object.values(CLIENT_TOOL_NAMESPACE), {
      machine: null,
      desktopPlatform: 'darwin',
    })
    const expected = dshClientTools(specs).map((tool) => tool.name)
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd, dynamicTools: specs })
    const { turn } = await desktop.call('turn/start', { threadId: thread.id, input: text('看看') })
    await desktop.until(
      'turn/completed',
      (params) => params.threadId === thread.id && params.turn.id === turn.id,
    )
    const sent = env.model.requests.find((body) => body.tools?.length)
    const names = sent.tools.map((tool: any) => tool.name)
    assert.deepEqual(
      expected.filter((name) => !names.includes(name)),
      [],
    )
    assert.deepEqual([...violations], [])
  } finally {
    await server.close()
    await env.restore()
  }
})

test('dsh 客户端工具：回合被打断时撤回还在等的调用；执行方断开时这次调用按失败结束，不改交给别人', {
  timeout: 180000,
}, async () => {
  const env = await isolate((body) =>
    body.tools?.length ? respond(body) : [{ type: 'text', chunks: ['mock 标题'] }],
  )
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    const backup = client(server)
    await desktop.call('initialize', declaring)
    await backup.call('initialize', declaring)
    desktop.onRequest((request) => (request.method === 'item/tool/call' ? undefined : {}))
    backup.onRequest((request) => (request.method === 'item/tool/call' ? undefined : {}))
    const { thread } = await desktop.call('thread/start', {
      cwd: env.cwd,
      dynamicTools: [ECHO_TOOLS],
    })
    const threadId = thread.id
    await backup.call('thread/resume', { threadId })
    const pending = async (peer: ReturnType<typeof client>, n: number) => {
      for (let waited = 0; waited < 20000; waited += 20) {
        const found = peer.requests.filter((entry) => entry.method === 'item/tool/call')
        if (found.length >= n) return found[n - 1]
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('等工具调用超时')
    }

    // 一、打断：执行方收到 serverRequest/resolved，回合按打断结束
    const first = await desktop.call('turn/start', { threadId, input: text('ECHO 等着') })
    const held = await pending(desktop, 1)
    await desktop.call('turn/interrupt', { threadId, turnId: first.turn.id })
    const stopped = await desktop.until(
      'turn/completed',
      (params) => params.threadId === threadId && params.turn.id === first.turn.id,
    )
    assert.equal(stopped.turn.status, 'interrupted')
    await desktop.until('serverRequest/resolved', (params) => params.requestId === held.id)
    // 晚到的答复没人要
    await desktop.respond(held, { success: true, contentItems: [] })

    // 二、执行方断开：调用按失败结束、模型拿到 [litch:failed]，订阅着的另一条声明了的连接也不接手。
    // 换一个会话：被打断的回合留下的工具结果和新的一句并在一条消息里，假模型认不出这是新的一句
    const other = (await desktop.call('thread/start', { cwd: env.cwd, dynamicTools: [ECHO_TOOLS] }))
      .thread.id
    await backup.call('thread/resume', { threadId: other })
    const second = await desktop.call('turn/start', { threadId: other, input: text('ECHO 断开') })
    await pending(desktop, 2)
    server.closePeer(desktop.peer)
    const ended = await backup.until(
      'turn/completed',
      (params) => params.threadId === other && params.turn.id === second.turn.id,
    )
    assert.equal(ended.turn.status, 'completed')
    assert.equal(backup.requests.filter((entry) => entry.method === 'item/tool/call').length, 0)
    const lost = told(env.model.requests, callIds(env.model.requests, ECHO_NAME).at(-1) as string)
    assert.equal(lost?.[1], true)
    assert.match(lost?.[0] ?? '', /\[litch:failed\] /)
    const item = ended.turn.items.find((entry: any) => entry.type === 'dynamicToolCall')
    assert.equal(item.status, 'failed')
    assert.equal(item.success, false)
    assert.deepEqual([...violations], [])
  } finally {
    await server.close()
    await env.restore()
  }
})
