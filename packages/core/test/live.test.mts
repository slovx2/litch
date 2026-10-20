// 打开着的会话：发送、实时更新、排队、打断、审批与提问。对着假对端跑，不连任何真的东西。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatSessionEvent,
  type JsonRpcMessage,
  type Thread,
  type ThreadItem,
  type Turn,
} from '../../protocol/src/index.mjs'
import {
  type ComposeOptions,
  createCore,
  type SessionView,
  type SidebarOp,
  type SidebarView,
  shownEffort,
} from '../src/index.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const never = { aborted: false, addEventListener() {} }
const where = { deviceId: 'local', sessionId: 'a' }

/** 某个条目的状态；没有这个条目就是 undefined */
const statusOf = (view: SessionView | null, itemId: string): unknown =>
  (view?.items[itemId] as { status?: string } | undefined)?.status

function setup(threads: Thread[] = [thread({ id: 'a', turns: [] })]) {
  const world = {
    threads,
    /** 对面已经归档的会话 */
    archived: [] as Thread[],
    /** turn/start 回什么：给了就抛它 */
    startFailure: null as RpcFailure | null,
    steerFailure: null as RpcFailure | null,
    turnSeq: 0,
    /** 对面报的会话设置 */
    settings: {
      model: 'gate/small',
      reasoningEffort: 'low' as string | null,
      // Pi 入口给的是标识本身，协议里是对象；两种都要认
      activePermissionProfile: ':workspace' as string | { id: string } | null,
      sandbox: { type: 'workspaceWrite' },
    },
    models: [
      model('gate/small', {
        isDefault: true,
        efforts: ['low', 'high'],
        tiers: ['priority'],
        defaultTier: 'priority',
      }),
      model('gate/plain', { efforts: [] }),
      model('gate/secret', { hidden: true }),
    ],
  }
  const handlers: Record<string, Handler> = {
    'runtime/info': () => ({
      engine: 'pi',
      protocolVersion: '0.157.1',
      cliBuild: '0.99.1',
      capabilities: [],
      releaseReady: true,
    }),
    'project/list': () => ({ data: [], nextCursor: null }),
    'thread/list': (params) => ({
      data: ((params as { archived?: boolean }).archived ? world.archived : world.threads).map(
        (entry) => ({ ...entry, turns: [] }),
      ),
      nextCursor: null,
      backwardsCursor: null,
    }),
    'thread/read': (params) => {
      const { threadId } = params as { threadId: string }
      const found = world.threads.find((entry) => entry.id === threadId)
      if (!found) throw new RpcFailure(-32600, 'thread not found')
      return { thread: found }
    },
    'thread/resume': (params) => {
      const found = world.threads.find(
        (entry) => entry.id === (params as { threadId: string }).threadId,
      )
      if (!found) throw new RpcFailure(-32600, 'thread not found')
      return { thread: found, ...world.settings }
    },
    'thread/start': (params) => {
      const created = thread({ id: `new-${world.threads.length}`, preview: '', turns: [] })
      world.threads.push(created)
      const asked = params as { model?: string }
      return { thread: created, ...world.settings, model: asked.model ?? world.settings.model }
    },
    'model/list': () => ({ data: world.models, nextCursor: null }),
    'thread/name/set': () => ({}),
    'thread/archive': (params) => {
      const { threadId } = params as { threadId: string }
      const found = world.threads.find((entry) => entry.id === threadId)
      world.threads = world.threads.filter((entry) => entry !== found)
      if (found) world.archived.push(found)
      return {}
    },
    'thread/unarchive': (params) => {
      const { threadId } = params as { threadId: string }
      const found = world.archived.find((entry) => entry.id === threadId)
      if (!found) throw new RpcFailure(-32600, 'thread not found')
      world.archived = world.archived.filter((entry) => entry !== found)
      world.threads.push(found)
      return { thread: found }
    },
    'thread/delete': (params) => {
      const { threadId } = params as { threadId: string }
      world.threads = world.threads.filter((entry) => entry.id !== threadId)
      world.archived = world.archived.filter((entry) => entry.id !== threadId)
      return {}
    },
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'turn/start': () => {
      if (world.startFailure) throw world.startFailure
      return { turn: turn(`srv-${++world.turnSeq}`, [], { status: 'inProgress' }) }
    },
    'turn/interrupt': () => ({}),
    'turn/steer': (params) => {
      if (world.steerFailure) throw world.steerFailure
      return { turnId: (params as { expectedTurnId: string }).expectedTurnId }
    },
  }
  const time = fakeClock()
  const peer = fakeOpener(handlers)
  const logs: string[] = []
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: (line) => logs.push(line),
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'dev@mac',
        kind: 'local',
        target: null,
        wire: 'green',
        open: peer.open,
      },
    ],
  })
  const sidebar = { view: null as SidebarView | null, ops: [] as SidebarOp[] }
  core.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot: (data) => {
        sidebar.view = data as SidebarView
      },
      delta: (ops) => sidebar.ops.push(...(ops as SidebarOp[])),
      error() {},
    },
  )
  const command = (name: string, params: object) => core.command(name, params, never)
  const sent = (method: string) =>
    peer
      .last()
      .seen.filter((entry) => entry.method === method)
      .map((entry) => entry.params)
  return { core, world, peer, time, sidebar, command, sent, logs }
}

/** 订阅一个会话，并像界面那样把增量落到快照上。经真的通道，见 wire.mts */
const watch = watchSession

/** 协议里的一个模型，只填界面用得到的字段 */
function model(
  id: string,
  fields: {
    isDefault?: boolean
    hidden?: boolean
    efforts?: string[]
    tiers?: string[]
    defaultTier?: string
  } = {},
): object {
  return {
    id,
    model: id,
    displayName: id.toUpperCase(),
    description: '',
    hidden: fields.hidden ?? false,
    isDefault: fields.isDefault ?? false,
    supportedReasoningEfforts: (fields.efforts ?? []).map((reasoningEffort) => ({
      reasoningEffort,
      description: '',
    })),
    defaultReasoningEffort: fields.efforts?.[0] ?? '',
    serviceTiers: (fields.tiers ?? []).map((tier) => ({
      id: tier,
      name: tier.toUpperCase(),
      description: `${tier} 档`,
    })),
    defaultServiceTier: fields.defaultTier ?? null,
  }
}

const started = (id: string): Turn => turn(id, [], { status: 'inProgress' })
const finished = (id: string, fields: Partial<Turn> = {}): Turn =>
  turn(id, [], { status: 'completed', durationMs: 1200, ...fields })

