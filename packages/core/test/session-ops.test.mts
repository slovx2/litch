// D2 桌面专属项的核心部分：拒绝时附说明、只读地看已归档的对话、待办进度、分叉、回退、压缩。
// 对着假对端跑，不连任何真的东西。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread, ThreadItem } from '../../protocol/src/index.mjs'
import { createMockCore, reduceSession, type SessionOp, type SessionView } from '../src/index.mjs'
import { ALL_ABLE } from '../src/projection/session.mjs'
import { RpcFailure } from './fake-server.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { finished, runtimeInfo, setup, started, watch, where } from './world.mjs'

const never = { aborted: false, addEventListener() {} }

const commandItem = (id: string, command: string): ThreadItem =>
  ({
    type: 'commandExecution',
    id,
    command,
    cwd: '/work/app',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  }) as unknown as ThreadItem

/** 一个正停在审批上的会话。extensions：对面这个引擎声明认识的扩展；不给就是没有声明 */
async function waitingOnApproval(extensions: string[] | null = ['declineWithNote']) {
  const running = turn('t1', [userText('u', '装依赖')], { status: 'inProgress' })
  const world = setup(
    [thread({ id: 'a', turns: [running] })],
    extensions ? { 'runtime/info': () => runtimeInfo({ extensions }) } : {},
  )
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  const server = world.peer.last()
  const base = { threadId: 'a', turnId: 't1' }
  server.notify('item/started', { ...base, item: commandItem('c1', 'npm i'), startedAtMs: 0 })
  await settle()
  return { ...world, session, server, base }
}

test('拒绝附说明：它声明了、决定里也列了才出；写了说明带着说明回，没写照旧只回拒绝', async () => {
  const { session, server, base, command } = await waitingOnApproval()
  const ask = (decisions: unknown[]) =>
    server.ask('item/commandExecution/requestApproval', {
      ...base,
      itemId: 'c1',
      command: 'npm i',
      availableDecisions: decisions,
    })
  const pending = () => {
    const request = session.seen.view?.requests[0]
    assert.equal(request?.kind, 'approval')
    if (request?.kind !== 'approval') throw new Error('不是审批')
    return request
  }

  // 一、列了“拒绝并附说明”：卡片上还是一个“拒绝”，只是它能带说明
  const first = ask(['accept', 'decline', 'declineWithNote', 'cancel'])
  await settle()
  assert.deepEqual(pending().options, [
    { id: 'accept', role: 'accept' },
    { id: 'decline', role: 'decline', note: true },
    { id: 'cancel', role: 'cancel' },
  ])
  // 别的选项带不了说明：不替用户把话悄悄丢掉
  await assert.rejects(
    command('session.respond', {
      ...where,
      requestId: pending().id,
      optionId: 'accept',
      note: '顺便说一句',
    }),
    { code: 'rejected' },
  )
  assert.equal(session.seen.view?.requests.length, 1)
  await command('session.respond', {
    ...where,
    requestId: pending().id,
    optionId: 'decline',
    note: '  别装新依赖，用现成的  ',
  })
  assert.deepEqual(((await first) as { result: unknown }).result, {
    decision: { declineWithNote: { note: '别装新依赖，用现成的' } },
  })

  // 二、能带说明但没写：就是普通的拒绝
  const second = ask(['accept', 'declineWithNote'])
  await settle()
  // 对面没单独列“拒绝”：在原来的位置补一个
  assert.deepEqual(pending().options, [
    { id: 'accept', role: 'accept' },
    { id: 'decline', role: 'decline', note: true },
  ])
  await command('session.respond', {
    ...where,
    requestId: pending().id,
    optionId: 'decline',
    note: '   ',
  })
  assert.deepEqual(((await second) as { result: unknown }).result, { decision: 'decline' })

  // 三、没列：选项上没有这个能力，带了说明就不收，请求还在
  const third = ask(['accept', 'decline'])
  await settle()
  assert.deepEqual(pending().options, [
    { id: 'accept', role: 'accept' },
    { id: 'decline', role: 'decline' },
  ])
  await assert.rejects(
    command('session.respond', {
      ...where,
      requestId: pending().id,
      optionId: 'decline',
      note: '为什么不行',
    }),
    { code: 'rejected' },
  )
  await command('session.respond', { ...where, requestId: pending().id, optionId: 'decline' })
  assert.deepEqual(((await third) as { result: unknown }).result, { decision: 'decline' })
})

