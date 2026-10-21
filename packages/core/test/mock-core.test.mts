import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AppOp,
  type AppView,
  type ChannelError,
  connectChannel,
  createMockCore,
  createPortPair,
  type DeviceView,
  OUTPUT_KEEP,
  reduceSession,
  type SessionOp,
  type SessionView,
  type SidebarOp,
  type SidebarView,
  serveChannel,
  workingShown,
} from '../src/index.mjs'
import { chunkText, FLOOD_COMMAND } from '../src/mock/mock-core.mjs'
import { STREAM_SESSION, streamText } from '../src/mock/sample-data.mjs'
import { DUMP_END, DUMP_TOOL, SHOTS_TOOL } from '../src/mock/sample-tools.mjs'
import { fakeClock, settle } from './helpers.mjs'

const { head: STREAM_HEAD, rest: STREAM_REST } = streamText('zh-CN')

function setup(chunkMs?: number) {
  const time = fakeClock()
  const [uiPort, corePort] = createPortPair()
  const options = chunkMs === undefined ? { clock: time.clock } : { clock: time.clock, chunkMs }
  serveChannel(corePort, createMockCore(options), { clock: time.clock })
  return { channel: connectChannel(uiPort), time }
}

const streamTopic = {
  kind: 'session',
  deviceId: STREAM_SESSION.deviceId,
  sessionId: STREAM_SESSION.sessionId,
} as const

test('切块：切完拼回去和原文一样，每块 2 到 6 个字', () => {
  const chunks = chunkText(STREAM_REST)
  assert.equal(chunks.join(''), STREAM_REST)
  for (const chunk of chunks.slice(0, -1)) {
    const length = Array.from(chunk).length
    assert.ok(length >= 2 && length <= 6, `块长 ${length}`)
  }
})

test('应用主题：四台设备，其中一台连不上正在重试、一台只有 codex', async () => {
  const { channel } = setup()
  let app: AppView | null = null
  channel.subscribe({ kind: 'app' }, { snapshot: (data) => (app = data), delta() {} })
  await settle()
  const devices = (app as AppView | null)?.devices ?? []
  assert.deepEqual(
    devices.map((device) => [device.id, device.connection, device.mode]),
    [
      ['local', 'online', 'full'],
      ['build', 'online', 'full'],
      ['nas', 'online', 'single'],
      ['gpu', 'reconnecting', 'full'],
    ],
  )
})

test('侧栏主题：不存在的设备报 notFound', async () => {
  const { channel } = setup()
  const errors: string[] = []
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'nope' },
    { snapshot() {}, delta() {}, error: (error) => errors.push(error.code) },
  )
  await settle()
  assert.deepEqual(errors, ['notFound'])
})

test('标成已读：侧栏收到这一个会话的更新', async () => {
  const { channel, time } = setup()
  let view: SidebarView | null = null
  const ops: SidebarOp[] = []
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    { snapshot: (data) => (view = data), delta: (batch) => ops.push(...batch) },
  )
  await settle()
  const before = (view as SidebarView | null)?.sessions.find((session) => session.id === 's3')
  assert.equal(before?.unread, true)

  await channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  time.advance(16)
  await settle()
  assert.equal(ops.length, 1)
  const [op] = ops
  assert.ok(op && op.op === 'session.upsert')
  assert.equal(op.session.id, 's3')
  assert.equal(op.session.unread, false)

  await assert.rejects(channel.command('session.markRead', { deviceId: 'local', sessionId: 'x' }), {
    code: 'notFound',
  })
})

