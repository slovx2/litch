// 客户端工具（clientTools 扩展）：握手时声明、建会话带工具、认 item/tool/call、
// 设备开关、交给主进程、卡片、超时、回合结束和打断、连接断开、引擎撤回请求。对着假对端和假的主进程跑。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientToolNamespaceSpec } from '../../protocol/src/client-tools.mjs'
import { PRESENTATION_RULES } from '../../protocol/src/client-tools-presentation.mjs'
import type { JsonRpcMessage, Thread, ThreadItem } from '../../protocol/src/index.mjs'
import {
  CALL_TIMEOUT_MS,
  CLIENT_TOOL,
  type ClientAskRequest,
  type ClientToolPort,
  checkSaved,
  connectChannel,
  createCore,
  createMockCore,
  createPortPair,
  type DeviceStore,
  type DeviceView,
  reduceSession,
  type SavedDevices,
  type SessionOp,
  type SessionView,
  type SidebarView,
  serveChannel,
  type ToolCallItem,
  type ToolToCore,
  type ToolToMain,
} from '../src/index.mjs'
import { IMAGE_CHARS, IMAGE_KEEP, projectItem } from '../src/projection/items.mjs'
import { fakeOpener, type Handler } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const never = { aborted: false, addEventListener() {} }

/** 主进程发来的消息去掉 type 那一项（逐种去，不把几种并成一种） */
type Bare<T> = T extends unknown ? Omit<T, 'type'> : never

/** 假的主进程：记下核心发来的，能以主进程的身份回话 */
function fakeMain(namespaces: string[]) {
  const sent: ToolToMain[] = []
  let inbox: ((message: ToolToCore) => void) | null = null
  const port: ClientToolPort = {
    namespaces: () => namespaces,
    post: (message) => sent.push(structuredClone(message)),
    listen(handler) {
      inbox = handler
    },
  }
  return {
    port,
    sent,
    reply: (message: Bare<ToolToCore>) => inbox?.({ type: CLIENT_TOOL, ...message } as ToolToCore),
    of: <O extends ToolToMain['op']>(op: O) =>
      sent.filter((message): message is Extract<ToolToMain, { op: O }> => message.op === op),
  }
}

function setup(
  options: {
    namespaces?: string[] | null
    engine?: string
    /** runtime/info 里声明的扩展；不给就是没有声明的旧适配器 */
    extensions?: string[]
    kind?: 'local' | 'ssh'
    threads?: Thread[]
  } = {},
) {
  const threads = options.threads ?? [
    thread({ id: 'a', cwd: '/work/app', turns: [turn('t1', [], { status: 'inProgress' })] }),
  ]
  const handlers: Record<string, Handler> = {
    'runtime/info': () => ({
      engine: options.engine ?? 'pi',
      protocolVersion: '0.163.0',
      cliBuild: '0.99.1',
      capabilities: [],
      releaseReady: true,
      ...(options.extensions ? { extensions: options.extensions } : {}),
    }),
    'project/list': () => ({ data: [], nextCursor: null }),
    'thread/list': () => ({
      data: threads.map((entry) => ({ ...entry, turns: [] })),
      nextCursor: null,
      backwardsCursor: null,
    }),
    'thread/resume': (params) => {
      const found = threads.find((entry) => entry.id === (params as { threadId: string }).threadId)
      return { thread: found, model: 'm', reasoningEffort: null, sandbox: { type: 'readOnly' } }
    },
    'thread/start': () => {
      const created = thread({ id: 'new', preview: '', turns: [] })
      threads.push(created)
      return { thread: created, model: 'm', reasoningEffort: null, sandbox: { type: 'readOnly' } }
    },
    'turn/start': () => ({ turn: turn('srv-1', [], { status: 'inProgress' }) }),
    'turn/interrupt': () => ({}),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  }
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const main = options.namespaces === null ? null : fakeMain(options.namespaces ?? ['litch_echo'])
  const kind = options.kind ?? 'local'
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    ...(main ? { clientTools: main.port } : {}),
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind,
        target:
          kind === 'ssh'
            ? { kind: 'host', host: 'box', port: 2222, user: 'dev', keyFile: null }
            : null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const sidebar = { view: null as SidebarView | null }
  core.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot: (data) => {
        sidebar.view = data as SidebarView
      },
      delta: (ops) => {
        for (const op of ops as { op: string; session?: SidebarView['sessions'][number] }[]) {
          if (op.op !== 'session.upsert' || !op.session || !sidebar.view) continue
          const { session } = op
          sidebar.view.sessions = [
            ...sidebar.view.sessions.filter((entry) => entry.id !== session.id),
            session,
          ]
        }
      },
      error() {},
    },
  )
  const app = { devices: [] as DeviceView[] }
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        app.devices = (data as { devices: DeviceView[] }).devices
      },
      delta: (ops) => {
        for (const op of ops as { op: string; device?: DeviceView }[]) {
          const { device } = op
          if (op.op === 'device.upsert' && device) {
            app.devices = [...app.devices.filter((entry) => entry.id !== device.id), device]
          }
        }
      },
      error() {},
    },
  )
  const command = (name: string, params: object) => core.command(name, params, never)
  const summary = (id = 'a') => sidebar.view?.sessions.find((entry) => entry.id === id)
  const call = (params: Record<string, unknown>, id?: string | number) =>
    peer.last().ask(
      'item/tool/call',
      {
        threadId: 'a',
        turnId: 't1',
        callId: 'c1',
        namespace: 'litch_echo',
        tool: 'echo',
        arguments: { text: 'hi' },
        ...params,
      },
      id,
    )
  return { core, peer, time, main, command, summary, call, app }
}