test('发送：消息立刻显示；对面给的回合、回显的消息、流出来的回答都落在同一个回合上', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()

  const sending = command('session.send', { ...where, text: '你好' })
  // 还没等对面应答，界面上已经有这一轮和这条消息了
  assert.deepEqual(session.texts(), [['你好']])
  const local = session.seen.view?.turns[0]
  assert.equal(local?.status, 'running')
  await sending
  await settle()
  assert.deepEqual(sent('turn/start'), [
    { threadId: 'a', input: [{ type: 'text', text: '你好', text_elements: [] }] },
  ])

  const server = peer.last()
  const base = { threadId: 'a', turnId: 'srv-1' }
  server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  server.notify('item/started', { ...base, item: userText('u1', '你好'), startedAtMs: 0 })
  server.notify('item/started', { ...base, item: agentText('m1', ''), startedAtMs: 0 })
  server.notify('item/agentMessage/delta', { ...base, itemId: 'm1', delta: '你' })
  server.notify('item/agentMessage/delta', { ...base, itemId: 'm1', delta: '好呀' })
  await settle()
  // 回合没有换标识，用户消息没有多出一条
  assert.equal(session.seen.view?.turns.length, 1)
  assert.equal(session.seen.view?.turns[0]?.id, local?.id)
  assert.deepEqual(session.texts(), [['你好', '你好呀']])
  const answerId = session.seen.view?.turns[0]?.itemIds[1] ?? ''
  assert.equal(statusOf(session.seen.view, answerId), 'inProgress')

  server.notify('item/completed', { ...base, item: agentText('m1', '你好呀。'), completedAtMs: 0 })
  server.notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()
  assert.deepEqual(session.texts(), [['你好', '你好呀。']])
  assert.equal(session.seen.view?.turns[0]?.status, 'completed')
  assert.equal(session.seen.view?.turns[0]?.durationMs, 1200)
  assert.equal(statusOf(session.seen.view, answerId), 'completed')
})

test('回合结束时对面漏了“完成”的条目：回答和思考算完成，工具调用按回合结局收尾；命令、派子代理的调用不动', async () => {
  const { core, peer, command } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '跑一下' })
  await settle()
  const server = peer.last()
  const base = { threadId: 'a', turnId: 'srv-1' }
  server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  const items: ThreadItem[] = [
    agentText('m1', '先看看'),
    { type: 'reasoning', id: 'r1', summary: ['想'], content: [] },
    {
      type: 'mcpToolCall',
      id: 't1',
      server: 'docs',
      tool: 'search',
      status: 'inProgress',
      arguments: {},
      result: null,
      error: null,
      durationMs: null,
    },
    {
      type: 'commandExecution',
      id: 'c1',
      command: 'sleep 600',
      cwd: '/w',
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    },
    {
      type: 'collabAgentToolCall',
      id: 'g1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'a',
      receiverThreadIds: ['child'],
      prompt: '查一下',
      model: null,
      reasoningEffort: null,
      agentsStates: { child: { status: 'running', message: null } },
    },
  ] as ThreadItem[]
  for (const item of items) server.notify('item/started', { ...base, item, startedAtMs: 0 })
  await settle()
  const ids = session.seen.view?.turns[0]?.itemIds ?? []
  const byKind = (kind: string) =>
    ids.find((id) => (session.seen.view?.items[id] as { kind?: string })?.kind === kind) ?? ''
  const tool = ids.find(
    (id) => (session.seen.view?.items[id] as { tool?: string })?.tool === 'search',
  )
  const spawn = ids.find(
    (id) => (session.seen.view?.items[id] as { agents?: unknown })?.agents !== undefined,
  )
  for (const id of [byKind('agentMessage'), byKind('reasoning'), tool, byKind('command'), spawn])
    assert.equal(statusOf(session.seen.view, id ?? ''), 'inProgress')

  server.notify('turn/completed', {
    threadId: 'a',
    turn: finished('srv-1', { status: 'interrupted' }),
  })
  await settle()
  assert.equal(statusOf(session.seen.view, byKind('agentMessage')), 'completed')
  assert.equal(statusOf(session.seen.view, byKind('reasoning')), 'completed')
  assert.equal(statusOf(session.seen.view, tool ?? ''), 'failed')
  // 后台命令跨回合跑，结束时对面再补完成；子代理的状态以子线程为准
  assert.equal(statusOf(session.seen.view, byKind('command')), 'inProgress')
  assert.equal(statusOf(session.seen.view, spawn ?? ''), 'inProgress')
})

test('别的连接开的回合（设备进程的提醒、手机上发的话）：用户消息实时出来，开始、完成各一次不多出一条；之后本机发的照样落在自己那条上', async () => {
  const { core, peer, command } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()

  const server = peer.last()
  const remind = formatSessionEvent({ kind: 'remind', notes: [] })
  const base = { threadId: 'a', turnId: 'srv-r' }
  server.notify('turn/started', { threadId: 'a', turn: started('srv-r') })
  server.notify('item/started', { ...base, item: userText('u-r', remind), startedAtMs: 0 })
  server.notify('item/completed', { ...base, item: userText('u-r', remind), completedAtMs: 0 })
  server.notify('item/started', { ...base, item: userText('u-p', '手机上说的'), startedAtMs: 0 })
  server.notify('item/completed', {
    ...base,
    item: { ...userText('u-p', '手机上说的'), clientId: 'phone-1' },
    completedAtMs: 0,
  })
  await settle()
  const view = session.seen.view
  assert.equal(view?.turns.length, 1)
  const [first, second] = (view?.turns[0]?.itemIds ?? []).map((id) => view?.items[id])
  assert.equal(view?.turns[0]?.itemIds.length, 2)
  assert.equal(first?.kind, 'userMessage')
  assert.deepEqual(first?.kind === 'userMessage' ? first.event : null, {
    kind: 'remind',
    notes: [],
  })
  assert.equal(second && 'text' in second ? second.text : null, '手机上说的')
  server.notify('turn/completed', { threadId: 'a', turn: finished('srv-r') })
  await settle()

  // 本机再发一句：对面回显的那条落在先显示出来的那条上
  await command('session.send', { ...where, text: '桌面上说的' })
  await settle()
  const mine = { threadId: 'a', turnId: 'srv-1' }
  server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  server.notify('item/started', { ...mine, item: userText('u1', '桌面上说的'), startedAtMs: 0 })
  server.notify('item/completed', { ...mine, item: userText('u1', '桌面上说的'), completedAtMs: 0 })
  await settle()
  assert.deepEqual(session.texts().at(-1), ['桌面上说的'])
  assert.equal(session.seen.view?.turns.length, 2)
})