test('流式：订阅进行中的会话后文本一段段到达，结束时条目、回合、侧栏都变成完成', async () => {
  const { channel, time } = setup(60)
  let text = ''
  let itemStatus = ''
  let turnStatus = ''
  let batches = 0
  const sidebarOps: SidebarOp[] = []
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    { snapshot() {}, delta: (batch) => sidebarOps.push(...batch) },
  )
  channel.subscribe(streamTopic, {
    snapshot(data) {
      const item = data.items[STREAM_SESSION.itemId]
      assert.ok(item && item.kind === 'agentMessage')
      text = item.text
      itemStatus = item.status
    },
    delta(ops: SessionOp[]) {
      batches++
      for (const op of ops) {
        if (op.op === 'item.appendText') text += op.text
        if (op.op === 'item.status') itemStatus = op.status
        if (op.op === 'turn.status') turnStatus = op.status
      }
    },
  })
  await settle()
  assert.equal(text, STREAM_HEAD)
  assert.equal(itemStatus, 'inProgress')

  // 一步一步拨时钟，每步之后让端口把消息送完
  for (let i = 0; i < 2000 && turnStatus !== 'completed'; i++) {
    time.advance(20)
    await settle()
  }
  assert.equal(text, STREAM_HEAD + STREAM_REST)
  assert.equal(itemStatus, 'completed')
  assert.equal(turnStatus, 'completed')
  assert.ok(batches > 10, `应该分很多批到达，实际 ${batches} 批`)
  const last = sidebarOps.at(-1)
  assert.ok(last && last.op === 'session.upsert')
  assert.equal(last.session.status, 'idle')

  // 之后再订阅，快照里是完整的文本，没有重复追加
  let again: SessionView | null = null
  channel.subscribe(streamTopic, { snapshot: (data) => (again = data), delta() {} })
  await settle()
  const item = (again as SessionView | null)?.items[STREAM_SESSION.itemId]
  assert.ok(item && item.kind === 'agentMessage')
  assert.equal(item.text, STREAM_HEAD + STREAM_REST)
  assert.equal(time.pending(), 0, '流完之后不该留着定时器')
})

test('流式：没人看了就复位，再打开时从头再流一遍', async () => {
  const { channel, time } = setup(60)
  const texts: string[] = []
  const open = () =>
    channel.subscribe(streamTopic, {
      snapshot(data) {
        const item = data.items[STREAM_SESSION.itemId]
        if (item?.kind === 'agentMessage') texts.push(item.text)
      },
      delta() {},
    })
  const close = open()
  await settle()
  time.advance(600)
  await settle()
  close()
  await settle()
  assert.equal(time.pending(), 0, '退订后上一轮的定时器要停')
  open()
  await settle()
  assert.deepEqual(texts, [STREAM_HEAD, STREAM_HEAD])
})

/** 订阅应用主题，像界面那样把增量落下来，随时能问某台设备现在的样子 */
function watchApp(channel: ReturnType<typeof setup>['channel']) {
  const devices = new Map<string, DeviceView>()
  channel.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        for (const device of data.devices) devices.set(device.id, device)
      },
      delta(ops: AppOp[]) {
        for (const op of ops) if (op.op === 'device.upsert') devices.set(op.device.id, op.device)
      },
    },
  )
  return (id: string) => devices.get(id)
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('完整模式的设备：一个 harness 不可用，说得出原因，设备下面说明留着的是它上次的会话', async () => {
  const { channel } = setup()
  const device = watchApp(channel)
  await settle()
  const local = device('local')
  assert.equal(local?.mode, 'full')
  assert.deepEqual(
    local?.harnesses.map((entry) => [entry.id, entry.state]),
    [
      ['claude', 'ready'],
      ['pi', 'ready'],
      ['dsh', 'ready'],
      ['codex', 'unavailable'],
    ],
  )
  const codex = local?.harnesses.find((entry) => entry.id === 'codex')
  // 种类是认识的：说得出是哪一句，界面还能按种类说下一步
  assert.equal(codex?.down, 'notInstalled')
  assert.deepEqual(codex?.reason, { key: 'harness.notInstalled' })
  assert.ok(codex?.detail, '设备服务的原话也带着')
  // 它的会话还留在侧栏里：记着是它，但不为此占一句说明
  assert.deepEqual(local?.stranded, ['codex'])
  assert.equal(local?.note, null)
  // 全都可用的设备没有
  assert.deepEqual(device('build')?.stranded, [])
})