test('拒绝附说明：文件改动的审批带了决定列表时照列表出，没带还是固定的四个', async () => {
  const { session, server, base, command } = await waitingOnApproval()
  const plain = server.ask('item/fileChange/requestApproval', { ...base, itemId: 'f1' })
  await settle()
  const fixed = session.seen.view?.requests[0]
  assert.deepEqual(fixed?.kind === 'approval' ? fixed.options : null, [
    { id: 'accept', role: 'accept' },
    { id: 'acceptSession', role: 'acceptSession' },
    { id: 'decline', role: 'decline' },
    { id: 'cancel', role: 'cancel' },
  ])
  await command('session.respond', { ...where, requestId: fixed?.id, optionId: 'cancel' })
  assert.deepEqual(((await plain) as { result: unknown }).result, { decision: 'cancel' })

  const listed = server.ask('item/fileChange/requestApproval', {
    ...base,
    itemId: 'f2',
    availableDecisions: ['accept', 'declineWithNote', '以后才有的决定'],
  })
  await settle()
  const request = session.seen.view?.requests[0]
  assert.deepEqual(request?.kind === 'approval' ? request.options : null, [
    { id: 'accept', role: 'accept' },
    { id: 'decline', role: 'decline', note: true },
  ])
  await command('session.respond', {
    ...where,
    requestId: request?.id,
    optionId: 'decline',
    note: '这个文件别动',
  })
  assert.deepEqual(((await listed) as { result: unknown }).result, {
    decision: { declineWithNote: { note: '这个文件别动' } },
  })
})

test('拒绝附说明：模拟核心里那张命令审批的“拒绝”能带说明，说明到了对面', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  let view: SessionView | null = null
  const ops: SessionOp[] = []
  core.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's2' },
    {
      snapshot: (data) => {
        view = structuredClone(data as SessionView)
      },
      delta: (delta) => ops.push(...(delta as SessionOp[])),
      error() {},
    },
  )
  const request = (view as SessionView | null)?.requests[0]
  assert.equal(request?.kind, 'approval')
  if (request?.kind !== 'approval') return
  assert.equal(request.options.find((option) => option.role === 'decline')?.note, true)
  const target = { deviceId: 'local', sessionId: 's2', requestId: request.id }
  await assert.rejects(
    core.command('session.respond', { ...target, optionId: 'accept', note: '多余的话' }, never),
    { code: 'rejected' },
  )
  await core.command('session.respond', { ...target, optionId: 'decline', note: '先别联网' }, never)
  const heard = ops.find(
    (op) =>
      op.op === 'item.add' && op.item.kind === 'agentMessage' && op.item.text.includes('先别联网'),
  )
  assert.ok(heard, '对面没有听到那句说明')
  assert.ok(ops.some((op) => op.op === 'request.remove' && op.requestId === request.id))
})

test('已归档：不恢复就能只读地打开看；发不了消息；恢复之后同一个订阅变成能发的', async () => {
  const kept = thread({ id: 'a', turns: [] })
  const { core, world, command, sent } = setup([kept])
  world.archived.push(
    thread({
      id: 'b',
      name: '收起来的',
      turns: [turn('t1', [userText('u', '以前说过的话'), agentText('m', '以前的回答')])],
    }),
  )
  core.start()
  await settle()
  await command('device.loadArchived', { deviceId: 'local' })
  await settle()

  const session = watch(core, 'b')
  await settle()
  // 只取历史，不恢复、不订阅
  assert.deepEqual(sent('thread/read'), [{ threadId: 'b', includeTurns: true }])
  assert.deepEqual(sent('thread/resume'), [])
  assert.deepEqual(session.texts(), [['以前说过的话', '以前的回答']])
  assert.equal(session.seen.view?.live, false)
  assert.deepEqual(session.seen.view?.note, { key: 'session.archived' })
  await assert.rejects(
    command('session.send', { deviceId: 'local', sessionId: 'b', text: '接着聊' }),
    { code: 'rejected' },
  )

  // 恢复：侧栏里有它了，开着的那一份重新载入成能发消息的
  await command('session.unarchive', { deviceId: 'local', sessionId: 'b' })
  await settle()
  assert.deepEqual(sent('thread/resume'), [{ threadId: 'b' }])
  assert.equal(session.seen.snapshots, 2)
  assert.equal(session.seen.view?.live, true)
  assert.equal(session.seen.view?.note, null)
  assert.deepEqual(session.texts(), [['以前说过的话', '以前的回答']])
  await command('session.send', { deviceId: 'local', sessionId: 'b', text: '接着聊' })
  assert.equal(sent('turn/start').length, 1)
})