test('发送失败：先显示出来的那一轮撤掉，命令报错（界面据此把文字还给用户）', async () => {
  const { core, world, command } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  world.startFailure = new RpcFailure(-32603, 'model is not configured')
  await assert.rejects(command('session.send', { ...where, text: '你好' }), {
    code: 'remote',
    message: 'model is not configured',
  })
  assert.deepEqual(session.texts(), [])
  assert.deepEqual(session.seen.view?.items, {})
})

test('回合进行中连发三条：按顺序一条一条发，不丢不重；排着的可以拿掉', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '二' })
  await command('session.send', { ...where, text: '三' })
  await command('session.send', { ...where, text: '四' })
  assert.deepEqual(
    session.seen.view?.queued.map((message) => message.text),
    ['二', '三', '四'],
  )
  assert.equal(sent('turn/start').length, 1)

  const third = session.seen.view?.queued[1]?.id ?? ''
  await command('session.unqueue', { ...where, messageId: third })
  assert.deepEqual(
    session.seen.view?.queued.map((message) => message.text),
    ['二', '四'],
  )

  const server = peer.last()
  server.notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()
  assert.deepEqual(
    session.seen.view?.queued.map((message) => message.text),
    ['四'],
  )
  server.notify('turn/completed', { threadId: 'a', turn: finished('srv-2') })
  await settle()
  server.notify('turn/completed', { threadId: 'a', turn: finished('srv-3') })
  await settle()
  const inputs = sent('turn/start').map(
    (params) => (params as { input: { text: string }[] }).input[0]?.text,
  )
  assert.deepEqual(inputs, ['一', '二', '四'])
  assert.deepEqual(session.texts(), [['一'], ['二'], ['四']])
  assert.deepEqual(session.seen.view?.queued, [])
  assert.deepEqual(
    session.seen.view?.turns.map((entry) => entry.status),
    ['completed', 'completed', 'completed'],
  )
})

test('排着队的消息没发出去：放回队首并说明原因，不自己反复重试；下次发送时再试', async () => {
  const { core, world, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '二' })
  world.startFailure = new RpcFailure(-32603, 'quota exceeded')
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()
  assert.deepEqual(
    session.seen.view?.queued.map((message) => message.text),
    ['二'],
  )
  assert.deepEqual(session.seen.view?.note, {
    key: 'session.queueFailed',
    args: { message: 'quota exceeded' },
  })
  assert.equal(sent('turn/start').length, 2)
  // 没有回合在跑、队里有东西：再发一条时先把队首发出去，说明随之消失
  world.startFailure = null
  await command('session.send', { ...where, text: '三' })
  await settle()
  assert.equal(session.seen.view?.note, null)
  assert.deepEqual(
    session.seen.view?.queued.map((message) => message.text),
    ['三'],
  )
})

test('打断：用对面给的回合标识；对面还没给标识、或者没有回合在跑时报“做不了”', async () => {
  const { core, command, sent } = setup()
  core.start()
  await settle()
  watch(core)
  await settle()
  await assert.rejects(command('session.interrupt', where), { code: 'rejected' })
  await command('session.send', { ...where, text: '跑起来' })
  await command('session.interrupt', where)
  assert.deepEqual(sent('turn/interrupt'), [{ threadId: 'a', turnId: 'srv-1' }])
})

test('打开一个正在跑的会话：增量接在快照后面，载入期间到达的文本不会出现两遍', async () => {
  const running = turn('t1', [userText('u', '问'), agentText('m', '已经有的')], {
    status: 'inProgress',
  })
  const { core, peer } = setup([thread({ id: 'a', turns: [running] })])
  core.start()
  await settle()
  const session = watch(core)
  // 订阅的应答还没处理完，对面已经在发这个会话的通知了
  const base = { threadId: 'a', turnId: 't1' }
  peer.last().notify('item/agentMessage/delta', { ...base, itemId: 'm', delta: '已经有的' })
  await settle()
  assert.deepEqual(session.texts(), [['问', '已经有的']])
  peer.last().notify('item/agentMessage/delta', { ...base, itemId: 'm', delta: '，后来的' })
  peer.last().notify('item/started', {
    ...base,
    item: { type: 'reasoning', id: 'r', summary: [], content: [] } as ThreadItem,
    startedAtMs: 0,
  })
  peer.last().notify('item/reasoning/summaryTextDelta', {
    ...base,
    itemId: 'r',
    delta: '想',
    summaryIndex: 0,
  })
  peer.last().notify('item/reasoning/summaryPartAdded', { ...base, itemId: 'r', summaryIndex: 1 })
  peer.last().notify('item/reasoning/summaryTextDelta', {
    ...base,
    itemId: 'r',
    delta: '再想',
    summaryIndex: 1,
  })
  // 有了摘要，原文的增量不再往里加
  peer
    .last()
    .notify('item/reasoning/textDelta', { ...base, itemId: 'r', delta: '原文', contentIndex: 0 })
  await settle()
  assert.deepEqual(session.texts(), [['问', '已经有的，后来的', '想\n\n再想']])
})