test('完整模式的设备：新建会话建在选的 harness 上；选到不可用的、没有的，各说各的那一句', async () => {
  const { channel, time } = setup()
  let sidebar: SidebarView | null = null
  const ops: SidebarOp[] = []
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    { snapshot: (data) => (sidebar = data), delta: (batch) => ops.push(...batch) },
  )
  await settle()
  assert.ok(sidebar)
  const create = (harness?: string) =>
    channel.command('session.create', {
      deviceId: 'local',
      cwd: null,
      text: '开一个',
      ...(harness ? { harness } : {}),
    })
  const harnessOf = (sessionId: string) => {
    const op = ops.findLast(
      (entry) => entry.op === 'session.upsert' && entry.session.id === sessionId,
    )
    return op?.op === 'session.upsert' ? op.session.harness : null
  }
  const onDsh = await create('dsh')
  time.advance(16)
  await settle()
  assert.equal(harnessOf(onDsh.sessionId), 'dsh')
  // 没说建在哪：第一个可用的
  const onFirst = await create()
  time.advance(16)
  await settle()
  assert.equal(harnessOf(onFirst.sessionId), 'claude')

  const down = await failureOf(create('codex'))
  assert.deepEqual(down.text, { key: 'fault.harnessUnavailable', args: { name: 'Codex' } })
  const unknown = await failureOf(create('nope'))
  assert.deepEqual(unknown.text, { key: 'fault.unknownHarness', args: { name: 'nope' } })
})

test('完整模式的设备：底栏的选择器每个 harness 各有各的一份', async () => {
  const { channel } = setup()
  const models = async (harness: string) =>
    (await channel.command('device.composeOptions', { deviceId: 'local', harness })).models.map(
      (entry) => entry.id,
    )
  const [claude, pi, dsh] = [await models('claude'), await models('pi'), await models('dsh')]
  assert.ok(claude.length > 0 && pi.length > 0 && dsh.length > 0)
  assert.notDeepEqual(claude, pi)
  assert.notDeepEqual(pi, dsh)
  assert.notDeepEqual(claude, dsh)
})

test('完整模式的设备：不可用的 harness 上的会话发不出去；别的照常', async () => {
  const { channel } = setup()
  // s5 是 codex 的会话，codex 这时不可用
  const failure = await failureOf(
    channel.command('session.send', { deviceId: 'local', sessionId: 's5', text: '在吗' }),
  )
  assert.equal(failure.code, 'remote')
  assert.deepEqual(failure.text, { key: 'fault.harnessUnavailable', args: { name: 'Codex' } })
  await channel.command('session.send', { deviceId: 'local', sessionId: 's4', text: '在吗' })
})

test('完整模式的设备：消息里说“掉线”，这个会话的 harness 就掉线，过一会儿自己回来', async () => {
  const { channel, time } = setup(20)
  const device = watchApp(channel)
  let view: SessionView | null = null
  channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's4' },
    {
      snapshot: (data) => (view = structuredClone(data)),
      delta(ops: SessionOp[]) {
        for (const op of ops) if (view) reduceSession(view, structuredClone(op))
      },
    },
  )
  await settle()
  const dsh = () => device('local')?.harnesses.find((entry) => entry.id === 'dsh')
  assert.equal(dsh()?.state, 'ready')

  await channel.command('session.send', { deviceId: 'local', sessionId: 's4', text: '掉线试试' })
  time.advance(16)
  await settle()
  assert.equal(dsh()?.state, 'unavailable')
  assert.deepEqual(dsh()?.reason, { key: 'harness.disconnected' })
  assert.deepEqual(device('local')?.stranded, ['dsh', 'codex'])
  // 掉线期间这个会话发不出去，别的 harness 的照常
  const failure = await failureOf(
    channel.command('session.send', { deviceId: 'local', sessionId: 's4', text: '还在吗' }),
  )
  assert.deepEqual(failure.text, { key: 'fault.harnessUnavailable', args: { name: 'dsh' } })
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '在吗' })

  // 过一会儿它回来了：恢复可用，掉线时停在那里的回合记成中断，之后照常能发
  for (let i = 0; i < 200 && dsh()?.state !== 'ready'; i++) {
    time.advance(20)
    await settle()
  }
  assert.equal(dsh()?.state, 'ready')
  assert.equal(dsh()?.reason, null)
  time.advance(16)
  await settle()
  assert.equal((view as SessionView | null)?.turns.at(-1)?.status, 'interrupted')
  await channel.command('session.send', { deviceId: 'local', sessionId: 's4', text: '回来了吗' })
})