const resultOf = (message: JsonRpcMessage) =>
  (message as { result?: { success: boolean; contentItems: { type: string; text?: string }[] } })
    .result

test('握手：主进程报了能执行的命名空间就声明 clientTools 扩展并列出它们；没有就不声明', async () => {
  const withTools = setup({ namespaces: ['litch_echo', 'litch_browser'] })
  withTools.core.start()
  await settle()
  const init = withTools.peer.last().seen.find((entry) => entry.method === 'initialize')
  assert.ok(init)
  const capabilities = (init.params as { capabilities: Record<string, unknown> }).capabilities
  assert.ok((capabilities.litchExtensions as string[]).includes('clientTools'))
  assert.deepEqual(capabilities.litchClientTools, { namespaces: ['litch_echo', 'litch_browser'] })

  for (const namespaces of [null, []]) {
    const bare = setup({ namespaces })
    bare.core.start()
    await settle()
    const hello = bare.peer.last().seen.find((entry) => entry.method === 'initialize')
    assert.ok(hello)
    const caps = (hello.params as { capabilities: Record<string, unknown> }).capabilities
    assert.ok(!(caps.litchExtensions as string[]).includes('clientTools'))
    assert.equal(caps.litchClientTools, undefined)
  }
})

test('建会话：带上这台桌面能执行的那几份工具定义（不看开关），没有定义的命名空间跳过；没声明的旧适配器里只有 dsh 不带', async () => {
  const world = setup({ namespaces: ['litch_echo', 'litch_unknown'] })
  world.core.start()
  await settle()
  await world.command('session.create', { deviceId: 'local', cwd: '/work', text: '你好' })
  const start = world.peer.last().seen.find((entry) => entry.method === 'thread/start')
  assert.ok(start)
  const tools = (start.params as { dynamicTools?: { name: string; type: string }[] }).dynamicTools
  // 最后是呈现风格（不带工具的命名空间，client-tools-presentation.mts）
  assert.deepEqual(
    tools?.map((entry) => [entry.type, entry.name]),
    [
      ['namespace', 'litch_echo'],
      ['namespace', 'litch_presentation'],
    ],
  )

  const dsh = setup({ engine: 'dsh' })
  dsh.core.start()
  await settle()
  await dsh.command('session.create', { deviceId: 'local', cwd: '/work', text: '你好' })
  const plain = dsh.peer.last().seen.find((entry) => entry.method === 'thread/start')
  assert.ok(plain)
  assert.equal((plain.params as { dynamicTools?: unknown }).dynamicTools, undefined)

  // 声明了的按声明：报了 clientTools 的带，没报的（dsh、还没接上客户端工具的引擎）不带
  for (const [engine, extensions, expected] of [
    ['pi', ['clientTools'], true],
    ['dsh', ['clientTools'], true],
    ['opencode', [], false],
    ['gemini', ['planConfirmation'], false],
  ] as const) {
    const declared = setup({ engine, extensions: [...extensions] })
    declared.core.start()
    await settle()
    await declared.command('session.create', { deviceId: 'local', cwd: '/work', text: '你好' })
    const sent = declared.peer.last().seen.find((entry) => entry.method === 'thread/start')
    assert.ok(sent)
    const given = (sent.params as { dynamicTools?: unknown[] }).dynamicTools
    assert.equal(given !== undefined, expected, `${engine} 声明了 ${extensions.join('、') || '空'}`)
  }

  const none = setup({ namespaces: null })
  none.core.start()
  await settle()
  await none.command('session.create', { deviceId: 'local', cwd: '/work', text: '你好' })
  const bare = none.peer.last().seen.find((entry) => entry.method === 'thread/start')
  assert.ok(bare)
  // 这台桌面什么都执行不了：只剩呈现风格
  assert.deepEqual(
    (bare.params as { dynamicTools?: { name: string }[] }).dynamicTools?.map((entry) => entry.name),
    ['litch_presentation'],
  )
})