test('审批：按钮来自请求；答复换成协议里的决定；别处答了就消失，这边不再回', async () => {
  const running = turn('t1', [userText('u', '跑测试')], { status: 'inProgress' })
  const { core, peer, command, time } = setup([thread({ id: 'a', turns: [running] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const server = peer.last()
  const base = { threadId: 'a', turnId: 't1' }
  // 命令“已经跑了多久”从哪一刻算起：看着它开始的那一刻；等批准的那一段不算
  const clockOf = () => {
    const item = session.seen.view?.items['t1:c1']
    return item?.kind === 'command' ? item.startedAt : undefined
  }
  const command1 = {
    type: 'commandExecution',
    id: 'c1',
    command: 'npm test',
    cwd: '/work/app',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  } as unknown as ThreadItem
  server.notify('item/started', { ...base, item: command1, startedAtMs: 0 })
  await settle()
  assert.equal(clockOf(), time.clock.now(), '看着它开始的命令记下开始的时刻')

  const first = server.ask('item/commandExecution/requestApproval', {
    ...base,
    itemId: 'c1',
    command: 'npm test',
    cwd: '/work/app',
    reason: '要联网',
    availableDecisions: ['accept', 'decline'],
  })
  await settle()
  const request = session.seen.view?.requests[0]
  assert.equal(request?.kind, 'approval')
  if (request?.kind !== 'approval') return
  assert.equal(request.command, 'npm test')
  assert.equal(request.reason, '要联网')
  assert.equal(request.itemId, 't1:c1')
  assert.equal(clockOf(), null, '等批准的时候不计时')
  assert.deepEqual(request.options, [
    { id: 'accept', role: 'accept' },
    { id: 'decline', role: 'decline' },
  ])
  // 请求里没有的选项不能答
  await assert.rejects(
    command('session.respond', { ...where, requestId: request.id, optionId: 'acceptSession' }),
    { code: 'rejected' },
  )
  time.advance(90_000)
  await command('session.respond', { ...where, requestId: request.id, optionId: 'accept' })
  assert.deepEqual(((await first) as { result: unknown }).result, { decision: 'accept' })
  assert.deepEqual(session.seen.view?.requests, [])
  assert.equal(clockOf(), time.clock.now(), '批了之后从批的那一刻重新算，等人的一分半不算进去')
  await assert.rejects(
    command('session.respond', { ...where, requestId: request.id, optionId: 'accept' }),
    { code: 'rejected' },
  )

  // 第二个请求在别处有了结果：卡片消失，这边不给应答
  let answered: JsonRpcMessage | null = null
  void server
    .ask('item/fileChange/requestApproval', { ...base, itemId: 'f1', reason: null })
    .then((message) => {
      answered = message
    })
  await settle()
  assert.equal(session.seen.view?.requests.length, 1)
  server.notify('serverRequest/resolved', { threadId: 'a', requestId: 'srv-1' })
  await settle()
  assert.deepEqual(session.seen.view?.requests, [])
  assert.equal(answered, null)

  // 不认识的请求回“方法不存在”，对面的回合不会挂住
  const unknown = (await server.ask('item/tool/call', { threadId: 'a' })) as {
    error?: { code: number }
  }
  assert.equal(unknown.error?.code, -32601)
})

test('提问：答案按题目标识回给对面；回合结束时没答的请求作废', async () => {
  const running = turn('t1', [userText('u', '配服务')], { status: 'inProgress' })
  const { core, peer, command } = setup([thread({ id: 'a', turns: [running] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const server = peer.last()
  const questions = [
    {
      id: 'scope',
      header: '范围',
      question: '装在哪一级？',
      isOther: false,
      isSecret: false,
      options: [
        { label: '用户级', description: '' },
        { label: '系统级', description: '' },
      ],
    },
    {
      id: 'name',
      header: '名字',
      question: '服务叫什么？',
      isOther: true,
      isSecret: false,
      options: null,
    },
  ]
  const asked = server.ask('item/tool/requestUserInput', {
    threadId: 'a',
    turnId: 't1',
    itemId: 'q1',
    questions,
    isBlocking: true,
    autoResolutionMs: null,
  })
  await settle()
  const request = session.seen.view?.requests[0]
  assert.equal(request?.kind, 'question')
  if (request?.kind !== 'question') return
  assert.deepEqual(
    request.questions.map((question) => [
      question.id,
      question.options?.length ?? 0,
      question.allowOther,
    ]),
    [
      ['scope', 2, false],
      ['name', 0, true],
    ],
  )
  await command('session.respond', {
    ...where,
    requestId: request.id,
    answers: { scope: ['用户级'], name: ['litch'] },
  })
  assert.deepEqual(((await asked) as { result: unknown }).result, {
    answers: { scope: { answers: ['用户级'] }, name: { answers: ['litch'] } },
  })

  void server.ask('item/commandExecution/requestApproval', {
    threadId: 'a',
    turnId: 't1',
    itemId: 'c9',
  })
  await settle()
  assert.equal(session.seen.view?.requests.length, 1)
  server.notify('turn/completed', { threadId: 'a', turn: finished('t1') })
  await settle()
  assert.deepEqual(session.seen.view?.requests, [])
})

test('界面关掉会话：回合还在跑就留着订阅，跑完了才退订；期间跑完的会话标成未读', async () => {
  const { core, peer, sidebar, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '慢慢跑' })
  const server = peer.last()
  server.notify('thread/status/changed', {
    threadId: 'a',
    status: { type: 'active', activeFlags: [] },
  })
  await settle()
  session.close()
  await settle()
  assert.deepEqual(sent('thread/unsubscribe'), [])

  server.notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  server.notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
  await settle()
  assert.deepEqual(sent('thread/unsubscribe'), [{ threadId: 'a' }])
  const last = sidebar.ops.findLast((op) => op.op === 'session.upsert')
  assert.equal(last?.op === 'session.upsert' && last.session.unread, true)

  await command('session.markRead', where)
  const cleared = sidebar.ops.findLast((op) => op.op === 'session.upsert')
  assert.equal(cleared?.op === 'session.upsert' && cleared.session.unread, false)

  // 再打开：重新订阅，拿到的是对面现在的内容
  const again = watch(core)
  await settle()
  assert.equal(again.seen.snapshots, 1)
  assert.equal(sent('thread/resume').length, 2)
})

test('临时会话（起标题之类用的）不进侧栏：开始的通知、状态变化都不收，也不去要它的信息；会话卸载的通知不当不认识的', async () => {
  const { core, peer, sidebar, sent, logs } = setup()
  core.start()
  await settle()
  const server = peer.last()
  // 原生 codex 会把临时会话的 thread/started 也发给每条连接
  server.notify('thread/started', { thread: thread({ id: 'tmp', ephemeral: true }) })
  server.notify('thread/status/changed', {
    threadId: 'tmp',
    status: { type: 'active', activeFlags: [] },
  })
  server.notify('thread/status/changed', { threadId: 'tmp', status: { type: 'idle' } })
  // 用完卸载：先报状态成了 notLoaded，再发 thread/closed
  server.notify('thread/status/changed', { threadId: 'tmp', status: { type: 'notLoaded' } })
  server.notify('thread/closed', { threadId: 'tmp' })
  await settle()
  const touched = sidebar.ops.filter((op) => op.op === 'session.upsert' && op.session.id === 'tmp')
  assert.deepEqual(touched, [])
  assert.deepEqual(sent('thread/read'), [])
  // 平常的会话卸载了：状态已经由 thread/status/changed 报过，这条没有别的要做，也不记成不认识的通知
  server.notify('thread/status/changed', { threadId: 'a', status: { type: 'notLoaded' } })
  server.notify('thread/closed', { threadId: 'a' })
  await settle()
  assert.deepEqual(
    logs.filter((line) => line.includes('thread/closed')),
    [],
  )
  const last = sidebar.ops.findLast((op) => op.op === 'session.upsert' && op.session.id === 'a')
  assert.equal(last?.op === 'session.upsert' && last.session.status, 'idle')
})

test('断线：没答的请求作废，排着队的消息留着；重连后重新订阅并接着发', async () => {
  const running = turn('t1', [userText('u', '问')], { status: 'inProgress' })
  const { core, world, peer, time, command, sent } = setup([thread({ id: 'a', turns: [running] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  void peer
    .last()
    .ask('item/commandExecution/requestApproval', { threadId: 'a', turnId: 't1', itemId: 'c1' })
  await command('session.send', { ...where, text: '排着' })
  await settle()
  assert.equal(session.seen.view?.requests.length, 1)
  assert.equal(session.seen.view?.queued.length, 1)

  // 对面那一轮在断线期间跑完了
  const first = world.threads[0]
  if (first) first.turns = [turn('t1', [userText('u', '问'), agentText('m', '答')])]
  peer.last().drop()
  await settle()
  assert.deepEqual(session.seen.view?.requests, [])
  await assert.rejects(command('session.send', { ...where, text: '断着' }), { code: 'offline' })
  time.advance(500)
  await settle()
  await settle()
  assert.equal(session.seen.snapshots, 2)
  // 重新载入后空下来了，排着的那条自动发出去
  assert.deepEqual(session.seen.view?.queued, [])
  assert.deepEqual(
    sent('turn/start').map((params) => (params as { input: { text: string }[] }).input[0]?.text),
    ['排着'],
  )
  assert.deepEqual(session.texts(), [['问', '答'], ['排着']])
})

test('上下文占用：对面报了才有，取最近一次请求用掉的；重新载入后先留着上一次的', async () => {
  const { core, peer, time } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  assert.equal(session.seen.view?.usage, null)

  const usage = (last: number, window: number | null) => ({
    threadId: 'a',
    turnId: 't1',
    tokenUsage: {
      // 累计的数会把每一步的上下文重复算进去，不能拿它当占用
      total: { totalTokens: 900_000 },
      last: { totalTokens: last },
      modelContextWindow: window,
    },
  })
  peer.last().notify('thread/tokenUsage/updated', usage(84_000, 200_000))
  await settle()
  assert.deepEqual(session.seen.view?.usage, { usedTokens: 84_000, windowTokens: 200_000 })
  // 对面没报窗口有多大：照实给 null，界面算不出占比就不显示
  peer.last().notify('thread/tokenUsage/updated', usage(91_000, null))
  await settle()
  assert.deepEqual(session.seen.view?.usage, { usedTokens: 91_000, windowTokens: null })

  peer.last().drop()
  await settle()
  time.advance(500)
  await settle()
  await settle()
  assert.equal(session.seen.snapshots, 2)
  assert.deepEqual(session.seen.view?.usage, { usedTokens: 91_000, windowTokens: null })
})

test('设置：对面报的显示出来；改了之后跟着下一个回合发一次，再往后不重复发', async () => {
  const { core, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  assert.deepEqual(session.seen.view?.settings, {
    model: 'gate/small',
    effort: 'low',
    speed: null,
    permission: ':workspace',
    mode: null,
  })

  await command('session.configure', {
    ...where,
    settings: { effort: 'high', speed: 'default', permission: ':danger-full-access' },
  })
  await settle()
  // 改了马上显示成新的，不等发出去
  assert.deepEqual(session.seen.view?.settings, {
    model: 'gate/small',
    effort: 'high',
    speed: 'default',
    permission: ':danger-full-access',
    mode: null,
  })
  assert.equal(sent('turn/start').length, 0)

  await command('session.send', { ...where, text: '一' })
  const first = sent('turn/start')[0] as Record<string, unknown>
  assert.equal(first.effort, 'high')
  // 标准速度明着发 default：不发的话用的是模型自己的默认档（这个模型默认是快速）
  assert.equal(first.serviceTier, 'default')
  assert.equal(first.permissions, ':danger-full-access')
  // 内置预设只管文件权限，审批策略要一起给
  assert.equal(first.approvalPolicy, 'never')
  // 没改的不带，对面沿用它自己的
  assert.equal('model' in first, false)
})

test('设置：发出去之后的回合不再带；没发成功的下次接着带', async () => {
  const { core, world, peer, command, sent } = setup()
  core.start()
  await settle()
  watch(core)
  await settle()
  await command('session.configure', { ...where, settings: { model: 'gate/plain' } })
  world.startFailure = new RpcFailure(-32000, '模型不可用')
  await assert.rejects(command('session.send', { ...where, text: '一' }), { code: 'remote' })
  world.startFailure = null
  await command('session.send', { ...where, text: '二' })
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()
  await command('session.send', { ...where, text: '三' })
  assert.deepEqual(
    sent('turn/start').map((params) => (params as { model?: string }).model),
    ['gate/plain', 'gate/plain', undefined],
  )
})

test('新建会话：建好就发第一条，侧栏立刻有它；带不进建会话的设置跟着第一个回合发', async () => {
  const { core, sidebar, command, sent } = setup([])
  core.start()
  await settle()
  const { sessionId } = (await command('session.create', {
    deviceId: 'local',
    cwd: '/work/app',
    text: '第一句',
    settings: { model: 'gate/plain', effort: 'high' },
  })) as { sessionId: string }
  assert.equal(sessionId, 'new-0')
  assert.deepEqual(sent('thread/start'), [{ cwd: '/work/app', model: 'gate/plain' }])
  const first = sent('turn/start')[0] as Record<string, unknown>
  assert.equal(first.threadId, 'new-0')
  // 模型建会话时已经给了，对面也认了，回合里不再带；强度建会话时带不了
  assert.equal('model' in first, false)
  assert.equal(first.effort, 'high')
  // 对面不会为“第一句话成了预览”发通知：侧栏先拿这句话当标题
  const row = sidebar.ops.findLast((op) => op.op === 'session.upsert' && op.session.id === 'new-0')
  assert.equal(row?.op === 'session.upsert' && row.session.title, '第一句')

  // 界面这时才来订阅：拿到的快照里已经有那条消息，回合在跑，不用再向对面载入一次
  const session = watch(core, 'new-0')
  await settle()
  assert.deepEqual(session.texts(), [['第一句']])
  assert.equal(session.seen.view?.turns[0]?.status, 'running')
  assert.deepEqual(session.seen.view?.settings, {
    model: 'gate/plain',
    effort: 'high',
    speed: null,
    permission: ':workspace',
    mode: null,
  })
  assert.equal(sent('thread/resume').length, 0)
})

test('新建会话：第一条没发出去就算没建成，不留下空会话', async () => {
  const { core, world, command, sent } = setup([])
  core.start()
  await settle()
  world.startFailure = new RpcFailure(-32000, '额度用完了')
  await assert.rejects(
    command('session.create', { deviceId: 'local', cwd: null, text: '第一句' }),
    { code: 'remote', message: '额度用完了' },
  )
  assert.equal(sent('thread/unsubscribe').length, 1)
  // 不属于任何工作区：工作目录交给对面定
  assert.deepEqual(sent('thread/start'), [{ cwd: null }])
})

test('原生 codex 没配强度：建会话、载入时报的强度是 null，底栏显示模型默认的那一档；权限照它报的', async () => {
  const { core, world, command, sent } = setup([])
  // codex 0.160.0 的原话（隔离的数据目录、回环上的假模型实测）：配置里只写了模型，没写强度和沙箱，
  // 工作目录也没标过信任。建会话时什么都没选，它报的强度是 null、权限档是只读
  world.settings = {
    model: 'gate/small',
    reasoningEffort: null,
    activePermissionProfile: { id: ':read-only', extends: null } as { id: string },
    sandbox: { type: 'readOnly', networkAccess: false } as { type: string },
  }
  core.start()
  await settle()
  const { sessionId } = (await command('session.create', {
    deviceId: 'local',
    cwd: '/work/app',
    text: '第一句',
    settings: {},
  })) as { sessionId: string }
  // 什么都没选：建会话和第一个回合都不带强度和权限，用的是 codex 自己的
  assert.deepEqual(sent('thread/start'), [{ cwd: '/work/app' }])
  assert.equal('effort' in (sent('turn/start')[0] as object), false)
  const session = watch(core, sessionId)
  await settle()
  const settings = session.seen.view?.settings
  assert.deepEqual(settings, {
    model: 'gate/small',
    effort: null,
    speed: null,
    permission: ':read-only',
    mode: null,
  })
  const options = (await command('device.composeOptions', { deviceId: 'local' })) as ComposeOptions
  const model = options.models.find((entry) => entry.id === settings?.model)
  // 底栏：强度是这个模型默认的那一档（codex 发给模型的也是它），不是空的
  assert.equal(shownEffort(settings?.effort ?? null, model), 'low')
  // 对面报了具体的一档就照它的（某个回合选过 high 之后，再载入报的就是 high）
  assert.equal(shownEffort('high', model), 'high')
  // 不在清单里的模型：没有可显示的
  assert.equal(shownEffort(null, undefined), null)
})

test('可选项：隐藏的模型不列，没有强度档的模型强度是空的；一次连接只问一遍', async () => {
  const { core, command, sent } = setup()
  core.start()
  await settle()
  const options = (await command('device.composeOptions', { deviceId: 'local' })) as ComposeOptions
  assert.deepEqual(
    options.models.map((entry) => [entry.id, entry.efforts.map((effort) => effort.id)]),
    [
      ['gate/small', ['low', 'high']],
      ['gate/plain', []],
    ],
  )
  // 速度：对面给的那几档（标准不在里面，界面自己补）和模型默认的那一档；没有速度可选的是空的
  assert.deepEqual(
    options.models.map((entry) => [entry.id, entry.speeds, entry.defaultSpeed]),
    [
      ['gate/small', [{ id: 'priority', title: 'PRIORITY', note: 'priority 档' }], 'priority'],
      ['gate/plain', [], null],
    ],
  )
  assert.equal(options.models[0]?.isDefault, true)
  assert.deepEqual(
    options.permissions.map((preset) => [preset.id, preset.risk]),
    [
      [':read-only', 'low'],
      [':workspace', 'medium'],
      [':danger-full-access', 'high'],
    ],
  )
  await command('device.composeOptions', { deviceId: 'local' })
  assert.equal(sent('model/list').length, 1)
})

test('可选项：对面一个模型都没报的不记着，下次再问（ACP 要建过会话才报得出模型）', async () => {
  const { core, world, command, sent } = setup()
  const listed = world.models
  world.models = []
  core.start()
  await settle()
  const empty = (await command('device.composeOptions', { deviceId: 'local' })) as ComposeOptions
  assert.deepEqual(empty.models, [])
  world.models = listed
  const later = (await command('device.composeOptions', { deviceId: 'local' })) as ComposeOptions
  assert.deepEqual(
    later.models.map((entry) => entry.id),
    ['gate/small', 'gate/plain'],
  )
  assert.equal(sent('model/list').length, 2)
  // 问到了就记着
  await command('device.composeOptions', { deviceId: 'local' })
  assert.equal(sent('model/list').length, 2)
})

test('会话操作：改名马上反映到侧栏；归档和删除把它从侧栏拿掉，开着的也不再管', async () => {
  const { core, sidebar, command, sent } = setup([
    thread({ id: 'a', turns: [] }),
    thread({ id: 'b', turns: [] }),
  ])
  core.start()
  await settle()
  await command('session.rename', { ...where, title: '  新名字  ' })
  assert.deepEqual(sent('thread/name/set'), [{ threadId: 'a', name: '新名字' }])
  const renamed = sidebar.ops.findLast((op) => op.op === 'session.upsert' && op.session.id === 'a')
  assert.equal(renamed?.op === 'session.upsert' && renamed.session.title, '新名字')
  await assert.rejects(command('session.rename', { ...where, title: '   ' }), { code: 'rejected' })

  // 开着、还有消息排着队的会话被删掉：队列作废，之后不会再往里发
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '排着' })
  await command('session.delete', where)
  assert.deepEqual(sent('thread/delete'), [{ threadId: 'a' }])
  assert.ok(sidebar.ops.some((op) => op.op === 'session.remove' && op.sessionId === 'a'))
  session.close()
  await assert.rejects(command('session.send', { ...where, text: '再发' }), { code: 'notFound' })
  assert.equal(sent('turn/start').length, 1)

  await command('session.archive', { deviceId: 'local', sessionId: 'b' })
  assert.deepEqual(sent('thread/archive'), [{ threadId: 'b' }])
  assert.ok(sidebar.ops.some((op) => op.op === 'session.remove' && op.sessionId === 'b'))
})

test('引导：排着的消息插进正在进行的回合，对面回显时不多出一条；没插成就放回队首', async () => {
  const { core, world, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '二' })
  await command('session.send', { ...where, text: '三' })
  const [second, third] = session.seen.view?.queued ?? []
  assert.ok(second && third)

  await command('session.steer', { ...where, messageId: second.id })
  const steer = sent('turn/steer')[0] as {
    expectedTurnId: string
    clientUserMessageId: string
    input: { text: string }[]
  }
  assert.equal(steer.expectedTurnId, 'srv-1')
  assert.equal(steer.input[0]?.text, '二')
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['三'],
  )
  assert.deepEqual(session.texts(), [['一', '二']])

  // 对面把这句话当成一个条目发回来（开始、完成各一次）：还是那两条
  const echo = { ...userText('u9', '二'), clientId: steer.clientUserMessageId }
  const base = { threadId: 'a', turnId: 'srv-1' }
  peer.last().notify('item/started', { ...base, item: echo, startedAtMs: 0 })
  peer.last().notify('item/completed', { ...base, item: echo, completedAtMs: 0 })
  await settle()
  assert.deepEqual(session.texts(), [['一', '二']])

  // 对面不让插：消息回到队首，对话里撤掉，出错原因交给界面
  world.steerFailure = new RpcFailure(-32009, '指定回合与活动回合不一致')
  await assert.rejects(command('session.steer', { ...where, messageId: third.id }), {
    code: 'remote',
    message: '指定回合与活动回合不一致',
  })
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['三'],
  )
  assert.deepEqual(session.texts(), [['一', '二']])
})

test('引导：话插进去了但回合被打断、对面一直没回显，就放回队首接着发，不悄悄丢掉', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '二' })
  const queued = session.seen.view?.queued[0]
  assert.ok(queued)
  await command('session.steer', { ...where, messageId: queued.id })
  assert.deepEqual(session.texts(), [['一', '二']])

  peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: finished('srv-1', { status: 'interrupted' }),
  })
  await settle()
  // 从被打断的回合里撤掉，作为下一个回合发出去
  assert.deepEqual(session.texts(), [['一'], ['二']])
  assert.deepEqual(session.seen.view?.queued, [])
  assert.deepEqual(
    sent('turn/start').map((params) => (params as { input: { text: string }[] }).input[0]?.text),
    ['一', '二'],
  )
})

test('引导：回合正常结束时没回显的话留在对话里，不重发', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '二' })
  const queued = session.seen.view?.queued[0]
  assert.ok(queued)
  await command('session.steer', { ...where, messageId: queued.id })
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()
  assert.deepEqual(session.texts(), [['一', '二']])
  assert.equal(sent('turn/start').length, 1)
})

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const attachmentsOf = (view: SessionView | null, turnIndex: number): unknown => {
  const item = view?.items[view.turns[turnIndex]?.itemIds[0] ?? '']
  return item?.kind === 'userMessage' ? item.attachments : undefined
}