test('已归档：看过、关掉（留着）、再打开后恢复：重新载入成能发消息的，回答照常落进来；恢复的应答和通知都到也只载入成一份', async () => {
  const { core, world, peer, command, sent } = setup()
  world.archived.push(thread({ id: 'b', turns: [turn('t1', [userText('u', '旧的')])] }))
  core.start()
  await settle()
  await command('device.loadArchived', { deviceId: 'local' })
  await settle()
  const first = watch(core, 'b')
  await settle()
  first.close()
  await settle()
  const session = watch(core, 'b')
  await settle()
  assert.equal(session.seen.view?.live, false)
  await command('session.unarchive', { deviceId: 'local', sessionId: 'b' })
  // 对面也发来 thread/unarchived（别的连接、或者同一次恢复的回声）
  peer.last().notify('thread/unarchived', { threadId: 'b' })
  await settle()
  await settle()
  assert.equal(session.seen.view?.live, true)
  await command('session.send', { deviceId: 'local', sessionId: 'b', text: '接着聊' })
  await settle()
  const started = sent('turn/start')
  assert.equal(started.length, 1)
  const turnId = 'srv-1'
  peer.last().notify('turn/started', {
    threadId: 'b',
    turn: { id: turnId, items: [], status: 'inProgress', error: null },
  })
  peer.last().notify('item/completed', {
    threadId: 'b',
    turnId,
    item: agentText('m1', '收到：接着聊'),
    completedAtMs: 0,
  })
  peer.last().notify('turn/completed', { threadId: 'b', turn: finished(turnId) })
  await settle()
  assert.deepEqual(session.texts().at(-1)?.includes('收到：接着聊'), true)
  assert.deepEqual(sent('thread/unsubscribe'), [])
})

test('已归档：只读地看完关掉，不向对面退订（本来就没订阅）', async () => {
  const { core, world, command, sent } = setup()
  world.archived.push(thread({ id: 'b', turns: [turn('t1', [userText('u', '旧的')])] }))
  core.start()
  await settle()
  await command('device.loadArchived', { deviceId: 'local' })
  await settle()
  const session = watch(core, 'b')
  await settle()
  assert.equal(session.seen.view?.live, false)
  session.close()
  await settle()
  assert.deepEqual(sent('thread/unsubscribe'), [])
  // 关掉后留着一阵：再打开还是只读的那一份，不再读一遍
  const again = watch(core, 'b')
  await settle()
  assert.equal(again.seen.view?.live, false)
  assert.equal(sent('thread/read').length, 1)
})

test('已归档：模拟核心里归档着的会话能只读地打开，恢复之后能发消息', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  await core.command('device.loadArchived', { deviceId: 'local' }, never)
  let view: SessionView | null = null
  const ops: SessionOp[] = []
  core.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 'a1' },
    {
      snapshot: (data) => {
        view = structuredClone(data as SessionView)
      },
      delta: (delta) => ops.push(...(delta as SessionOp[])),
      error() {},
    },
  )
  const peeked = view as SessionView | null
  assert.equal(peeked?.live, false)
  assert.deepEqual(peeked?.note, { key: 'session.archived' })
  assert.ok((peeked?.turns.length ?? 0) > 0)
  await core.command('session.unarchive', { deviceId: 'local', sessionId: 'a1' }, never)
  assert.deepEqual(
    ops.filter((op) => op.op === 'session.state'),
    [{ op: 'session.state', live: true, note: null }],
  )
})

/** 会话里某个回合的待办条目 */
const todoOf = (view: SessionView | null, turnId: string) => {
  const item = view?.items[`${turnId}:#todo`]
  if (item?.kind !== 'todo') return null
  // 看着它出现的时刻（span）不比
  const { span: _span, ...rest } = item
  return rest
}