test('流式：间隔设成 0 时一开始就是完整的', async () => {
  const { channel, time } = setup(0)
  let view: SessionView | null = null
  channel.subscribe(streamTopic, { snapshot: (data) => (view = data), delta() {} })
  await settle()
  time.advance(16)
  await settle()
  let fresh: SessionView | null = null
  channel.subscribe(streamTopic, { snapshot: (data) => (fresh = data), delta() {} })
  await settle()
  assert.ok(view)
  const item = (fresh as SessionView | null)?.items[STREAM_SESSION.itemId]
  assert.ok(item && item.kind === 'agentMessage')
  assert.equal(item.text, STREAM_HEAD + STREAM_REST)
  assert.equal(item.status, 'completed')
})

test('“跑一会儿”：命令先不出输出地跑着（带着开始的时刻），到点一次给全输出，再回话；codex 的会话声明了最终回答开始即知', async () => {
  const { channel, time } = setup(20)
  const watch = (deviceId: string, sessionId: string) => {
    const seen = { view: null as SessionView | null }
    channel.subscribe(
      { kind: 'session', deviceId, sessionId },
      {
        snapshot: (data) => {
          seen.view = structuredClone(data)
        },
        delta(ops: SessionOp[]) {
          for (const op of ops) if (seen.view) reduceSession(seen.view, structuredClone(op))
        },
      },
    )
    return seen
  }
  const onClaude = watch('local', 's3')
  const onCodex = watch('build', 'b6')
  await settle()
  assert.equal(onClaude.view?.can.finalOnStart, false)
  assert.equal(onCodex.view?.can.finalOnStart, true)

  const startedAt = time.clock.now()
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '跑一会儿' })
  // 变化是攒一小会儿才送到这边的
  time.advance(16)
  await settle()
  const command = () =>
    Object.values(onClaude.view?.items ?? {}).find((item) => item.id.endsWith('-w'))
  const running = command()
  assert.equal(running?.kind, 'command')
  if (running?.kind !== 'command') return
  assert.deepEqual(
    [running.status, running.output, running.startedAt, running.durationMs],
    ['inProgress', '', startedAt, null],
  )
  time.advance(2364)
  await settle()
  const still = command()
  assert.equal(still?.kind === 'command' && still.status, 'inProgress', '还差 20 毫秒，没到点')
  time.advance(40)
  await settle()
  const done = command()
  assert.equal(done?.kind, 'command')
  if (done?.kind !== 'command') return
  assert.deepEqual([done.status, done.exitCode, done.durationMs], ['completed', 0, 2400])
  assert.match(done.output, /42/)
  // 之后照常回话，回合走到结束
  for (let i = 0; i < 400 && onClaude.view?.turns.at(-1)?.status === 'running'; i++) {
    time.advance(20)
    await settle()
  }
  assert.equal(onClaude.view?.turns.at(-1)?.status, 'completed')

  // 没跑完就被打断：命令不留着一直转
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '再跑一会儿' })
  time.advance(16)
  await settle()
  await channel.command('session.interrupt', { deviceId: 'local', sessionId: 's3' })
  time.advance(16)
  await settle()
  const cut = Object.values(onClaude.view?.items ?? {})
    .filter((item) => item.id.endsWith('-w'))
    .at(-1)
  assert.equal(cut?.kind === 'command' && cut.status, 'failed')
})

