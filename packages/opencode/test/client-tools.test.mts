import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { clientToolSpecs, ECHO_TOOLS } from '../../protocol/src/client-tools-specs.mjs'
import { serverName } from '../src/client-tools.mjs'
import { OpencodeServer } from '../src/server.mjs'
import { client, isolate, skip, text, violations } from './client.mjs'
import { scripted } from './mock-model.mjs'

// 动态工具（客户端工具）：建会话时带 dynamicTools，适配器经自己的 MCP 服务交给 OpenCode 的模型；
// 模型调用时向执行方连接发标准的 item/tool/call，结果（含图片）回到模型。规矩见 protocol/extensions/client-tools.json。

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 握手：声明 clientTools，namespaces 是这条连接能执行的命名空间（空的就是什么都执行不了） */
const handshake = (namespaces: string[] | null) => ({
  clientInfo: { name: 'test', title: null, version: '0' },
  capabilities: {
    experimentalApi: true,
    ...(namespaces ? { litchExtensions: ['clientTools'], litchClientTools: { namespaces } } : {}),
  },
})

/** 模型调用 echo 用的工具名：会话的服务名加 MCP 里的名字（建会话之后才知道） */
const echoName = { value: '' }
const echoCall = (input: object) => ({
  type: 'tool' as const,
  get name() {
    return echoName.value
  },
  input,
})

const toolNames = (body: any): string[] =>
  (body?.tools ?? []).map((tool: any) => String(tool.function?.name ?? tool.name))

// 模型看到的消息里有没有这段文字 / 这张图
const said = (body: any, needle: string) => JSON.stringify(body?.messages ?? []).includes(needle)