test('建会话：呈现风格（litch_presentation，不带工具、只带 instructions）排在最后；原生 codex 不带', async () => {
  for (const [engine, expected] of [
    ['claude-code', ['litch_echo', 'litch_presentation']],
    ['opencode', ['litch_echo', 'litch_presentation']],
    ['codex', ['litch_echo']],
  ] as const) {
    const world = setup({ namespaces: ['litch_echo'], engine, extensions: ['clientTools'] })
    world.core.start()
    await settle()
    await world.command('session.create', { deviceId: 'local', cwd: '/work', text: '你好' })
    const start = world.peer.last().seen.find((entry) => entry.method === 'thread/start')
    assert.ok(start)
    const tools = (start.params as { dynamicTools?: ClientToolNamespaceSpec[] }).dynamicTools
    assert.deepEqual(
      tools?.map((entry) => entry.name),
      expected,
      engine,
    )
    const presentation = tools?.find((entry) => entry.name === 'litch_presentation')
    if (!presentation) continue
    assert.deepEqual(presentation.tools, [])
    assert.equal(presentation.instructions, PRESENTATION_RULES)
    assert.match(presentation.instructions ?? '', /appear in Litch/)
    assert.match(presentation.instructions ?? '', /Mermaid/)
  }
})

test('调用：别的命名空间回“方法不存在”；litch_ 的交给主进程，带着设备、harness、工作目录，结果原样回给引擎', async () => {
  const { core, main, call } = setup()
  core.start()
  await settle()
  const other = await call({ namespace: 'browser' })
  assert.equal((other as { error?: { code: number } }).error?.code, -32601)
  const none = await call({ namespace: null })
  assert.equal((none as { error?: { code: number } }).error?.code, -32601)
  assert.equal(main?.sent.length, 0)

  // 会话没在核心里开着（没人看）也照样处理
  const answer = call({ arguments: { text: 'hello', image: true } }, 77)
  await settle()
  const [sent] = main?.of('call') ?? []
  assert.ok(sent)
  const { invocation } = sent
  assert.deepEqual(
    {
      threadId: invocation.threadId,
      turnId: invocation.turnId,
      callId: invocation.callId,
      namespace: invocation.namespace,
      tool: invocation.tool,
      arguments: invocation.arguments,
      device: invocation.device,
      harness: invocation.harness,
      cwd: invocation.cwd,
    },
    {
      threadId: 'a',
      turnId: 't1',
      callId: 'c1',
      namespace: 'litch_echo',
      tool: 'echo',
      arguments: { text: 'hello', image: true },
      device: { id: 'local', name: '本机', kind: 'local', target: null },
      harness: 'pi',
      cwd: '/work/app',
    },
  )
  const response = {
    success: true,
    contentItems: [{ type: 'inputText' as const, text: 'hello' }],
  }
  main?.reply({ op: 'result', id: invocation.id, response })
  assert.deepEqual(resultOf(await answer), response)
  // 结果之后再来的同一个标识不理
  main?.reply({ op: 'result', id: invocation.id, response })
})