test('待办：模型每改一次整份换掉，位置不变；回合结束后留着，没做完的不再标成正在做', async () => {
  const running = turn('t1', [userText('u', '把启动拆开')], { status: 'inProgress' })
  const { core, peer } = setup([thread({ id: 'a', turns: [running] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const server = peer.last()
  const base = { threadId: 'a', turnId: 't1' }
  const order = () => session.seen.view?.turns[0]?.itemIds

  server.notify('turn/plan/updated', {
    ...base,
    explanation: '  先列出来  ',
    plan: [
      { step: '读代码', status: 'inProgress' },
      { step: '改', status: 'pending' },
    ],
  })
  await settle()
  assert.deepEqual(order(), ['t1:u', 't1:#todo'])
  assert.deepEqual(todoOf(session.seen.view, 't1'), {
    id: 't1:#todo',
    kind: 'todo',
    note: '先列出来',
    steps: [
      { text: '读代码', status: 'inProgress' },
      { text: '改', status: 'pending' },
    ],
  })

  // 后面又来了别的条目，再改一次待办：还是那一个条目，还在原来的位置
  server.notify('item/started', { ...base, item: commandItem('c1', 'npm test'), startedAtMs: 0 })
  server.notify('turn/plan/updated', {
    ...base,
    explanation: null,
    plan: [
      { step: '读代码', status: 'completed' },
      { step: '改', status: 'inProgress' },
      // 这一版客户端不认识的状态：按还没做算
      { step: '测', status: '以后才有的状态' },
    ],
  })
  await settle()
  assert.deepEqual(order(), ['t1:u', 't1:#todo', 't1:c1'])
  assert.equal(todoOf(session.seen.view, 't1')?.note, null)
  assert.deepEqual(
    todoOf(session.seen.view, 't1')?.steps.map((step) => step.status),
    ['completed', 'inProgress', 'pending'],
  )

  // 回合被打断：待办留在对话里，“正在做”的那一步其实没做完
  server.notify('turn/completed', {
    threadId: 'a',
    turn: turn('t1', [], { status: 'interrupted', durationMs: 900 }),
  })
  await settle()
  assert.equal(session.seen.view?.turns[0]?.status, 'interrupted')
  assert.deepEqual(order(), ['t1:u', 't1:#todo', 't1:c1'])
  assert.deepEqual(
    todoOf(session.seen.view, 't1')?.steps.map((step) => step.status),
    ['completed', 'pending', 'pending'],
  )

  // 清空了的待办不留一个空架子
  server.notify('turn/plan/updated', { ...base, explanation: null, plan: [] })
  await settle()
  assert.deepEqual(order(), ['t1:u', 't1:c1'])
  assert.equal(todoOf(session.seen.view, 't1'), null)
})

test('待办：协议的历史里没有它，会话放掉再打开还在原来的位置；会话删掉了就不留', async () => {
  const { core, world, peer, time, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const server = peer.last()

  // 本机发出的回合：界面里用的是临时标识，对面的更新照样落在这个回合上
  await command('session.send', { ...where, text: '列个待办' })
  server.notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  server.notify('item/started', {
    threadId: 'a',
    turnId: 'srv-1',
    item: userText('u1', '列个待办'),
    startedAtMs: 0,
  })
  server.notify('turn/plan/updated', {
    threadId: 'a',
    turnId: 'srv-1',
    explanation: null,
    plan: [
      { step: '一', status: 'completed' },
      { step: '二', status: 'inProgress' },
    ],
  })
  server.notify('item/completed', {
    threadId: 'a',
    turnId: 'srv-1',
    item: agentText('m1', '做完了'),
    completedAtMs: 0,
  })
  await settle()
  const local = session.seen.view?.turns[0]
  assert.ok(local?.id.startsWith('local:'))
  assert.deepEqual(
    local?.itemIds.map((id) => session.seen.view?.items[id]?.kind),
    ['userMessage', 'todo', 'agentMessage'],
  )
  server.notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()

  // 没人看了：留一阵后退订、放掉。对面的历史里只有消息，没有待办
  session.close()
  await settle()
  time.advance(10 * 60_000)
  await settle()
  assert.equal(sent('thread/unsubscribe').length, 1)
  const stored = thread({
    id: 'a',
    turns: [
      turn('srv-1', [userText('u1', '列个待办'), agentText('m1', '做完了')], {
        status: 'completed',
      }),
    ],
  })
  world.threads = [stored]
  const again = watch(core)
  await settle()
  assert.deepEqual(again.seen.view?.turns[0]?.itemIds, ['srv-1:u1', 'srv-1:#todo', 'srv-1:m1'])
  assert.deepEqual(
    todoOf(again.seen.view, 'srv-1')?.steps.map((step) => step.status),
    ['completed', 'pending'],
  )

  // 归档再放回来：还在
  again.close()
  await settle()
  await command('session.archive', where)
  await command('session.unarchive', where)
  const restored = watch(core)
  await settle()
  assert.ok(todoOf(restored.seen.view, 'srv-1'))
  restored.close()
  await settle()

  // 对面说这个会话删掉了：为它记着的待办不留。（假对端这里还留着同名的会话，正好拿来看）
  server.notify('thread/deleted', { threadId: 'a' })
  await settle()
  const after = watch(core)
  await settle()
  assert.deepEqual(after.seen.view?.turns[0]?.itemIds, ['srv-1:u1', 'srv-1:m1'])
})

test('待办：模拟核心里话里带“待办”就列一份，一步一步做完；打断时没做完的不再标成正在做', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 10 })
  let view: SessionView | null = null
  core.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's4' },
    {
      snapshot: (data) => {
        view = structuredClone(data as SessionView)
      },
      delta: (delta) => {
        for (const op of delta as SessionOp[]) if (view) reduceSession(view, structuredClone(op))
      },
      error() {},
    },
  )
  const now = () => view as SessionView | null
  const target = { deviceId: 'local', sessionId: 's4' }
  const todo = () => {
    const turnId = now()?.turns.at(-1)?.id ?? ''
    return todoOf(now(), turnId)
  }
  const statuses = () => todo()?.steps.map((step) => step.status)

  await core.command('session.send', { ...target, text: '列一份待办再动手' }, never)
  assert.deepEqual(statuses(), ['inProgress', 'pending', 'pending', 'pending'])
  assert.ok(todo()?.note)
  const place = now()
    ?.turns.at(-1)
    ?.itemIds.indexOf(todo()?.id ?? '')
  time.advance(80)
  assert.deepEqual(statuses(), ['completed', 'inProgress', 'pending', 'pending'])
  assert.equal(todo()?.note, null)
  // 做到一半多加了一步：待办变长，还是同一个条目
  time.advance(80)
  assert.deepEqual(statuses(), ['completed', 'completed', 'inProgress', 'pending', 'pending'])
  assert.equal(
    now()
      ?.turns.at(-1)
      ?.itemIds.indexOf(todo()?.id ?? ''),
    place,
  )
  time.advance(80 * 3)
  assert.deepEqual(statuses(), ['completed', 'completed', 'completed', 'completed', 'completed'])
  assert.equal(now()?.turns.at(-1)?.status, 'running')
  // 做完之后照常回话，回合结束，待办留着
  time.advance(60_000)
  assert.equal(now()?.turns.at(-1)?.status, 'completed')
  assert.equal(todo()?.steps.length, 5)

  // 再来一次，做到一半打断
  await core.command('session.send', { ...target, text: 'todo again' }, never)
  time.advance(80)
  assert.deepEqual(statuses(), ['completed', 'inProgress', 'pending', 'pending'])
  await core.command('session.interrupt', target, never)
  assert.equal(now()?.turns.at(-1)?.status, 'interrupted')
  assert.deepEqual(statuses(), ['completed', 'pending', 'pending', 'pending'])
  // 打断之后那份待办不再往下走
  time.advance(60_000)
  assert.deepEqual(statuses(), ['completed', 'pending', 'pending', 'pending'])
})