test('OpenCode：客户端工具交给声明了的连接执行，文字和图片回到模型，不经 OpenCode 的审批', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      ECHO: [[echoCall({ text: '你好', image: true })], [{ type: 'text', chunks: ['收到。'] }]],
      PLAIN: [[{ type: 'text', chunks: ['没有工具。'] }]],
    }),
    // 什么都要问：客户端工具也走 OpenCode 的审批的话，这里会冒出审批请求
    { permission: { '*': 'ask' } },
  )
  try {
    const desktop = client(env.server)
    await desktop.call('initialize', handshake(['litch_echo']))
    desktop.onRequest((request) =>
      request.method === 'item/tool/call'
        ? {
            success: true,
            contentItems: [
              { type: 'inputText', text: `echo: ${request.params.arguments.text}` },
              { type: 'inputImage', imageUrl: `data:image/png;base64,${PIXEL}` },
            ],
          }
        : undefined,
    )
    const { thread } = await desktop.call('thread/start', {
      cwd: env.cwd,
      dynamicTools: [ECHO_TOOLS],
    })
    echoName.value = `${serverName(thread.id)}_echo_echo`
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('ECHO 试一下'),
    })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
    assert.equal(done.status, 'completed')

    // 模型看得到这个工具，说明里带着命名空间和它的说明
    const asked = env.model.requests.find((body) => toolNames(body).includes(echoName.value))
    assert.ok(asked, `模型的工具里有 ${echoName.value}`)
    const spec = asked.tools.find((tool: any) => tool.function?.name === echoName.value)
    assert.match(spec.function.description, /^\[litch_echo\.echo\] Litch test tools/)

    // 只发了一次 item/tool/call，参数是标准形状，调用号就是条目号；没有别的审批请求
    assert.deepEqual(
      desktop.requests.map((request) => request.method),
      ['item/tool/call'],
    )
    const call = desktop.requests[0].params
    const item = done.items.find((entry: any) => entry.type === 'dynamicToolCall')
    assert.ok(item, '回合里有动态工具条目')
    assert.deepEqual(call, {
      threadId: thread.id,
      turnId: turn.id,
      callId: item.id,
      namespace: 'litch_echo',
      tool: 'echo',
      arguments: { text: '你好', image: true },
    })
    assert.equal(item.namespace, 'litch_echo')
    assert.equal(item.tool, 'echo')
    assert.equal(item.success, true)
    assert.equal(item.status, 'completed')
    assert.deepEqual(item.contentItems, [
      { type: 'inputText', text: 'echo: 你好' },
      { type: 'inputImage', imageUrl: `data:image/png;base64,${PIXEL}` },
    ])

    // 结果回到了模型：文字和图片都在下一次请求里
    const after = env.model.requests.filter((body) => body.tools?.length).at(-1)
    assert.ok(said(after, 'echo: 你好'), '模型拿到了文字结果')
    assert.ok(said(after, PIXEL), '模型拿到了图片')

    // 同一目录下没带动态工具的会话看不到它
    const { thread: other } = await desktop.call('thread/start', { cwd: env.cwd })
    const before = env.model.requests.length
    const plain = (await desktop.call('turn/start', { threadId: other.id, input: text('PLAIN') }))
      .turn
    await desktop.until('turn/completed', (p) => p.turn.id === plain.id, 60000)
    const seen = env.model.requests.slice(before).filter((body) => body.tools?.length)
    assert.ok(seen.length > 0)
    for (const body of seen)
      assert.ok(
        !toolNames(body).some((name) => name.startsWith('litch_')),
        `别的会话看不到这个工具：${toolNames(body).join(', ')}`,
      )
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode：没有能执行的连接时当场回 noExecutor，执行方半路断开按失败结束', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      NOBODY: [[echoCall({ text: '有人吗' })], [{ type: 'text', chunks: ['没人。'] }]],
      HANG: [[echoCall({ text: '等着' })], [{ type: 'text', chunks: ['断了。'] }]],
    }),
  )
  try {
    // 没声明 litch_echo 的连接（官方桌面端、移动端这类）：不交给它，当场失败
    const plain = client(env.server)
    await plain.call('initialize', handshake(null))
    plain.onRequest(() => ({
      success: true,
      contentItems: [{ type: 'inputText', text: '不该来' }],
    }))
    const { thread } = await plain.call('thread/start', {
      cwd: env.cwd,
      dynamicTools: [ECHO_TOOLS],
    })
    echoName.value = `${serverName(thread.id)}_echo_echo`
    const first = (await plain.call('turn/start', { threadId: thread.id, input: text('NOBODY') }))
      .turn
    const done = (await plain.until('turn/completed', (p) => p.turn.id === first.id, 60000)).turn
    assert.deepEqual(plain.requests, [], '没声明的连接收不到 item/tool/call')
    const failed = done.items.find((entry: any) => entry.type === 'dynamicToolCall')
    assert.equal(failed.success, false)
    assert.equal(failed.status, 'failed')
    assert.match(failed.contentItems[0].text, /\[litch:noExecutor\]/)
    const after = env.model.requests.filter((body) => body.tools?.length).at(-1)
    assert.ok(said(after, '[litch:noExecutor]'), '模型拿到了 noExecutor 的说明')

    // 声明了的连接接了这次调用、还没答就断开：按失败结束，不改交给别的连接
    const desktop = client(env.server)
    await desktop.call('initialize', handshake(['litch_echo']))
    desktop.onRequest(() => undefined)
    await desktop.call('thread/resume', { threadId: thread.id })
    const hang = (await desktop.call('turn/start', { threadId: thread.id, input: text('HANG') }))
      .turn
    await desktop.request('item/tool/call')
    env.server.closePeer(desktop.peer)
    const ended = (await plain.until('turn/completed', (p) => p.turn.id === hang.id, 60000)).turn
    const broken = ended.items.find((entry: any) => entry.type === 'dynamicToolCall')
    assert.equal(broken.success, false)
    assert.match(broken.contentItems[0].text, /^\[litch:failed\]/)
    assert.deepEqual(plain.requests, [], '断开后没有改交给没声明的连接')
    assert.ok(
      plain.of('serverRequest/resolved', thread.id).length >= 1,
      '订阅者收到这次调用了结的通知',
    )
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode：动态工具记在会话上，适配器重启后恢复会话照样能用', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(
    scripted({
      AGAIN: [[echoCall({ text: '重启后' })], [{ type: 'text', chunks: ['好。'] }]],
    }),
  )
  let second: OpencodeServer | null = null
  try {
    const first = client(env.server)
    await first.call('initialize', handshake(['litch_echo']))
    const { thread } = await first.call('thread/start', {
      cwd: env.cwd,
      dynamicTools: [ECHO_TOOLS],
    })
    echoName.value = `${serverName(thread.id)}_echo_echo`
    await env.server.close()

    second = new OpencodeServer(env.home)
    const desktop = client(second)
    await desktop.call('initialize', handshake(['litch_echo']))
    desktop.onRequest((request) =>
      request.method === 'item/tool/call'
        ? { success: true, contentItems: [{ type: 'inputText', text: 'echo again' }] }
        : undefined,
    )
    await desktop.call('thread/resume', { threadId: thread.id })
    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: text('AGAIN'),
    })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
    const item = done.items.find((entry: any) => entry.type === 'dynamicToolCall')
    assert.equal(item?.success, true)
    assert.equal(desktop.requests[0]?.params.callId, item.id)
    // 重读历史也画成动态工具条目
    const read = await desktop.call('thread/read', { threadId: thread.id, includeTurns: true })
    const replayed = read.thread.turns
      .flatMap((entry: any) => entry.items)
      .find((entry: any) => entry.id === item.id)
    assert.equal(replayed.type, 'dynamicToolCall')
    assert.deepEqual(replayed.contentItems, [{ type: 'inputText', text: 'echo again' }])
  } finally {
    await second?.close()
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})