test('“狂打日志”：命令一拍一拍地狂打几十 MB，核心和界面这一头留着的始终不过上限，打完定稿再回话', async () => {
  const { channel, time } = setup(20)
  let view: SessionView | null = null
  channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's3' },
    {
      snapshot: (data) => {
        view = structuredClone(data) as SessionView
      },
      delta(ops: SessionOp[]) {
        for (const op of ops) if (view) reduceSession(view, structuredClone(op))
      },
    },
  )
  await settle()
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '狂打日志' })
  const command = () => {
    const found = Object.values((view as SessionView | null)?.items ?? {}).find(
      (item) => item.kind === 'command' && item.command === FLOOD_COMMAND,
    )
    return found?.kind === 'command' ? found : null
  }
  let most = 0
  for (let i = 0; i < 5000 && command()?.status !== 'completed'; i++) {
    time.advance(16)
    await settle()
    const now = command()
    if (now) most = Math.max(most, now.output.length + (now.elided?.tail.length ?? 0))
  }
  const done = command()
  assert.equal(done?.status, 'completed')
  assert.ok(done?.elided, '几十 MB 的输出应当只留头尾')
  assert.ok(most <= OUTPUT_KEEP, `最多留过 ${most} 个字`)
  assert.ok(done.output.startsWith('[0000001] '))
  assert.ok(done.elided.bytes > 20 * 1024 * 1024, `省了 ${done.elided.bytes} 个字节`)
  assert.equal(done.exitCode, 0)
  // 打完照常回话，回合走到结束
  for (
    let i = 0;
    i < 400 && (view as SessionView | null)?.turns.at(-1)?.status === 'running';
    i++
  ) {
    time.advance(20)
    await settle()
  }
  assert.equal((view as SessionView | null)?.turns.at(-1)?.status, 'completed')
})

test('“工具大结果”：两次结果很大的工具调用，到界面这一头的条目只有上限那么大，图片只剩说明，再照常回话', async () => {
  const { channel, time } = setup(20)
  let view: SessionView | null = null
  channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's3' },
    {
      snapshot: (data) => {
        view = structuredClone(data) as SessionView
      },
      delta(ops: SessionOp[]) {
        for (const op of ops) if (view) reduceSession(view, structuredClone(op))
      },
    },
  )
  await settle()
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '工具大结果' })
  const tools = () =>
    Object.values((view as SessionView | null)?.items ?? {}).filter(
      (item) => item.kind === 'toolCall',
    )
  const done = () =>
    tools().length === 2 && (view as SessionView | null)?.turns.at(-1)?.status === 'completed'
  for (let i = 0; i < 400 && !done(); i++) {
    time.advance(50)
    await settle()
  }
  assert.ok(done(), '两次工具调用之后回合照常走到结束')
  const [dump, shots] = tools()
  assert.ok(dump?.kind === 'toolCall' && shots?.kind === 'toolCall', '两次工具调用都在')
  assert.equal(dump.tool, DUMP_TOOL)
  assert.equal(shots.tool, SHOTS_TOOL)
  for (const item of [dump, shots]) {
    assert.equal(item.status, 'completed')
    const size = JSON.stringify(item).length
    assert.ok(size <= 2 * OUTPUT_KEEP, `${String(item.tool)} 的条目有 ${size} 个字`)
    assert.equal(item.output.filter((part) => part.kind === 'gap').length, 1)
  }
  // 导出的头一行、结语都在，那张大图只剩一行说明
  const first = dump.output[0]
  assert.ok(first?.kind === 'text' && first.text.startsWith('[0000001] event #1 '))
  assert.deepEqual(dump.output.slice(-2), [
    { kind: 'blob', type: 'image', mime: 'image/png', bytes: 1536 * 1024, name: null },
    { kind: 'text', text: DUMP_END },
  ])
})