test('调用：远程设备交给执行器的是 ssh 目标，种类是 ssh', async () => {
  const { core, main, call } = setup({ kind: 'ssh' })
  core.start()
  await settle()
  void call({})
  await settle()
  const [sent] = main?.of('call') ?? []
  assert.deepEqual(sent?.invocation.device, {
    id: 'local',
    name: '本机',
    kind: 'ssh',
    target: 'ssh://dev@box:2222',
  })
})

test('开关：浏览器默认开、Computer Use 默认关；关着当场回 disabled 不找主进程，打开之后下一次就交过去；执行不了的回 noExecutor', async () => {
  const { core, main, call, command, app } = setup({
    namespaces: ['litch_browser', 'litch_computer'],
  })
  core.start()
  await settle()
  const pi = (tools: { browser: boolean; computer: boolean }) => ({
    pi: { taskCards: null, ...tools },
  })
  assert.deepEqual(app.devices[0]?.tools, {
    browser: true,
    computer: false,
    harnesses: pi({ browser: true, computer: false }),
  })

  const off = resultOf(await call({ namespace: 'litch_computer', tool: 'list_apps' }))
  assert.equal(off?.success, false)
  assert.match(off?.contentItems[0]?.text ?? '', /^\[litch:disabled\] .*Computer Use/)
  assert.equal(main?.of('call').length, 0)

  await command('device.tools.set', { deviceId: 'local', computer: true, browser: false })
  await settle()
  assert.deepEqual(app.devices.find((entry) => entry.id === 'local')?.tools, {
    browser: false,
    computer: true,
    harnesses: pi({ browser: false, computer: true }),
  })
  void call({ namespace: 'litch_computer', tool: 'list_apps' })
  await settle()
  assert.equal(main?.of('call').length, 1)
  const browser = resultOf(await call({ namespace: 'litch_browser', tool: 'tabs' }))
  assert.match(browser?.contentItems[0]?.text ?? '', /^\[litch:disabled\] .*browser/)

  const echo = resultOf(await call({ namespace: 'litch_echo' }))
  assert.match(echo?.contentItems[0]?.text ?? '', /^\[litch:noExecutor\]/)

  // 只有 echo 的桌面：设置页不出这两个开关
  const bare = setup()
  bare.core.start()
  await settle()
  assert.deepEqual(bare.app.devices[0]?.tools, {
    browser: null,
    computer: null,
    harnesses: pi({ browser: true, computer: false }),
  })
})