/** 一个有三轮问答的会话 */
const threeTurns = () =>
  thread({
    id: 'a',
    turns: ['t1', 't2', 't3'].map((id) =>
      turn(id, [userText(`${id}-u`, `问 ${id}`), agentText(`${id}-m`, `答 ${id}`)], {
        status: 'completed',
      }),
    ),
  })

const turnIds = (view: SessionView | null) => view?.turns.map((entry) => entry.id)

test('分叉：新会话带到那个回合为止，进了侧栏；原来的会话不动；回合在进行时不让分', async () => {
  const forked = thread({ id: 'f1', name: '分出来的', cwd: '/work/app' })
  const { core, peer, command, sent, sidebar } = setup([threeTurns()], {
    'thread/fork': () => ({ thread: forked }),
  })
  core.start()
  await settle()
  const session = watch(core)
  await settle()

  const result = await command('session.fork', { ...where, turnId: 't2' })
  assert.deepEqual(result, { sessionId: 'f1' })
  assert.deepEqual(sent('thread/fork'), [{ threadId: 'a', lastTurnId: 't2', excludeTurns: true }])
  // 不等对面的通知，新会话已经在侧栏里
  assert.ok(
    sidebar.ops.some(
      (op) =>
        op.op === 'session.upsert' && op.session.id === 'f1' && op.session.title === '分出来的',
    ),
  )
  assert.deepEqual(turnIds(session.seen.view), ['t1', 't2', 't3'])

  await assert.rejects(command('session.fork', { ...where, turnId: '没有这个回合' }), {
    code: 'rejected',
  })
  peer.last().notify('turn/started', { threadId: 'a', turn: started('t4') })
  await settle()
  await assert.rejects(command('session.fork', { ...where, turnId: 't2' }), { code: 'rejected' })
  assert.equal(sent('thread/fork').length, 1)
})