test('“想一会儿”：回合开头、两段输出之间各空等一会儿，这时末尾那一行该出；出字时不出', async () => {
  const { channel, time } = setup(20)
  let view: SessionView | null = null
  channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's3' },
    {
      snapshot: (data) => {
        view = structuredClone(data)
      },
      delta(ops: SessionOp[]) {
        for (const op of ops) if (view) reduceSession(view, structuredClone(op))
      },
    },
  )
  await settle()
  const shown = () => {
    const current = view as SessionView | null
    const turn = current?.turns.at(-1)
    if (!current || !turn) return null
    return workingShown(
      turn.status === 'running',
      turn.itemIds.map((id) => current.items[id]),
      current.requests.length,
    )
  }
  const kinds = () => {
    const current = view as SessionView | null
    return current?.turns.at(-1)?.itemIds.map((id) => current.items[id]?.kind)
  }
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '想一会儿' })
  time.advance(16)
  await settle()
  assert.deepEqual(kinds(), ['userMessage'])
  assert.equal(shown(), true, '等第一个字')
  time.advance(2400)
  await settle()
  assert.deepEqual(kinds(), ['userMessage', 'agentMessage'])
  assert.equal(shown(), true, '说明写完了，下一段还没来')
  time.advance(2400 + 40)
  await settle()
  assert.equal(shown(), false, '回答正在出字')
  for (
    let i = 0;
    i < 400 && (view as SessionView | null)?.turns.at(-1)?.status === 'running';
    i++
  ) {
    time.advance(20)
    await settle()
  }
  assert.equal(shown(), false, '回合结束')
})

test('“推理一会儿”：“正在工作”同一时刻只在一处——空档里在末尾那一行，在想时换到思考所在的汇总行', async () => {
  const { channel, time } = setup(20)
  let view: SessionView | null = null
  channel.subscribe(
    { kind: 'session', deviceId: 'local', sessionId: 's3' },
    {
      snapshot: (data) => {
        view = structuredClone(data)
      },
      delta(ops: SessionOp[]) {
        for (const op of ops) if (view) reduceSession(view, structuredClone(op))
      },
    },
  )
  await settle()
  // 此刻写着“正在工作”的地方：末尾那一行（workingShown），和思考所在的步骤组汇总行（有在想的思考时，
  // 界面的 nowOf 写的是同一句）。思考那一行自己在想的时候不写动词
  const spots = () => {
    const current = view as SessionView | null
    const turn = current?.turns.at(-1)
    if (!current || !turn) return []
    const items = turn.itemIds.map((id) => current.items[id])
    const running = turn.status === 'running'
    const out: string[] = []
    if (workingShown(running, items, current.requests.length)) out.push('末尾')
    if (running && items.some((item) => item?.kind === 'reasoning' && item.status === 'inProgress'))
      out.push('思考')
    return out
  }
  await channel.command('session.send', { deviceId: 'local', sessionId: 's3', text: '推理一会儿' })
  time.advance(16)
  await settle()
  assert.deepEqual(spots(), ['末尾'], '等第一个字')
  time.advance(2400)
  await settle()
  assert.deepEqual(spots(), ['思考'], '思考刚开始，还没出字')
  const seen = new Set<string>()
  for (
    let i = 0;
    i < 800 && (view as SessionView | null)?.turns.at(-1)?.status === 'running';
    i++
  ) {
    const now = spots()
    assert.ok(now.length <= 1, `同一时刻有两处在写：${now.join('、')}`)
    seen.add(now.join('') || '无')
    time.advance(20)
    await settle()
  }
  // 想完了接着出回答：回答出字时哪儿都不写（正文末尾的光标就是）
  assert.ok(seen.has('思考') && seen.has('无'), [...seen].join('、'))
  const thought = Object.values((view as SessionView | null)?.items ?? {}).find(
    (item) => item.kind === 'reasoning',
  )
  assert.equal(thought?.status, 'completed', '想完了留着那一条，能点开看')
  assert.deepEqual(spots(), [], '回合结束')
})