test('卡片：主进程要用户点头时在这个会话里出一张（会话没开着也载入），侧栏标成等待；答了回给主进程', async () => {
  const { core, main, call, command, summary } = setup()
  core.start()
  await settle()
  const answer = call({})
  await settle()
  const id = main?.of('call')[0]?.invocation.id ?? ''
  main?.reply({
    op: 'ask',
    id,
    askId: 'k1',
    ask: { kind: 'site', origin: 'https://example.com', url: 'https://example.com/a' },
  })
  await settle()
  assert.equal(summary()?.status, 'waiting')
  assert.equal(summary()?.waitingFor, 'approval')
  const session = watchSession(core)
  await settle()
  const request = session.seen.view?.requests[0] as ClientAskRequest | undefined
  assert.equal(request?.kind, 'clientAsk')
  assert.deepEqual(request?.ask, {
    kind: 'site',
    origin: 'https://example.com',
    url: 'https://example.com/a',
  })
  assert.deepEqual(request?.device, { name: '本机', kind: 'local', host: 'dev@mac' })
  assert.deepEqual(
    request?.options.map((option) => option.role),
    ['accept', 'acceptSession', 'acceptAlways', 'decline'],
  )
  await command('session.respond', {
    deviceId: 'local',
    sessionId: 'a',
    requestId: request?.id,
    optionId: 'session',
  })
  await settle()
  assert.deepEqual(main?.of('answer'), [
    { type: CLIENT_TOOL, op: 'answer', askId: 'k1', answer: 'session' },
  ])
  assert.equal(session.seen.view?.requests.length, 0)
  assert.equal(summary()?.waitingFor, null)

  // 第二张卡片
  main?.reply({
    op: 'ask',
    id,
    askId: 'k2',
    ask: { kind: 'site', origin: 'https://b.example', url: 'https://b.example/' },
  })
  await settle()
  assert.equal(session.seen.view?.requests.length, 1)
  // 执行器不等了（askDone）：卡片撤掉，不再回答
  main?.reply({ op: 'askDone', askId: 'k2' })
  await settle()
  assert.equal(session.seen.view?.requests.length, 0)
  assert.equal(main?.of('answer').length, 1)
  main?.reply({ op: 'result', id, response: { success: true, contentItems: [] } })
  assert.equal(resultOf(await answer)?.success, true)
})

test('超时：到点取消并回 failed；卡片挂着的时候停表', async () => {
  const { core, main, call, time } = setup()
  core.start()
  await settle()
  const first = call({})
  await settle()
  const id = main?.of('call')[0]?.invocation.id ?? ''
  main?.reply({
    op: 'ask',
    id,
    askId: 'k1',
    ask: { kind: 'site', origin: 'https://a.example', url: 'https://a.example/' },
  })
  await settle()
  // 等人答的这一段不算
  time.advance(CALL_TIMEOUT_MS * 3)
  await settle()
  assert.equal(main?.of('cancel').length, 0)
  main?.reply({ op: 'askDone', askId: 'k1' })
  time.advance(CALL_TIMEOUT_MS - 1)
  await settle()
  assert.equal(main?.of('cancel').length, 0)
  time.advance(1)
  const timedOut = resultOf(await first)
  assert.equal(timedOut?.success, false)
  assert.match(timedOut?.contentItems[0]?.text ?? '', /^\[litch:failed\]/)
  assert.deepEqual(main?.of('cancel'), [{ type: CLIENT_TOOL, op: 'cancel', id }])
})

test('执行器在别处等人（hold）：停表，不等了表从头算', async () => {
  const { core, main, call, time } = setup()
  core.start()
  await settle()
  const first = call({})
  await settle()
  const id = main?.of('call')[0]?.invocation.id ?? ''
  main?.reply({ op: 'hold', id, held: true })
  await settle()
  time.advance(CALL_TIMEOUT_MS * 3)
  await settle()
  assert.equal(main?.of('cancel').length, 0)
  main?.reply({ op: 'hold', id, held: false })
  time.advance(CALL_TIMEOUT_MS - 1)
  await settle()
  assert.equal(main?.of('cancel').length, 0)
  time.advance(1)
  const timedOut = resultOf(await first)
  assert.match(timedOut?.contentItems[0]?.text ?? '', /^\[litch:failed\]/)
  assert.deepEqual(main?.of('cancel'), [{ type: CLIENT_TOOL, op: 'cancel', id }])
})