test('OpenCode：桌面端带的整套客户端工具（浏览器、Computer Use、机器、定时任务、会话）OpenCode 都收下交给模型', {
  skip,
  timeout: 120000,
}, async () => {
  const env = await isolate(scripted({ ALL: [[{ type: 'text', chunks: ['看到了。'] }]] }))
  try {
    const desktop = client(env.server)
    await desktop.call('initialize', handshake(['litch_browser', 'litch_computer']))
    const machine = { name: '这台', hostname: 'host', system: 'macOS' }
    const specs = clientToolSpecs(Object.values(CLIENT_TOOL_NAMESPACE), {
      machine: { session: machine, desktop: machine },
      desktopPlatform: 'darwin',
    })
    const { thread } = await desktop.call('thread/start', { cwd: env.cwd, dynamicTools: specs })
    const { turn } = await desktop.call('turn/start', { threadId: thread.id, input: text('ALL') })
    const done = (await desktop.until('turn/completed', (p) => p.turn.id === turn.id, 60000)).turn
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const asked = env.model.requests.find((body) =>
      toolNames(body).some((name) => name.startsWith('litch_')),
    )
    const names = toolNames(asked).filter((name) => name.startsWith(serverName(thread.id)))
    const expected = specs.reduce((count, spec) => count + spec.tools.length, 0)
    assert.equal(names.length, expected, names.join(', '))
    for (const name of names) assert.ok(name.length <= 64, name)
    for (const spec of specs)
      assert.ok(
        asked.tools.some((tool: any) =>
          String(tool.function?.description).startsWith(`[${spec.name}.`),
        ),
        `${spec.name} 的工具交给了模型`,
      )
    // request_sign_in 加的可选提示参数新会话里模型看得到
    const signIn = asked.tools.find((tool: any) =>
      String(tool.function?.description).startsWith('[litch_browser.request_sign_in]'),
    )
    for (const name of ['origin', 'usernameRef', 'passwordRef', 'submitRef'])
      assert.ok(name in (signIn?.function?.parameters?.properties ?? {}), name)
  } finally {
    await env.restore()
  }
  assert.deepEqual([...violations], [])
})