test('图片：跟着消息一起发，先显示出来的那条就带着图；只有图没有字也能发', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()

  const images = [{ url: PNG, name: '截图.png' }]
  await command('session.send', { ...where, text: '看这张图', images })
  assert.deepEqual(attachmentsOf(session.seen.view, 0), [
    { kind: 'image', label: '截图.png', url: PNG },
  ])
  assert.deepEqual((sent('turn/start')[0] as { input: unknown }).input, [
    { type: 'text', text: '看这张图', text_elements: [] },
    { type: 'image', url: PNG },
  ])

  // 对面回显：图还在，没有多出一条
  const echo = {
    type: 'userMessage',
    id: 'u1',
    content: [
      { type: 'text', text: '看这张图', text_elements: [] },
      { type: 'image', url: PNG },
    ],
  }
  const base = { threadId: 'a', turnId: 'srv-1' }
  peer.last().notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  peer.last().notify('item/started', { ...base, item: echo, startedAtMs: 0 })
  await settle()
  assert.deepEqual(session.texts(), [['看这张图']])
  assert.deepEqual(attachmentsOf(session.seen.view, 0), [{ kind: 'image', label: null, url: PNG }])

  // 回合进行中再发一条只有图的：排着的时候图也跟着，轮到它时不带空的文字段
  await command('session.send', { ...where, text: '', images: [{ url: PNG, name: null }] })
  assert.deepEqual(session.seen.view?.queued[0]?.images, [{ url: PNG, name: null }])
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()
  assert.deepEqual((sent('turn/start')[1] as { input: unknown }).input, [
    { type: 'image', url: PNG },
  ])
})