test('分叉：分出来的会话记着从哪个会话分出来（读历史时也有），子代理会话照上一级起的那一层不算', async () => {
  const forked = thread({ id: 'f1', forkedFromId: 'a', turns: [] })
  const spawned = thread({ id: 's1', forkedFromId: 'a', parentThreadId: 'a', turns: [] })
  const { core } = setup([threeTurns(), forked, spawned])
  core.start()
  await settle()
  const original = watch(core)
  const child = watch(core, 'f1')
  const agent = watch(core, 's1')
  await settle()
  assert.deepEqual(
    [original.seen.view?.forkedFrom, child.seen.view?.forkedFrom, agent.seen.view?.forkedFrom],
    [null, 'a', null],
  )
})

test('回退：按回合的标识撤掉那个回合和后面的，为它们记着的待办一并不留；自己发的回退不引起重新载入', async () => {
  /** 对面在应答之前要做的事，等搭好了再填 */
  const hooks = { reverted() {} }
  const { core, world, peer, command, sent } = setup([threeTurns()], {
    'thread/revert': (params) => {
      const { beforeTurnId } = params as { beforeTurnId: string }
      const source = world.threads[0] as Thread
      const at = source.turns.findIndex((entry) => entry.id === beforeTurnId)
      if (at < 0) throw new RpcFailure(-32602, '无效回退边界')
      const next = { ...source, turns: source.turns.slice(0, at) }
      world.threads = [next]
      // 和真的引擎一样：先发“历史被改写了”的通知，再应答
      hooks.reverted()
      return {
        thread: { ...next, turns: [] },
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      }
    },
  })
  hooks.reverted = () => peer.last().notify('thread/reverted', { threadId: 'a' })
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const server = peer.last()
  server.notify('turn/plan/updated', {
    threadId: 'a',
    turnId: 't3',
    explanation: null,
    plan: [{ step: '一', status: 'completed' }],
  })
  await settle()
  assert.ok(todoOf(session.seen.view, 't3'))

  await command('session.rollback', { ...where, turnId: 't2' })
  await settle()
  assert.deepEqual(sent('thread/revert'), [{ threadId: 'a', beforeTurnId: 't2' }])
  assert.deepEqual(turnIds(session.seen.view), ['t1'])
  assert.deepEqual(Object.keys(session.seen.view?.items ?? {}), ['t1:t1-u', 't1:t1-m'])
  // 没有因为那条通知重新载入一遍
  assert.equal(sent('thread/resume').length, 1)
  assert.equal(session.seen.snapshots, 1)

  // 别的客户端回退了它：不知道撤掉了哪些，重新载入
  world.threads = [{ ...(world.threads[0] as Thread), turns: [] }]
  server.notify('thread/reverted', { threadId: 'a' })
  await settle()
  assert.equal(sent('thread/resume').length, 2)
  assert.deepEqual(turnIds(session.seen.view), [])

  // 回合在进行时不让回退
  server.notify('turn/started', { threadId: 'a', turn: started('t9') })
  await settle()
  await assert.rejects(command('session.rollback', { ...where, turnId: 't9' }), {
    code: 'rejected',
  })
  assert.equal(sent('thread/revert').length, 1)
})

test('回退：本机刚发出的回合用的是临时标识，告诉对面的是协议里的标识', async () => {
  const { core, peer, command, sent } = setup(undefined, {
    'thread/revert': (params) => ({
      thread: thread({ id: (params as { threadId: string }).threadId }),
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    }),
  })
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '第一句' })
  peer.last().notify('turn/started', { threadId: 'a', turn: started('srv-1') })
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()
  const local = session.seen.view?.turns[0]?.id ?? ''
  assert.ok(local.startsWith('local:'))
  await command('session.rollback', { ...where, turnId: local })
  assert.deepEqual(sent('thread/revert'), [{ threadId: 'a', beforeTurnId: 'srv-1' }])
  assert.deepEqual(turnIds(session.seen.view), [])
})