test('回合结束：正在执行的取消、卡片撤掉并回 null，执行过调用的回合告诉主进程收尾；没调用过的回合不报', async () => {
  const { core, main, call, peer } = setup()
  core.start()
  await settle()
  const session = watchSession(core)
  await settle()
  const pending = call({})
  await settle()
  const id = main?.of('call')[0]?.invocation.id ?? ''
  main?.reply({
    op: 'ask',
    id,
    askId: 'k1',
    ask: { kind: 'site', origin: 'https://a.example', url: 'https://a.example/' },
  })
  await settle()
  assert.equal(session.seen.view?.requests.length, 1)
  peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: turn('t1', [], { status: 'interrupted' }),
  })
  await settle()
  assert.equal(session.seen.view?.requests.length, 0)
  assert.deepEqual(main?.of('answer'), [
    { type: CLIENT_TOOL, op: 'answer', askId: 'k1', answer: null },
  ])
  assert.deepEqual(main?.of('cancel'), [{ type: CLIENT_TOOL, op: 'cancel', id }])
  assert.deepEqual(main?.of('turnEnded'), [
    { type: CLIENT_TOOL, op: 'turnEnded', deviceId: 'local', threadId: 'a', turnId: 't1' },
  ])
  assert.equal(resultOf(await pending)?.success, false)

  peer
    .last()
    .notify('turn/started', { threadId: 'a', turn: turn('t2', [], { status: 'inProgress' }) })
  peer
    .last()
    .notify('turn/completed', { threadId: 'a', turn: turn('t2', [], { status: 'completed' }) })
  await settle()
  assert.equal(main?.of('turnEnded').length, 1)
})

test('打断：用户在这边打断时正在执行的调用当场取消', async () => {
  const { core, main, call, command } = setup()
  core.start()
  await settle()
  const session = watchSession(core)
  await settle()
  assert.equal(session.seen.view?.turns[0]?.status, 'running')
  const pending = call({})
  await settle()
  await command('session.interrupt', { deviceId: 'local', sessionId: 'a' })
  const stopped = resultOf(await pending)
  assert.match(stopped?.contentItems[0]?.text ?? '', /interrupted/)
  assert.equal(main?.of('cancel').length, 1)
})

test('引擎撤回请求、连接断开：不等了，告诉主进程取消；断开时执行过调用的回合一并收尾', async () => {
  const { core, main, call, peer, time } = setup()
  core.start()
  await settle()
  void call({}, 'r-9')
  await settle()
  peer.last().notify('serverRequest/resolved', { threadId: 'a', requestId: 'r-9' })
  await settle()
  assert.equal(main?.of('cancel').length, 1)

  void call({ callId: 'c2' })
  await settle()
  peer.last().drop()
  await settle()
  time.advance(10)
  await settle()
  assert.equal(main?.of('cancel').length, 2)
  assert.deepEqual(
    main?.of('turnEnded').map((message) => message.turnId),
    ['t1'],
  )
})