test('图片：不是内联图片的附件、空消息都不收', async () => {
  const { core, command, sent } = setup()
  core.start()
  await settle()
  watch(core)
  await settle()
  const remote = [{ url: 'https://example.com/a.png', name: null }]
  await assert.rejects(command('session.send', { ...where, text: '看', images: remote }), {
    code: 'rejected',
  })
  const script = [{ url: 'data:text/html;base64,PGI+', name: null }]
  await assert.rejects(command('session.send', { ...where, text: '看', images: script }), {
    code: 'rejected',
  })
  await assert.rejects(command('session.send', { ...where, text: '  ' }), { code: 'rejected' })
  assert.equal(sent('turn/start').length, 0)
})

test('图片：引导时一起插进去；回合被打断没送达的，连图一起放回队首', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '二', images: [{ url: PNG, name: 'a.png' }] })
  const queued = session.seen.view?.queued[0]
  assert.ok(queued)
  await command('session.steer', { ...where, messageId: queued.id })
  assert.deepEqual((sent('turn/steer')[0] as { input: unknown }).input, [
    { type: 'text', text: '二', text_elements: [] },
    { type: 'image', url: PNG },
  ])
  peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: finished('srv-1', { status: 'interrupted' }),
  })
  await settle()
  assert.deepEqual((sent('turn/start')[1] as { input: unknown }).input, [
    { type: 'text', text: '二', text_elements: [] },
    { type: 'image', url: PNG },
  ])
})