test('压缩：受理了就返回，压缩作为一个回合照常从通知里来；回合在进行时不让压', async () => {
  const { core, peer, command, sent } = setup([threeTurns()], {
    'thread/compact/start': () => ({}),
  })
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.compact', where)
  assert.deepEqual(sent('thread/compact/start'), [{ threadId: 'a' }])
  const server = peer.last()
  server.notify('turn/started', { threadId: 'a', turn: started('c1') })
  await settle()
  await assert.rejects(command('session.compact', where), { code: 'rejected' })
  const item = { type: 'contextCompaction', id: 'compact:1' } as const
  server.notify('item/started', { threadId: 'a', turnId: 'c1', item, startedAtMs: 0 })
  await settle()
  // 压的时候：一条“正在压缩”，是这边点的；不另外写“正在工作”
  const compaction = () => {
    const view = session.seen.view
    const id = view?.turns.at(-1)?.itemIds[0]
    return id ? view?.items[id] : undefined
  }
  assert.deepEqual(
    { ...compaction(), span: undefined },
    {
      id: 'c1:compact:1',
      kind: 'compaction',
      status: 'inProgress',
      source: 'manual',
      span: undefined,
    },
  )
  // 压了多久按 span 算（界面压久了多写一句）
  assert.equal(compaction()?.span?.to, null)
  server.notify('item/completed', { threadId: 'a', turnId: 'c1', item, completedAtMs: 0 })
  server.notify('turn/completed', { threadId: 'a', turn: finished('c1') })
  await settle()
  const last = session.seen.view?.turns.at(-1)
  assert.equal(last?.status, 'completed')
  assert.deepEqual(
    last?.itemIds.map((id) => session.seen.view?.items[id]?.kind),
    ['compaction'],
  )
  assert.equal((compaction() as { status?: string }).status, 'completed')
  assert.equal((compaction() as { source?: string }).source, 'manual')
  assert.equal(sent('thread/compact/start').length, 1)
})

test('自动压缩：用户回合里开始压是“正在压缩”、算自动的；回合结束了还没等到完成就是没压完', async () => {
  const { core, peer } = setup([threeTurns()])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const server = peer.last()
  const compaction = () => {
    const view = session.seen.view
    const id = view?.turns.at(-1)?.itemIds.at(-1)
    return id ? view?.items[id] : undefined
  }
  server.notify('turn/started', { threadId: 'a', turn: started('t9') })
  server.notify('item/started', {
    threadId: 'a',
    turnId: 't9',
    item: { type: 'contextCompaction', id: 'auto' },
    startedAtMs: 0,
  })
  await settle()
  assert.equal(compaction()?.kind, 'compaction')
  assert.deepEqual(
    [(compaction() as { status?: string }).status, (compaction() as { source?: string }).source],
    ['inProgress', 'automatic'],
  )
  server.notify('turn/completed', { threadId: 'a', turn: finished('t9') })
  await settle()
  assert.equal((compaction() as { status?: string }).status, 'interrupted')
})

test('降级：对面说不认识的事记成不会，开着的会话都知道，之后不再去问；重新连上从头再试', async () => {
  const { core, peer, time, command, sent } = setup(
    [threeTurns(), thread({ id: 'b', turns: [] })],
    {
      // 适配器的说法：方法不存在
      'thread/fork': () => {
        throw new RpcFailure(-32601, 'Method not found')
      },
      // 原生 codex 的说法：无效请求，原因里写着不认识这个变体
      'thread/compact/start': () => {
        throw new RpcFailure(
          -32600,
          'Invalid request: unknown variant `thread/compact/start`, expected one of `initialize`',
        )
      },
      // 同样是“无效请求”，但说的是别的事：不能因此认定对面不会回退
      'thread/revert': () => {
        throw new RpcFailure(-32600, 'Invalid request: thread is busy')
      },
    },
  )
  core.start()
  await settle()
  const session = watch(core)
  const other = watch(core, 'b')
  await settle()
  // 对面没有声明：先当它都会
  const all = { ...ALL_ABLE }
  assert.deepEqual(session.seen.view?.can, all)

  await assert.rejects(command('session.fork', { ...where, turnId: 't1' }), { code: 'unsupported' })
  assert.deepEqual(session.seen.view?.can, { ...all, fork: false })
  // 别的开着的会话也知道了：这是这台设备的事，不是这一个会话的事
  assert.deepEqual(other.seen.view?.can, { ...all, fork: false })
  await assert.rejects(command('session.fork', { ...where, turnId: 't1' }), { code: 'unsupported' })
  assert.equal(sent('thread/fork').length, 1)

  await assert.rejects(command('session.compact', where), { code: 'unsupported' })
  assert.equal(session.seen.view?.can.compact, false)

  await assert.rejects(command('session.rollback', { ...where, turnId: 't3' }), { code: 'remote' })
  assert.equal(session.seen.view?.can.rollback, true)
  // 回退没成，对话原样留着
  assert.deepEqual(turnIds(session.seen.view), ['t1', 't2', 't3'])

  // 之后才打开的会话，一上来就知道
  other.close()
  await settle()
  const late = watch(core, 'b')
  await settle()
  assert.deepEqual(late.seen.view?.can, { ...all, fork: false, compact: false })

  // 断线重连：对面可能升级过，从头再试
  peer.last().drop()
  await settle()
  time.advance(500)
  await settle()
  await settle()
  assert.equal(session.seen.snapshots, 2)
  assert.deepEqual(session.seen.view?.can, all)
})