test('截图：动态工具结果里头几张能直接显示的内联图片留着地址，再多的、太大的、格式不认的只有说明；别的工具不留', () => {
  const png = (n: number) => `data:image/png;base64,${'A'.repeat(4 * n)}`
  const item = (contentItems: unknown[]): ToolCallItem =>
    projectItem({
      type: 'dynamicToolCall',
      id: 'd',
      namespace: 'litch_browser',
      tool: 'screenshot',
      arguments: {},
      status: 'completed',
      contentItems,
      success: true,
      durationMs: 1,
    } as ThreadItem) as ToolCallItem
  const many = item(
    Array.from({ length: IMAGE_KEEP + 2 }, (_, index) => ({
      type: 'inputImage',
      imageUrl: png(index + 1),
    })),
  )
  const srcs = many.output.map((part) => (part.kind === 'blob' ? (part.src ?? null) : null))
  assert.deepEqual(srcs, [
    ...Array.from({ length: IMAGE_KEEP }, (_, index) => png(index + 1)),
    null,
    null,
  ])
  const odd = item([
    { type: 'inputImage', imageUrl: `data:image/png;base64,${'A'.repeat(IMAGE_CHARS)}` },
    { type: 'inputImage', imageUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { type: 'inputImage', imageUrl: 'data:image/png,raw' },
  ])
  assert.ok(odd.output.every((part) => part.kind === 'blob' && part.src === undefined))
  // MCP 工具的图片照旧只有说明
  const mcp = projectItem({
    type: 'mcpToolCall',
    id: 'm',
    server: 's',
    tool: 't',
    status: 'completed',
    arguments: {},
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: true,
    result: {
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      structuredContent: null,
      _meta: null,
    },
    error: null,
    durationMs: 1,
  } as ThreadItem) as ToolCallItem
  assert.equal(mcp.output[0]?.kind === 'blob' && mcp.output[0].src, undefined)
  // 失败的结果里带着原因就照它说（客户端工具的“设备设置里关着”），只报了失败的是一句话
  const failed = projectItem({
    type: 'dynamicToolCall',
    id: 'f',
    namespace: 'litch_browser',
    tool: 'tabs',
    arguments: {},
    status: 'failed',
    contentItems: [{ type: 'inputText', text: '[litch:disabled] off' }],
    success: false,
    durationMs: 1,
  } as ThreadItem) as ToolCallItem
  assert.deepEqual(failed.error, [{ kind: 'text', text: '[litch:disabled] off' }])
})

test('开关存在设备配置里：改过的才记，移除设备时一起去掉；读回来不合规矩的丢掉', async () => {
  let saved: SavedDevices = {
    localWire: null,
    remotes: [{ id: 'ssh-1', name: 'box', target: { kind: 'alias', alias: 'box' }, wire: 'blue' }],
  }
  const store: DeviceStore = {
    load: () => saved,
    save(next) {
      saved = structuredClone(next)
    },
    snapshot: () => ({ load: () => null, save() {} }),
    forget() {},
  }
  const core = createCore({
    clock: fakeClock().clock,
    version: '9.9.9',
    store,
    clientTools: fakeMain(['litch_browser', 'litch_computer']).port,
    devices: [],
  })
  await core.command('device.tools.set', { deviceId: 'ssh-1', computer: true }, never)
  assert.deepEqual(saved.tools, { 'ssh-1': { computer: true } })
  await core.command('device.remove', { deviceId: 'ssh-1' }, never)
  assert.equal(saved.tools, undefined)

  assert.deepEqual(
    checkSaved({
      remotes: [{ id: 'ssh-1', name: 'box', target: { kind: 'alias', alias: 'box' } }],
      tools: { local: { browser: false, extra: 1 }, 'ssh-1': { computer: 'yes' }, gone: {} },
    }).tools,
    { local: { browser: false } },
  )
})

test('模拟核心：“用浏览器”出一张网站卡片，答应了工具条目带着截图；“操作应用”在远程设备上也不出卡片', async () => {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 5 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const watch = (deviceId: string, sessionId: string) => {
    const state = { view: null as SessionView | null }
    channel.subscribe(
      { kind: 'session', deviceId, sessionId },
      {
        snapshot: (data) => {
          state.view = structuredClone(data) as SessionView
        },
        delta(ops: SessionOp[]) {
          for (const op of ops) if (state.view) reduceSession(state.view, structuredClone(op))
        },
      },
    )
    return state
  }
  const local = watch('local', 's3')
  await settle()
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '用浏览器' })
  time.advance(20)
  await settle()
  const card = local.view?.requests[0] as ClientAskRequest | undefined
  assert.equal(card?.kind, 'clientAsk')
  assert.equal(card?.ask.kind, 'site')
  await channel.command('session.respond', {
    deviceId: 'local',
    sessionId: 's3',
    requestId: card?.id,
    optionId: 'once',
  })
  time.advance(20)
  await settle()
  const tool = Object.values(local.view?.items ?? {}).find(
    (item): item is ToolCallItem => item.kind === 'toolCall' && item.source === 'litch_browser',
  )
  assert.equal(tool?.status, 'completed')
  assert.ok(
    tool?.output.some((part) => part.kind === 'blob' && part.src?.startsWith('data:image/png')),
  )

  // build 是远程设备；b2 在那里闲着
  const remoteId = 'b2'
  const remote = watch('build', remoteId)
  await settle()
  await channel.command('session.send', {
    deviceId: 'build',
    sessionId: remoteId,
    text: '操作应用',
  })
  time.advance(20)
  await settle()
  assert.equal(remote.view?.requests.length, 0)
  const used = Object.values(remote.view?.items ?? {}).find(
    (item): item is ToolCallItem => item.kind === 'toolCall' && item.source === 'litch_computer',
  )
  assert.equal(used?.status, 'completed')
})