test('已归档：界面要了才去取；之后归档、恢复、删除、别处的变化都跟着变', async () => {
  const { core, world, sidebar, peer, command, sent } = setup([
    thread({ id: 'a', turns: [] }),
    thread({ id: 'b', turns: [] }),
  ])
  world.archived = [thread({ id: 'old', name: '以前归档的', turns: [] })]
  core.start()
  await settle()
  const shelved = () => {
    const last = sidebar.ops.findLast((op) => op.op === 'archived.set')
    return last?.op === 'archived.set' ? last.sessions?.map((entry) => entry.id) : undefined
  }
  // 没要过：不去取，归档了也不报这张表
  assert.equal(sidebar.view?.archived, null)
  await command('session.archive', { deviceId: 'local', sessionId: 'b' })
  assert.equal(shelved(), undefined)
  assert.equal(sent('thread/list').length, 1)

  await command('device.loadArchived', { deviceId: 'local' })
  assert.deepEqual(sent('thread/list').at(-1), { limit: 100, modelProviders: [], archived: true })
  assert.deepEqual(shelved()?.toSorted(), ['b', 'old'])

  // 这边归档：从列表里拿掉，放进已归档
  await command('session.archive', where)
  assert.deepEqual(shelved()?.toSorted(), ['a', 'b', 'old'])
  assert.ok(sidebar.ops.some((op) => op.op === 'session.remove' && op.sessionId === 'a'))

  // 恢复：回到列表里，用的是对面给回来的会话
  await command('session.unarchive', { deviceId: 'local', sessionId: 'old' })
  assert.deepEqual(sent('thread/unarchive'), [{ threadId: 'old' }])
  assert.deepEqual(shelved()?.toSorted(), ['a', 'b'])
  const back = sidebar.ops.findLast((op) => op.op === 'session.upsert')
  assert.equal(back?.op === 'session.upsert' && back.session.title, '以前归档的')

  // 已归档的也能直接删
  await command('session.delete', { deviceId: 'local', sessionId: 'b' })
  assert.deepEqual(shelved(), ['a'])

  // 别处把它恢复了、又改了名：这边不重复出现
  world.threads.push(thread({ id: 'a', name: '别处恢复的', turns: [] }))
  peer.last().notify('thread/unarchived', { threadId: 'a' })
  await settle()
  assert.deepEqual(shelved(), [])
  const restored = sidebar.ops.findLast((op) => op.op === 'session.upsert')
  assert.equal(restored?.op === 'session.upsert' && restored.session.title, '别处恢复的')

  // 别处归档了一个：挪进已归档
  peer.last().notify('thread/archived', { threadId: 'old' })
  await settle()
  assert.deepEqual(shelved(), ['old'])
})