test('分叉、回退、压缩：模拟核心都支持；没有声明的不会就试过一次才停，有声明的照声明', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 10 })
  const open = (sessionId: string, deviceId = 'local') => {
    const seen = { view: null as SessionView | null }
    core.subscribe(
      { kind: 'session', deviceId, sessionId },
      {
        snapshot: (data) => {
          seen.view = structuredClone(data as SessionView)
        },
        delta: (delta) => {
          for (const op of delta as SessionOp[])
            if (seen.view) reduceSession(seen.view, structuredClone(op))
        },
        error() {},
      },
    )
    return seen
  }
  const target = { deviceId: 'local', sessionId: 's3' }
  const session = open('s3')
  await core.command('session.send', { ...target, text: '第一句' }, never)
  time.advance(60_000)
  await core.command('session.send', { ...target, text: '第二句' }, never)
  time.advance(60_000)
  const ids = turnIds(session.view) ?? []
  const [first, second] = ids.slice(-2) as [string, string]
  const before = ids.length

  // 分叉：新会话里有到第一句那一轮为止的内容
  const { sessionId } = (await core.command(
    'session.fork',
    { ...target, turnId: first },
    never,
  )) as { sessionId: string }
  const fork = open(sessionId)
  assert.deepEqual(turnIds(fork.view), ids.slice(0, -1))
  assert.deepEqual(turnIds(session.view), ids)
  // 记着从哪个会话分出来的，原来的会话不是分出来的
  assert.deepEqual([fork.view?.forkedFrom, session.view?.forkedFrom], ['s3', null])
  // 分出来的会话能照常发消息，不影响原来的
  await core.command('session.send', { deviceId: 'local', sessionId, text: '岔出去说' }, never)
  time.advance(60_000)
  assert.equal(turnIds(fork.view)?.length, before)
  assert.deepEqual(turnIds(session.view), ids)

  // 回退：第二句那一轮没了
  await core.command('session.rollback', { ...target, turnId: second }, never)
  assert.deepEqual(turnIds(session.view), ids.slice(0, -1))

  // 压缩：一个没有用户消息的回合，先是“正在压缩”，压完是“已压缩”，占用降下来
  const used = session.view?.usage?.usedTokens ?? 0
  await core.command('session.compact', target, never)
  assert.equal(session.view?.turns.at(-1)?.status, 'running')
  const compaction = () => {
    const id = session.view?.turns.at(-1)?.itemIds[0]
    const item = id ? session.view?.items[id] : undefined
    return item?.kind === 'compaction' ? [item.status, item.source] : item?.kind
  }
  assert.deepEqual(compaction(), ['inProgress', 'manual'])
  time.advance(60_000)
  const last = session.view?.turns.at(-1)
  assert.equal(last?.status, 'completed')
  assert.equal(last?.itemIds.length, 1)
  assert.deepEqual(compaction(), ['completed', 'manual'])
  assert.ok((session.view?.usage?.usedTokens ?? 0) < used)

  // 没有声明的那台（直接连的原生 codex）不会分叉：试过一次才知道
  const bare = open('n1', 'nas')
  assert.deepEqual(bare.view?.can, { ...ALL_ABLE })
  const bareTurn = bare.view?.turns[0]?.id ?? ''
  await assert.rejects(
    core.command('session.fork', { deviceId: 'nas', sessionId: 'n1', turnId: bareTurn }, never),
    { code: 'unsupported' },
  )
  assert.deepEqual(bare.view?.can, { ...ALL_ABLE, fork: false })
  // 别的设备、别的引擎的会话不受影响
  assert.equal(session.view?.can.fork, true)

  // 有声明的照声明：dsh 说了不会分叉、回退、压缩，一上来就是不会，去做也不会发出去
  const dsh = open('s4')
  assert.deepEqual(dsh.view?.can, {
    fork: false,
    rollback: false,
    rollbackRestoresFiles: false,
    cutInTurn: false,
    compact: false,
    steer: true,
    steerImages: true,
    finalOnStart: false,
    backgroundTasks: true,
    goals: false,
    sideChat: false,
    declared: true,
  })
  await assert.rejects(
    core.command('session.compact', { deviceId: 'local', sessionId: 's4' }, never),
    {
      code: 'unsupported',
    },
  )
})