test('表单：MCP 服务的征询排进请求里；填的值原样带回去，填得不对的不发、请求还在', async () => {
  const running = turn('t1', [userText('u', '部署')], { status: 'inProgress' })
  const { core, peer, command } = setup([
    thread({ id: 'a', status: { type: 'active', activeFlags: [] }, turns: [running] }),
  ])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const asked = peer.last().ask('mcpServer/elicitation/request', {
    threadId: 'a',
    turnId: 't1',
    serverName: 'deploy',
    mode: 'form',
    message: '确认设置',
    _meta: null,
    requestedSchema: {
      type: 'object',
      required: ['replicas'],
      properties: { replicas: { type: 'integer' }, note: { type: 'string' } },
    },
  })
  await settle()
  const request = session.seen.view?.requests[0]
  assert.equal(request?.kind, 'form')
  if (request?.kind !== 'form') return
  assert.equal(request.server, 'deploy')
  const respond = (values: Record<string, unknown>) =>
    command('session.respond', { ...where, requestId: request.id, optionId: 'accept', values })
  await assert.rejects(respond({ replicas: '三' }), { code: 'rejected' })
  assert.equal(session.seen.view?.requests.length, 1)
  await respond({ replicas: 3, note: '' })
  assert.deepEqual(((await asked) as { result: unknown }).result, {
    action: 'accept',
    content: { replicas: 3 },
    _meta: null,
  })
  assert.deepEqual(session.seen.view?.requests, [])
})

/** codex 的 request_user_input_async 出的那种助手消息：带 delivery: async 和题目 */
const asking = (id: string): ThreadItem => ({
  type: 'agentMessage',
  id,
  text: '跳过联网的测试吗？\n- 跳过\n- 照常跑',
  phase: 'final_answer',
  memoryCitation: null,
  delivery: 'async',
  questions: [
    { title: '跳过联网的测试吗？', options: ['跳过', '照常跑'] },
    { title: '结果发到哪？', options: null },
  ],
})

test('边做边问：历史和实时的助手消息都带上题目，题目标识用协议条目的标识', async () => {
  const history = turn('t1', [userText('u1', '跑测试'), asking('call_old')], {
    status: 'completed',
  })
  const { core, peer } = setup([thread({ id: 'a', turns: [history] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const asks = () =>
    Object.values(session.seen.view?.items ?? {}).flatMap((item) =>
      item.kind === 'agentMessage' && item.questions ? [item] : [],
    )
  const [old] = asks()
  assert.equal(old?.delivery, 'async')
  assert.deepEqual(old?.questions, [
    {
      id: JSON.stringify(['request_user_input_async', 'call_old', 0]),
      title: '跳过联网的测试吗？',
      options: ['跳过', '照常跑'],
    },
    {
      id: JSON.stringify(['request_user_input_async', 'call_old', 1]),
      title: '结果发到哪？',
      options: [],
    },
  ])

  const base = { threadId: 'a', turnId: 'srv-9' }
  peer.last().notify('turn/started', { threadId: 'a', turn: started('srv-9') })
  peer.last().notify('item/started', { ...base, item: asking('call_new'), startedAtMs: 0 })
  peer.last().notify('item/completed', { ...base, item: asking('call_new'), completedAtMs: 0 })
  await settle()
  assert.equal(asks().length, 2)
  assert.equal(
    asks()[1]?.questions?.[0]?.id,
    JSON.stringify(['request_user_input_async', 'call_new', 0]),
  )
})

test('边做边问：答复要求直接插进正在进行的回合；插不进去就照常排着，不算没发成', async () => {
  const { core, world, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '答复', now: true })
  assert.equal(sent('turn/steer').length, 1)
  assert.equal(session.seen.view?.queued.length, 0)
  assert.deepEqual(session.texts(), [['一', '答复']])

  world.steerFailure = new RpcFailure(-32009, '指定回合与活动回合不一致')
  await command('session.send', { ...where, text: '再答', now: true })
  await settle()
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['再答'],
  )
  assert.deepEqual(session.texts(), [['一', '答复']])
})
