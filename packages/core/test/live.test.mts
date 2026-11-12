// 打开着的会话：发送、实时更新、排队、打断、审批与提问。对着假对端跑，不连任何真的东西。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EXTENSION,
  formatSessionEvent,
  type JsonRpcMessage,
  type Thread,
  type ThreadItem,
  type Turn,
} from '../../protocol/src/index.mjs'
import {
  type ComposeOptions,
  createCore,
  createPendingInputStore,
  type PendingInputStore,
  type SessionView,
  type SidebarOp,
  type SidebarView,
  shownEffort,
  thoughtShown,
  type UserMessageItem,
} from '../src/index.mjs'
import { emptyReasoning } from './empty-reasoning-fixture.mjs'
import { fakeOpener, type Handler, RpcFailure } from './fake-server.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle, withoutTools } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const never = { aborted: false, addEventListener() {} }
const where = { deviceId: 'local', sessionId: 'a' }

test('真实 Codex 事件形状：空 reasoning 与 compaction 独立投影，空白摘要不显示，后续可读摘要不丢失', async () => {
  const { core, peer, handlers } = setup([
    thread({ id: 'a', turns: [turn('t1', [], { status: 'inProgress' })] }),
  ])
  runtime(handlers, 'codex')
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const base = { threadId: 'a', turnId: 't1' }
  peer.last().notify('item/started', { ...base, item: emptyReasoning, startedAtMs: 1000 })
  await settle()
  const reason = () => {
    const item = session.seen.view?.items[`t1:${emptyReasoning.id}`]
    assert.ok(item)
    return item
  }
  assert.equal(reason()?.kind, 'reasoning')
  assert.equal(thoughtShown(reason()), false)
  peer.last().notify('item/started', {
    ...base,
    item: { type: 'contextCompaction', id: 'compact' },
    startedAtMs: 2000,
  })
  peer.last().notify('item/reasoning/summaryTextDelta', {
    ...base,
    itemId: emptyReasoning.id,
    summaryIndex: 0,
    delta: '\n \t',
  })
  await settle()
  assert.equal(thoughtShown(reason()), false)
  assert.equal(session.seen.view?.items['t1:compact']?.kind, 'compaction')
  peer.last().notify('item/completed', {
    ...base,
    item: emptyReasoning,
    startedAtMs: 1000,
    completedAtMs: 3000,
  })
  await settle()
  assert.equal(thoughtShown(reason()), false)
  // 下一条 reasoning 开始时内容未知，不能因此丢掉它之后的文本增量。
  peer.last().notify('item/started', {
    ...base,
    item: { ...emptyReasoning, id: 'rs_readable' },
    startedAtMs: 4000,
  })
  peer.last().notify('item/reasoning/summaryTextDelta', {
    ...base,
    itemId: 'rs_readable',
    summaryIndex: 0,
    delta: '\n检查星云项目',
  })
  await settle()
  const readable = session.seen.view?.items['t1:rs_readable']
  assert.ok(readable)
  assert.equal(thoughtShown(readable), true)
})

test('未打开的原生子代理提问显示在已打开父会话，父回合完成不误撤回', async () => {
  const parent = thread({ id: 'a', turns: [turn('t1', [], { status: 'inProgress' })] })
  const child = thread({ id: 'child', parentThreadId: 'a', turns: [] })
  const { core, peer, command } = setup([parent, child])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const asked = peer.last().ask('item/tool/requestUserInput', {
    threadId: 'child',
    turnId: 't1',
    itemId: 'child-question',
    questions: [
      {
        id: 'q',
        header: '子任务',
        question: '继续？',
        isOther: true,
        isSecret: false,
        options: null,
      },
    ],
    isBlocking: true,
    autoResolutionMs: null,
  })
  await settle()
  const pending = session.seen.view?.requests[0]
  assert.equal(pending?.kind, 'question')
  assert.ok(pending)
  peer.last().notify('turn/completed', { threadId: 'a', turn: turn('t1', []) })
  await settle()
  assert.equal(session.seen.view?.requests[0]?.id, pending.id)
  await command('session.respond', { ...where, requestId: pending.id, answers: { q: ['继续'] } })
  assert.deepEqual(((await asked) as any).result, { answers: { q: { answers: ['继续'] } } })
})

/** 某个条目的状态；没有这个条目就是 undefined */
const statusOf = (view: SessionView | null, itemId: string): unknown =>
  (view?.items[itemId] as { status?: string } | undefined)?.status

function setup(
  threads: Thread[] = [thread({ id: 'a', turns: [] })],
  pendingInputs?: PendingInputStore,
) {
  const world = {
    threads,
    /** 对面已经归档的会话 */
    archived: [] as Thread[],
    /** turn/start 回什么：给了就抛它 */
    startFailure: null as RpcFailure | null,
    steerFailure: null as RpcFailure | null,
    turnSeq: 0,
    /** thread/turns/list 回的最近一个回合（按会话），每次问都记下参数 */
    lastTurn: {} as Record<string, Turn | null>,
    turnLists: [] as unknown[],
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
      protocolVersion: '0.163.0',
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
    'thread/turns/list': (params) => {
      world.turnLists.push(params)
      const last = world.lastTurn[(params as { threadId: string }).threadId]
      return { data: last ? [last] : [], nextCursor: null }
    },
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
    ...(pendingInputs
      ? {
          store: {
            load: () => ({ localWire: null, remotes: [] }),
            save() {},
            forget() {},
            snapshot: () => ({ load: () => null, save() {} }),
            pendingInputs: () => pendingInputs,
          },
        }
      : {}),
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
  return { core, world, peer, time, sidebar, command, sent, logs, handlers }
}

/** 订阅一个会话，并像界面那样把增量落到快照上。经真的通道，见 wire.mts */
const watch = watchSession

function runtime(handlers: Record<string, Handler>, engine: string) {
  handlers['runtime/info'] = () => {
    if (engine === 'codex') throw new RpcFailure(-32601, 'Method not found')
    return {
      engine: engine === 'claude' ? 'claude-code' : engine,
      protocolVersion: '0.163.0',
      capabilities: [],
      extensions: engine === 'claude' ? [EXTENSION.inputDelivery] : [],
      features: { steer: true, inputTypes: ['text', 'image'], steerInputTypes: ['text', 'image'] },
    }
  }
}

for (const engine of ['claude', 'codex', 'pi']) {
  test(`${engine} 的实时与回合补齐文字统一按阶段来源投影`, async () => {
    const { core, handlers, peer } = setup()
    runtime(handlers, engine)
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    const expected = engine === 'codex' ? 'commentary' : 'unknown'
    const phase = (id: string) => {
      const item = session.seen.view?.items[id]
      return item?.kind === 'agentMessage' ? item.phase : undefined
    }
    peer.last().notify('turn/started', {
      threadId: 'a',
      turn: turn('current', [], { status: 'inProgress' }),
    })
    peer.last().notify('item/completed', {
      threadId: 'a',
      turnId: 'current',
      item: agentText('live', '实时结论', 'commentary'),
    })
    await settle()
    assert.equal(phase('current:live'), expected)
    peer.last().notify('turn/completed', {
      threadId: 'a',
      turn: turn('current', [agentText('late', '结束补齐的结论', 'commentary')]),
    })
    await settle()
    assert.equal(phase('current:late'), expected)
    // 新回合直接带完整条目时也经过同一投影。
    peer.last().notify('turn/started', {
      threadId: 'a',
      turn: turn('new', [agentText('start', '开始时的文字', 'commentary')], {
        status: 'inProgress',
      }),
    })
    await settle()
    assert.equal(phase('new:start'), expected)
    core.stop()
  })

  test(`立即停止 ${engine}：首条应答未到时冻结后排，取得回合号后停止`, async () => {
    const { core, handlers, command, sent, peer } = setup()
    runtime(handlers, engine)
    let release!: () => void
    handlers['turn/start'] = () =>
      new Promise((done) => {
        release = () => done({ turn: started('slow') })
      })
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    assert.equal(session.seen.view?.harness, engine)
    const first = command('session.send', { ...where, text: '第一条' })
    await settle()
    const second = command('session.send', { ...where, text: '第二条', now: true })
    const stopping = command('session.interrupt', where).then(
      () => null,
      (error) => error,
    )
    await settle()
    release()
    await first
    await second
    assert.equal(await stopping, null, '停止不能因为 turn/start 尚未应答而被拒绝')
    assert.deepEqual(sent('turn/interrupt'), [{ threadId: 'a', turnId: 'slow' }])
    peer.last().notify('turn/completed', {
      threadId: 'a',
      turn: finished('slow', { status: 'interrupted' }),
    })
    await settle()
    assert.deepEqual(session.texts(), [['第一条']])
    assert.deepEqual(
      session.seen.view?.queued.map(({ text, delivery }) => [text, delivery]),
      [['第二条', 'held']],
    )
    assert.equal(sent('turn/start').length, 1)
    core.stop()
  })

  for (const phase of ['first', 'queue', 'steer', 'echo', 'reject'] as const) {
    test(`停止保留 ${engine}/${phase}：原文和附件只保留一份，不自动续发`, async () => {
      const { core, handlers, peer, command, sent } = setup()
      runtime(handlers, engine)
      let finish!: (value: unknown) => void
      let reject!: (error: unknown) => void
      handlers['turn/steer'] = () =>
        new Promise((resolve, fail) => {
          finish = resolve
          reject = fail
        })
      core.start()
      await settle()
      const session = watch(core)
      await settle()
      await command('session.send', { ...where, text: '首条' })
      const base = { threadId: 'a', turnId: 'srv-1' }
      peer
        .last()
        .notify('item/completed', { ...base, item: userText('first', '首条'), completedAtMs: 0 })
      await settle()
      let sending: Promise<unknown> | undefined
      if (phase !== 'first') {
        sending = command('session.send', {
          ...where,
          text: '不能丢的原文',
          images: [{ url: PNG, name: '图片' }],
          now: phase !== 'queue',
        })
        await settle()
      }
      const steer = sent('turn/steer')[0] as { clientUserMessageId: string } | undefined
      if (phase === 'echo') {
        assert.ok(steer)
        peer.last().notify('item/completed', {
          ...base,
          completedAtMs: 0,
          item: {
            ...userText('echo', '不能丢的原文'),
            clientId: steer.clientUserMessageId,
            ...(engine === 'claude' ? { litchInputDelivery: 'sent' } : {}),
          },
        })
        await settle()
      }
      await command('session.interrupt', where)
      peer.last().notify('turn/completed', {
        threadId: 'a',
        turn: finished('srv-1', { status: 'interrupted' }),
      })
      await settle()
      if (steer) {
        if (phase === 'reject') reject(new RpcFailure(-32600, 'turn interrupted'))
        else finish({ turnId: 'srv-1' })
      }
      await sending
      await settle()
      const view = session.seen.view
      assert.ok(view)
      assert.equal(sent('turn/start').length, 1)
      assert.equal(view.turns.at(-1)?.status, 'interrupted')
      if (phase === 'first') assert.deepEqual(session.texts(), [['首条']])
      else if (phase === 'echo') {
        assert.deepEqual(session.texts(), [['首条', '不能丢的原文']])
        assert.deepEqual(view.queued, [])
      } else {
        assert.equal(view.queued.length, 1)
        assert.equal(view.queued[0]?.text, '不能丢的原文')
        assert.deepEqual(view.queued[0]?.images, [{ url: PNG, name: '图片' }])
        assert.equal(
          view.queued[0]?.delivery,
          engine === 'claude' && phase !== 'queue' ? 'unknown' : 'held',
        )
      }
      core.stop()
    })
  }
}

for (const ending of ['failed', 'completed', 'notified'] as const) {
  test(`开始期间停止：${ending} 不遗留等待、不误停后续回合`, async () => {
    const { core, handlers, peer, command, sent } = setup()
    let complete!: () => void
    handlers['turn/start'] = () =>
      new Promise((resolve, reject) => {
        complete = () =>
          ending === 'failed'
            ? reject(new RpcFailure(-32603, 'start failed'))
            : resolve({ turn: ending === 'completed' ? finished('first') : started('first') })
      })
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    const sending = command('session.send', { ...where, text: '保存原文' }).catch(
      (error: unknown) => error,
    )
    await settle()
    const stopping = command('session.interrupt', where)
    await settle()
    if (ending === 'notified') {
      peer.last().notify('turn/started', { threadId: 'a', turn: started('first') })
      await settle()
      assert.equal(sent('turn/interrupt').length, 1, '通知到达即可停止，不必等开始 RPC 回应')
    }
    complete()
    await sending
    await stopping
    await settle()
    assert.equal(sent('turn/interrupt').length, ending === 'notified' ? 1 : 0)
    assert.equal(session.seen.view?.turns.length, ending === 'failed' ? 0 : 1)
    core.stop()
  })
}

test('重连撞上设备恢复：保持可写视图，输入先排队，订阅恢复后只发送一次', async () => {
  const { core, peer, time, handlers, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  assert.equal(session.seen.view?.live, true)
  const resume = handlers['thread/resume']
  assert.ok(resume)
  let attempts = 0
  handlers['thread/resume'] = (params) => {
    if (++attempts <= 2)
      throw new RpcFailure(-32051, 'temporary recovery gate', { litch: 'sessionRecovering' })
    return resume(params)
  }
  peer.last().drop()
  await settle()
  time.advance(500)
  await settle()
  await settle()
  assert.equal(attempts, 1)
  assert.equal(session.seen.view?.live, true, '恢复期间不能退成只读')
  assert.deepEqual(session.seen.errors, [])
  await command('session.send', { ...where, text: '恢复期间发送的原文' })
  assert.equal(sent('turn/start').length, 0)
  time.advance(250)
  await settle()
  assert.equal(attempts, 2)
  time.advance(500)
  await settle()
  await settle()
  assert.equal(attempts, 3)
  assert.equal(session.seen.view?.live, true)
  assert.deepEqual(session.seen.errors, [])
  assert.equal(sent('thread/read').length, 0, '暂态错误不触发只读回退')
  assert.deepEqual(
    sent('turn/start').map((params) => (params as { input: { text: string }[] }).input[0]?.text),
    ['恢复期间发送的原文'],
  )
  core.stop()
})

test('恢复订阅有限重试：持续繁忙报载入失败，不生成只读快照', async () => {
  const { core, time, handlers, sent } = setup()
  let attempts = 0
  handlers['thread/resume'] = () => {
    attempts++
    throw new RpcFailure(-32051, 'busy', { litch: 'sessionRecovering' })
  }
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  for (const delay of [250, 500, 1000, 2000, 4000, 8000]) {
    assert.equal(session.seen.snapshots, 0)
    assert.deepEqual(session.seen.errors, [])
    time.advance(delay)
    await settle()
  }
  assert.equal(attempts, 7)
  assert.equal(session.seen.snapshots, 0)
  assert.equal(session.seen.errors.length, 1)
  assert.equal(sent('thread/read').length, 0)
  time.advance(60_000)
  await settle()
  assert.equal(attempts, 7)
  core.stop()
})

test('恢复订阅退避中关闭核心，不再向已关闭的连接重试', async () => {
  const { core, time, handlers } = setup()
  let attempts = 0
  handlers['thread/resume'] = () => {
    attempts++
    throw new RpcFailure(-32051, 'busy', { litch: 'sessionRecovering' })
  }
  core.start()
  await settle()
  watch(core)
  await settle()
  core.stop()
  assert.equal(time.pending(), 0, '关闭时清掉恢复退避定时器')
  time.advance(60_000)
  await settle()
  assert.equal(attempts, 1)
})

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

test('发送提到会话的消息：当前会话没带 litch_sessions 时替模型读那个会话，附上最后一个回合的摘录', async () => {
  const other = thread({
    id: 'b',
    turns: [
      ...Array.from({ length: 120 }, (_, i) =>
        turn(`old-${i}`, [agentText(`old-item-${i}`, 'x'.repeat(1024 * 1024))]),
      ),
      turn('t-b', [userText('ub', '构建为什么慢'), agentText('ab', '因为没开缓存')]),
    ],
  })
  const { core, command, sent, world, handlers } = setup([thread({ id: 'a', turns: [] }), other])
  world.lastTurn.b = other.turns.at(-1) ?? null
  const originalRead = handlers['thread/read']!
  handlers['thread/read'] = (params) => {
    const request = params as { threadId: string; includeTurns?: boolean }
    if (request.threadId === 'b') {
      assert.equal(request.includeTurns, false, '超过100MiB的会话摘录不整读')
      return { thread: { ...other, turns: [] } }
    }
    return originalRead(params)
  }
  core.start()
  await settle()
  watch(core)
  await settle()
  await command('session.send', {
    ...where,
    text: '参考 @[构建]',
    extras: [{ kind: 'session', threadId: 'b', title: '构建' }],
  })
  await settle()
  const [params] = sent('turn/start') as { input: { text: string }[] }[]
  const text = params?.input[0]?.text ?? ''
  assert.ok(text.startsWith('参考 ＠[构建]\n\n<litch-session-mentions>\n'))
  assert.match(text, /You cannot open these sessions/)
  assert.ok(
    sent('thread/turns/list').some(
      (params) =>
        (params as { threadId: string; limit: number }).threadId === 'b' &&
        (params as { limit: number }).limit === 1,
    ),
  )
  assert.match(text, /<session index="1" thread_id="b" title="构建" harness="[^"]+"/)
  assert.match(
    text,
    /<last-input>构建为什么慢<\/last-input>\n<last-answer>因为没开缓存<\/last-answer>/,
  )
})

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
  assert.equal(sent('thread/read').length, 0, '正常完成和出队不额外重读整段历史')
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

test('打断没打开过的会话（后台任务页上停一个子会话）：问对面最近的回合，在跑就打断它', async () => {
  const { core, world, command, sent } = setup([
    thread({ id: 'a', turns: [] }),
    thread({ id: 'b', turns: [] }),
  ])
  world.lastTurn.b = turn('srv-9', [], { status: 'inProgress' })
  core.start()
  await settle()
  await command('session.interrupt', { deviceId: 'local', sessionId: 'b' })
  assert.deepEqual(sent('turn/interrupt'), [{ threadId: 'b', turnId: 'srv-9' }])
  assert.deepEqual(world.turnLists[0], {
    threadId: 'b',
    limit: 1,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  })
  // 最近的回合已经结束、或者一个回合都没有：照打开着的一样报“做不了”
  world.lastTurn.b = turn('srv-9', [], { status: 'completed' })
  await assert.rejects(command('session.interrupt', { deviceId: 'local', sessionId: 'b' }), {
    code: 'rejected',
  })
  world.lastTurn.b = null
  await assert.rejects(command('session.interrupt', { deviceId: 'local', sessionId: 'b' }), {
    code: 'rejected',
  })
  assert.equal(sent('turn/interrupt').length, 1)
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
  // 子会话/后台事件开的别的回合不能清掉仍在等的 RPC；题目仍按原 requestId 答给 harness。
  server.notify('turn/started', { threadId: 'a', turn: turn('wake', [], { status: 'inProgress' }) })
  server.notify('turn/completed', { threadId: 'a', turn: finished('wake') })
  await settle()
  assert.equal(session.seen.view?.requests[0]?.id, request.id)
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
  server.notify('turn/started', {
    threadId: 'a',
    turn: turn('report', [], { status: 'inProgress' }),
  })
  server.notify('turn/completed', { threadId: 'a', turn: finished('report') })
  await settle()
  assert.equal(session.seen.view?.requests.length, 1, '其他回合结束不撤销审批')
  server.notify('turn/completed', { threadId: 'a', turn: finished('t1') })
  await settle()
  assert.deepEqual(session.seen.view?.requests, [])
})

test('界面关掉会话：回合还在跑就留着订阅，跑完了再留一阵才退订；期间跑完的会话标成未读', async () => {
  const { core, peer, time, sidebar, command, sent } = setup()
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
  assert.deepEqual(sent('thread/unsubscribe'), [])
  time.advance(10 * 60_000)
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
  assert.deepEqual(withoutTools(sent('thread/start')), [{ cwd: '/work/app', model: 'gate/plain' }])
  // 这台桌面什么工具都执行不了：只带呈现风格
  assert.deepEqual(
    (sent('thread/start')[0] as { dynamicTools?: { name: string }[] }).dynamicTools?.map(
      (spec) => spec.name,
    ),
    ['litch_browser', 'litch_presentation'],
  )
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
  assert.deepEqual(withoutTools(sent('thread/start')), [{ cwd: null }])
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
  assert.deepEqual(withoutTools(sent('thread/start')), [{ cwd: '/work/app' }])
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

test('可选项：隐藏的模型不列（只留名字），没有强度档的模型强度是空的；一次连接只问一遍', async () => {
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
  // 隐藏的只留名字：会话还用着它时底栏照样显示成名字
  assert.deepEqual(options.hiddenTitles, { 'gate/secret': 'GATE/SECRET' })
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
  // 先显示出来、对面还没回显的插话标着 unconfirmed：没有对面的标识，界面上不出回退、分叉
  const steerKey = session.seen.view?.turns[0]?.itemIds[1] ?? ''
  const shown = () => session.seen.view?.items[steerKey] as UserMessageItem | undefined
  assert.equal(shown()?.unconfirmed, true)

  // 对面把这句话当成一个条目发回来（开始、完成各一次）：还是那两条，标记没了
  const echo = { ...userText('u9', '二'), clientId: steer.clientUserMessageId }
  const base = { threadId: 'a', turnId: 'srv-1' }
  peer.last().notify('item/started', { ...base, item: echo, startedAtMs: 0 })
  peer.last().notify('item/completed', { ...base, item: echo, completedAtMs: 0 })
  await settle()
  assert.deepEqual(session.texts(), [['一', '二']])
  assert.equal(shown()?.unconfirmed, undefined)

  // 对面报回合不一致：先核实；还不能确认终态时原文回到队首并暂停。
  world.steerFailure = new RpcFailure(-32009, '指定回合与活动回合不一致')
  await command('session.steer', { ...where, messageId: third.id })
  assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
  assert.deepEqual(session.seen.view?.note, { key: 'session.steerHeld' })
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['三'],
  )
  assert.deepEqual(session.texts(), [['一', '二']])
})

test('回报插话：设备进程插进回合的子会话回报画在插进去的位置，是“子会话的回报”，不是用户的话、不是别的会话发来的', async () => {
  const { core, peer, command } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  const base = { threadId: 'a', turnId: 'srv-1' }
  peer.last().notify('item/completed', { ...base, item: userText('u1', '一'), completedAtMs: 0 })
  const answer = { type: 'agentMessage', id: 'a1', text: '先看看', phase: null }
  peer.last().notify('item/completed', { ...base, item: answer, completedAtMs: 0 })
  const text = formatSessionEvent({
    kind: 'notes',
    notes: [{ threadId: 'c1', title: '三号客户端', status: 'completed', excerpt: '上线了' }],
  })
  const steered = { ...userText('s1', text), clientId: 'litch-sessions-mz1abc-1' }
  peer.last().notify('item/started', { ...base, item: steered, startedAtMs: 0 })
  peer.last().notify('item/completed', { ...base, item: steered, completedAtMs: 0 })
  await settle()
  const view = session.seen.view
  const ids = view?.turns[0]?.itemIds ?? []
  assert.equal(ids.length, 3, '用户的话、回答、回报各一条')
  const note = view?.items[ids[2] ?? ''] as UserMessageItem | undefined
  assert.equal(note?.kind, 'userMessage')
  assert.equal(note?.text, '', '没有用户自己的话')
  assert.equal(note?.peer, undefined)
  assert.equal(note?.unconfirmed, undefined)
  assert.deepEqual(note?.event?.kind, 'notes')
  assert.deepEqual(
    note?.event?.notes.map((one) => [one.threadId, one.status, one.excerpt]),
    [['c1', 'completed', '上线了']],
  )
})

test('立即发送：消息号每次运行都不一样（入口按消息号永久记账，重启后不能撞上以前用过的）；没插成写一句、照常排着', async () => {
  const ids: string[] = []
  for (let run = 0; run < 2; run++) {
    const { core, command, sent } = setup()
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    await command('session.send', { ...where, text: '一' })
    await command('session.send', { ...where, text: '二', now: true })
    const steer = sent('turn/steer')[0] as { clientUserMessageId: string }
    assert.match(steer.clientUserMessageId, /^litch-local-[0-9a-z]+-\d+$/)
    ids.push(steer.clientUserMessageId)
    session.close()
  }
  assert.notEqual(ids[0], ids[1], '两次运行同样的操作，消息号也不能一样')

  const { core, world, command } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '一' })
  world.steerFailure = new RpcFailure(-32009, '消息 ID 已被不同内容使用')
  await command('session.send', { ...where, text: '二', now: true })
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['二'],
  )
  assert.deepEqual(session.seen.view?.note, {
    key: 'session.steerQueued',
    args: { message: '消息 ID 已被不同内容使用' },
  })
})

test('排队：上一条还在发（turn/start 没回）时接连再发两条，不吞、不另起回合，按发的先后排进托盘', async () => {
  const { core, handlers, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  const start = handlers['turn/start'] as Handler
  let release = () => {}
  handlers['turn/start'] = (params) =>
    new Promise((done) => {
      release = () => done(start(params))
    })
  const first = command('session.send', { ...where, text: '一' })
  await settle()
  // 界面上不等上一条发完：两条紧接着发出去
  const rest = [
    command('session.send', { ...where, text: '二' }),
    command('session.send', { ...where, text: '三' }),
  ]
  release()
  await first
  await Promise.all(rest)
  await settle()
  assert.equal(sent('turn/start').length, 1, '没有另起回合')
  assert.deepEqual(
    session.seen.view?.queued.map((message) => message.text),
    ['二', '三'],
  )
  assert.deepEqual(session.texts(), [['一']])
})

test('立即发送：回合刚发出时保留待发，等回合有了对面的标识再插进去，不另起回合', async () => {
  const { core, handlers, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  // 慢机器：turn/start 的应答迟迟不到，界面上已经是一个进行中的本地回合
  const start = handlers['turn/start'] as Handler
  let release = () => {}
  handlers['turn/start'] = (params) =>
    new Promise((done) => {
      release = () => done(start(params))
    })
  const first = command('session.send', { ...where, text: '一' })
  await settle()
  assert.equal(session.seen.view?.turns.at(-1)?.status, 'running')
  const second = command('session.send', { ...where, text: '二', now: true })
  await settle()
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['二'],
    '等对面标识的时候保留待发原文',
  )
  release()
  await first
  await second
  await settle()
  const steer = sent('turn/steer') as { expectedTurnId: string; input: { text: string }[] }[]
  assert.equal(steer.length, 1)
  assert.equal(steer[0]?.expectedTurnId, 'srv-1')
  assert.equal(steer[0]?.input[0]?.text, '二')
  assert.equal(sent('turn/start').length, 1, '没有另起回合')
  assert.deepEqual(session.seen.view?.queued ?? [], [])
  assert.deepEqual(session.texts(), [['一', '二']])
  assert.equal(session.seen.view?.note ?? null, null)
})

test('历史回合残留 running：新回合完成后读取权威历史，不再向旧回合插话', async () => {
  const { core, world, peer, command, sent } = setup([
    thread({ id: 'a', turns: [started('ghost')] }),
  ])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  world.threads[0] = thread({
    id: 'a',
    status: { type: 'idle' },
    turns: [finished('ghost', { status: 'interrupted' }), finished('latest')],
  })
  peer.last().notify('turn/started', { threadId: 'a', turn: started('latest') })
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('latest') })
  peer.last().notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
  await settle()
  await settle()
  assert.ok(session.seen.view?.turns.every((entry) => entry.status !== 'running'))
  await command('session.send', { ...where, text: '继续工作', now: true })
  assert.equal(sent('turn/steer').length, 0)
  assert.equal(sent('turn/start').length, 1)
})

test('插话明确拒绝 no active turn：核实已完成后原文只作为一个新回合发送', async () => {
  const { core, world, command, sent } = setup([thread({ id: 'a', turns: [started('ghost')] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  world.threads[0] = thread({ id: 'a', status: { type: 'idle' }, turns: [finished('ghost')] })
  world.steerFailure = new RpcFailure(-32600, 'no active turn to steer')
  await command('session.send', { ...where, text: '不能丢失的原文', now: true })
  await settle()
  assert.equal(sent('turn/steer').length, 1)
  assert.equal(sent('thread/read').length, 1)
  assert.equal(sent('turn/start').length, 1)
  assert.equal(session.seen.view?.queued.length, 0)
  assert.deepEqual(session.texts().at(-1), ['不能丢失的原文'])
  assert.equal(session.seen.view?.note, null)
})

for (const message of ['指定回合与当前活动回合不一致', '指定回合与活动回合不一致']) {
  test(`插话回合不一致：${message} 后核实终态，原文只发送一次`, async () => {
    const { core, world, command, sent } = setup([thread({ id: 'a', turns: [started('ghost')] })])
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    world.threads[0] = thread({ id: 'a', status: { type: 'idle' }, turns: [finished('ghost')] })
    world.steerFailure = new RpcFailure(-32009, message)
    await command('session.send', { ...where, text: '核实后再发', now: true })
    await settle()
    assert.equal(sent('thread/read').length, 1)
    assert.equal(sent('turn/start').length, 1)
    assert.equal(session.seen.view?.queued.length, 0)
    assert.deepEqual(session.texts().at(-1), ['核实后再发'])
  })
}

for (const interruptedBy of ['通知', '超时'] as const) {
  test(`停止后的回合核实遇到${interruptedBy}：手动恢复待发先重查，不被旧回合永久挡住`, async () => {
    const { core, world, handlers, peer, command, sent, time, logs } = setup([
      thread({ id: 'a', turns: [started('ghost'), started('current')] }),
    ])
    runtime(handlers, 'claude')
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    await command('session.send', { ...where, text: '同步工具期间的插话', now: true })
    const { clientUserMessageId } = sent('turn/steer')[0] as { clientUserMessageId: string }
    const input = {
      ...userText('steered', '同步工具期间的插话'),
      clientId: clientUserMessageId,
      litchInputDelivery: 'queued',
    }
    peer.last().notify('item/completed', { threadId: 'a', turnId: 'current', item: input })
    await settle()
    const reads: (() => void)[] = []
    let delay = true
    handlers['thread/read'] = () =>
      delay
        ? new Promise((resolve) => reads.push(() => resolve({ thread: world.threads[0] })))
        : { thread: world.threads[0] }
    await command('session.interrupt', where)
    peer.last().notify('item/completed', {
      threadId: 'a',
      turnId: 'current',
      item: { ...input, litchInputDelivery: 'held' },
    })
    world.threads[0] = thread({
      id: 'a',
      status: { type: 'idle' },
      turns: [finished('ghost'), finished('current', { status: 'interrupted' })],
    })
    peer.last().notify('turn/completed', {
      threadId: 'a',
      turn: finished('current', { status: 'interrupted' }),
    })
    peer.last().notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
    await settle()
    assert.ok(reads.length > 0)
    // 本次事故是全量历史超过 5 秒；新通知让快照作废也必须保留重查机会。
    if (interruptedBy === '超时') time.advance(5001)
    else
      peer.last().notify('litch/turn/recovery/changed', {
        threadId: 'a',
        turnId: 'current',
        recovery: null,
      })
    await settle()
    if (interruptedBy === '超时') assert.ok(logs.some((line) => line.includes('5000 毫秒内未响应')))
    for (const release of reads) release()
    await settle()
    assert.equal(sent('turn/start').length, 0, '停止后不自动重发')
    delay = false
    await command('session.resumeQueue', where)
    await settle()
    assert.equal(sent('turn/start').length, 1)
    assert.deepEqual(session.texts().at(-1), ['同步工具期间的插话'])
  })
}

test('上一回合的 idle 晚于下一回合开始：下一回合明确结束后继续排队', async () => {
  const { core, handlers, peer, command, sent } = setup([
    thread({ id: 'a', turns: [started('first')] }),
  ])
  let release!: () => void
  handlers['turn/start'] = () =>
    new Promise((done) => {
      release = () => done({ turn: started('second') })
    })
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '第二条' })
  await command('session.send', { ...where, text: '第三条' })
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('first') })
  await settle()
  assert.equal(sent('turn/start').length, 1)
  // 第一轮的 idle 到来时，第二轮的 turn/start 仍未应答。
  peer.last().notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
  await settle()
  release()
  await settle()
  handlers['turn/start'] = () => ({ turn: started('third') })
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('second') })
  await settle()
  assert.equal(sent('turn/start').length, 2, '明确终态不能仍被旧 idle 的核实标记阻塞')
  assert.equal(session.seen.view?.queued.length, 0)
  assert.deepEqual(session.texts().at(-1), ['第三条'])
})

for (const status of ['completed', 'interrupted'] as const) {
  test(`只收到 idle 广播：读取真实结局 ${status}，正常完成出队，停止仍须手动发送`, async () => {
    const { core, world, peer, command, sent } = setup([
      thread({ id: 'a', turns: [started('ghost')] }),
    ])
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    await command('session.send', { ...where, text: '排队原文' })
    world.threads[0] = thread({
      id: 'a',
      status: { type: 'idle' },
      turns: [finished('ghost', { status })],
    })
    peer.last().notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
    await settle()
    await settle()
    assert.equal(session.seen.view?.turns[0]?.status, status)
    if (status === 'interrupted') {
      assert.equal(sent('turn/start').length, 0)
      assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
      await command('session.resumeQueue', where)
      await settle()
    }
    assert.equal(sent('turn/start').length, 1)
    assert.deepEqual(session.texts().at(-1), ['排队原文'])
  })
}

test('no active turn 核实失败：保留原文和图片，恢复发送先重查再只发一次', async () => {
  const { core, world, handlers, command, sent } = setup([
    thread({ id: 'a', turns: [started('ghost')] }),
  ])
  const read = handlers['thread/read']
  assert.ok(read)
  let unavailable = true
  handlers['thread/read'] = (params) => {
    if (unavailable) throw new RpcFailure(-32603, 'read unavailable')
    return read(params)
  }
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  world.steerFailure = new RpcFailure(-32600, 'no active turn to steer')
  const images = [{ name: '保留.png', url: 'data:image/png;base64,aGVsbG8=' }]
  await command('session.send', { ...where, text: '保留原文', images, now: true })
  assert.equal(sent('turn/start').length, 0)
  assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
  assert.deepEqual(session.seen.view?.queued[0]?.images, images)
  assert.deepEqual(session.seen.view?.note, { key: 'session.steerHeld' })
  await assert.rejects(command('session.resumeQueue', where), { code: 'rejected' })
  assert.equal(sent('turn/start').length, 0, '核实仍失败不能解除暂停')
  unavailable = false
  world.threads[0] = thread({ id: 'a', status: { type: 'idle' }, turns: [finished('ghost')] })
  await command('session.resumeQueue', where)
  await settle()
  assert.equal(sent('turn/start').length, 1)
  assert.equal(session.seen.view?.queued.length, 0)
  assert.deepEqual(session.texts().at(-1), ['保留原文'])
  assert.match(JSON.stringify(sent('turn/start')), /data:image\/png;base64,aGVsbG8=/)
})

test('no active turn 被拒后另一回合已开始：补出新回合，原消息暂停而不重复开回合', async () => {
  const { core, world, command, sent } = setup([thread({ id: 'a', turns: [started('ghost')] })])
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  world.steerFailure = new RpcFailure(-32600, 'no active turn to steer')
  world.threads[0] = thread({
    id: 'a',
    status: { type: 'active', activeFlags: [] },
    turns: [finished('ghost'), started('newest')],
  })
  await command('session.send', { ...where, text: '保留到明确恢复', now: true })
  assert.equal(sent('turn/start').length, 0)
  assert.equal(session.seen.view?.turns.at(-1)?.id, 'newest')
  assert.equal(session.seen.view?.turns.at(-1)?.status, 'running')
  assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
  await command('session.resumeQueue', where)
  assert.equal(sent('turn/start').length, 0)
})

for (const during of ['stop', 'new-turn', 'remove'] as const) {
  test(`no active turn 对账期间 ${during}：旧读数不得自动重发或覆盖新回合`, async () => {
    const { core, world, handlers, peer, command, sent } = setup([
      thread({ id: 'a', turns: [started('ghost')] }),
    ])
    let finish!: (value: unknown) => void
    handlers['thread/read'] = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    world.steerFailure = new RpcFailure(-32600, 'no active turn to steer')
    const sending = command('session.send', { ...where, text: '等核实的原文', now: true })
    for (let tick = 0; tick < 10 && !finish; tick++) await settle()
    assert.ok(finish)
    if (during === 'stop') await command('session.interrupt', where)
    else if (during === 'new-turn') {
      peer.last().notify('turn/started', { threadId: 'a', turn: started('newest') })
      await settle()
    } else
      await command('session.unqueue', { ...where, messageId: session.seen.view?.queued[0]?.id })
    finish({ thread: thread({ id: 'a', status: { type: 'idle' }, turns: [finished('ghost')] }) })
    await sending
    await settle()
    assert.equal(sent('turn/start').length, 0)
    if (during === 'remove') assert.equal(session.seen.view?.queued.length, 0)
    else assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
    if (during === 'new-turn') assert.equal(session.seen.view?.turns.at(-1)?.status, 'running')
    if (during === 'stop') {
      await command('session.resumeQueue', where)
      await settle()
      assert.equal(sent('turn/start').length, 1, '只有显式恢复才解除停止的暂停')
    }
  })
}

for (const action of ['session.send', 'session.resumeQueue'] as const) {
  test(`no active turn 暂停后 ${action} 重查途中再次停止：不得解除新的暂停`, async () => {
    const { core, world, handlers, command, sent } = setup([
      thread({ id: 'a', turns: [started('ghost')] }),
    ])
    let blocked = true
    let finish!: (value: unknown) => void
    handlers['thread/read'] = () => {
      if (blocked) throw new RpcFailure(-32603, 'read unavailable')
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    core.start()
    await settle()
    const session = watch(core)
    await settle()
    world.steerFailure = new RpcFailure(-32600, 'no active turn to steer')
    await command('session.send', { ...where, text: '第一条', now: true })
    assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
    blocked = false
    const retrying = command(action, {
      ...where,
      ...(action === 'session.send' ? { text: '第二条' } : {}),
    })
    for (let tick = 0; tick < 10 && !finish; tick++) await settle()
    assert.ok(finish)
    await command('session.interrupt', where)
    finish({ thread: thread({ id: 'a', status: { type: 'idle' }, turns: [finished('ghost')] }) })
    if (action === 'session.resumeQueue') await assert.rejects(retrying, { code: 'rejected' })
    else await retrying
    await settle()
    assert.equal(sent('turn/start').length, 0)
    assert.deepEqual(
      session.seen.view?.queued.map((entry) => [entry.text, entry.delivery]),
      action === 'session.send'
        ? [
            ['第一条', 'held'],
            ['第二条', 'held'],
          ]
        : [['第一条', 'held']],
    )
    await command('session.resumeQueue', where)
    await settle()
    assert.equal(sent('turn/start').length, 1)
  })
}

test('引导：被打断且未回显的消息保留待发，不自动开始下一回合', async () => {
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
  assert.deepEqual(session.texts(), [['一']])
  assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
  assert.deepEqual(
    sent('turn/start').map((params) => (params as { input: { text: string }[] }).input[0]?.text),
    ['一'],
  )
  await command('session.resumeQueue', where)
  await settle()
  assert.deepEqual(session.texts(), [['一'], ['二']])
})

test('停止先冻结发送泵：即使竞态收到正常完成，也不启动已排队消息', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '长命令' })
  await command('session.send', { ...where, text: '已排队' })
  await command('session.interrupt', where)
  assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-1') })
  await settle()
  assert.equal(sent('turn/start').length, 1)
})

test('交付：明确取消才待发，未知不自动重发；新消息可选择不带待发', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '长命令' })
  for (const text of ['明确取消', '状态不明'])
    await command('session.send', { ...where, text, now: true })
  const steers = sent('turn/steer') as { clientUserMessageId: string; input: { text: string }[] }[]
  for (const [index, status] of ['held', 'unknown'].entries()) {
    const steer = steers[index]!
    const item = {
      ...userText(`input-${index}`, steer.input[0]!.text),
      clientId: steer.clientUserMessageId,
      litchInputDelivery: status,
    }
    peer.last().notify('item/completed', { threadId: 'a', turnId: 'srv-1', item, completedAtMs: 0 })
  }
  peer
    .last()
    .notify('turn/completed', { threadId: 'a', turn: finished('srv-1', { status: 'interrupted' }) })
  await settle()
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.delivery),
    ['held', 'unknown'],
  )
  assert.equal(sent('turn/start').length, 1)
  await command('session.send', { ...where, text: '只发这条', pending: 'only' })
  await settle()
  assert.equal((sent('turn/start')[1] as { input: { text: string }[] }).input[0]?.text, '只发这条')
  assert.equal(session.seen.view?.queued.length, 2)
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-2') })
  await settle()
  assert.equal(sent('turn/start').length, 2)
  await command('session.send', { ...where, text: '继续', pending: 'include' })
  await settle()
  assert.equal((sent('turn/start')[2] as { input: { text: string }[] }).input[0]?.text, '明确取消')
  peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-3') })
  await settle()
  assert.equal((sent('turn/start')[3] as { input: { text: string }[] }).input[0]?.text, '继续')
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['状态不明'],
  )
})

test('交付：queued 回显不算已发送，中断没有取消回执时保留待确认', async () => {
  const { core, peer, command, sent } = setup()
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  await command('session.send', { ...where, text: '长命令' })
  await command('session.send', { ...where, text: '插话', now: true })
  const steer = sent('turn/steer')[0] as { clientUserMessageId: string }
  peer.last().notify('item/completed', {
    threadId: 'a',
    turnId: 'srv-1',
    item: {
      ...userText('pending', '插话'),
      clientId: steer.clientUserMessageId,
      litchInputDelivery: 'queued',
    },
    completedAtMs: 0,
  })
  await settle()
  await command('session.send', { ...where, text: '后排消息' })
  await command('session.interrupt', where)
  peer
    .last()
    .notify('turn/completed', { threadId: 'a', turn: finished('srv-1', { status: 'interrupted' }) })
  await settle()
  assert.equal(sent('turn/start').length, 1)
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => [entry.text, entry.delivery]),
    [
      ['插话', 'unknown'],
      ['后排消息', 'held'],
    ],
  )
  await command('session.resumeQueue', { ...where, messageId: session.seen.view?.queued[0]?.id })
  await settle()
  assert.equal(sent('turn/start').length, 1)
  // 迟来的明确接纳回执只对账，不再让用户发送第二遍。
  peer.last().notify('item/completed', {
    threadId: 'a',
    turnId: 'srv-1',
    item: {
      ...userText('pending', '插话'),
      clientId: steer.clientUserMessageId,
      litchInputDelivery: 'sent',
    },
    completedAtMs: 0,
  })
  await settle()
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['后排消息'],
  )
})

test('交付：重启后按原生历史对账，取消消息保留附件待发，已接纳消息不重发', async () => {
  let raw: unknown = null
  const file = {
    read: () => raw,
    write: (value: unknown) => {
      raw = structuredClone(value)
    },
  }
  const first = setup(undefined, createPendingInputStore(file))
  first.core.start()
  await settle()
  watch(first.core)
  await settle()
  await first.command('session.send', { ...where, text: '长命令' })
  for (const text of ['甲', '乙'])
    await first.command('session.send', {
      ...where,
      text,
      now: true,
      images: [{ url: PNG, name: '保留.png' }],
    })
  const ids = (first.sent('turn/steer') as { clientUserMessageId: string }[]).map(
    (entry) => entry.clientUserMessageId,
  )
  const history = thread({
    id: 'a',
    turns: [
      turn('srv-1', [
        Object.assign(userText('a', '甲'), { clientId: ids[0], litchInputDelivery: 'held' }),
        Object.assign(userText('b', '乙'), { clientId: ids[1], litchInputDelivery: 'sent' }),
      ] as ThreadItem[]),
    ],
  })
  const reopened = setup([history], createPendingInputStore(file))
  reopened.core.start()
  await settle()
  const session = watch(reopened.core)
  await settle()
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => [entry.text, entry.delivery]),
    [['甲', 'held']],
  )
  assert.deepEqual(session.seen.view?.queued[0]?.images, [{ url: PNG, name: '保留.png' }])
  assert.equal(reopened.sent('turn/start').length, 0)
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
  assert.equal(sent('turn/start').length, 1)
  assert.deepEqual(session.seen.view?.queued[0]?.images, [{ url: PNG, name: 'a.png' }])
  await command('session.resumeQueue', where)
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

// 普通打开会话（包括重启后恢复），不是专门的父界面路径：重放请求可能比 resume 快照先到。
test('打开已有待答会话：resume 应答之前重放的问题不失败，快照到达后仍能回答', async () => {
  const env = setup([thread({ id: 'a', turns: [started('t1')] })])
  const original = env.handlers['thread/resume']
  assert.ok(original)
  let release: (() => void) | undefined
  let answered = false
  let response: Promise<JsonRpcMessage> | undefined
  env.handlers['thread/resume'] = (params) => {
    const result = original(params)
    response = env.peer
      .last()
      .ask('item/tool/requestUserInput', {
        threadId: 'a',
        turnId: 't1',
        itemId: 'q1',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: 'q',
            header: '范围',
            question: '改哪些目录？',
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      })
      .then((value) => {
        answered = true
        return value
      })
    return new Promise((resolve) => {
      release = () => resolve(result)
    })
  }
  env.core.start()
  await settle()
  const session = watch(env.core)
  await settle()
  assert.equal(answered, false, '历史没载入不能回“客户端不处理”让真实请求失败')
  assert.ok(release)
  release()
  await settle()
  const request = session.seen.view?.requests[0]
  assert.equal(request?.kind, 'question')
  assert.ok(request)
  await env.command('session.respond', {
    ...where,
    requestId: request.id,
    answers: { q: ['只改 src'] },
  })
  assert.deepEqual(((await response) as { result: unknown }).result, {
    answers: { q: { answers: ['只改 src'] } },
  })
  env.core.stop()
})

test('载入期间重放的审批已在别处解决：历史到达后不留下失效卡片，也不重复答复', async () => {
  const env = setup([thread({ id: 'a', turns: [started('t1')] })])
  const original = env.handlers['thread/resume']
  assert.ok(original)
  let release: (() => void) | undefined
  let answered = false
  env.handlers['thread/resume'] = (params) => {
    const result = original(params)
    void env.peer
      .last()
      .ask(
        'item/commandExecution/requestApproval',
        {
          threadId: 'a',
          turnId: 't1',
          itemId: 'cmd',
          command: 'echo check',
        },
        'replayed',
      )
      .then(() => {
        answered = true
      })
    env.peer.last().notify('serverRequest/resolved', { threadId: 'a', requestId: 'replayed' })
    return new Promise((resolve) => {
      release = () => resolve(result)
    })
  }
  env.core.start()
  await settle()
  const session = watch(env.core)
  await settle()
  assert.ok(release)
  release()
  await settle()
  assert.deepEqual(session.seen.view?.requests, [])
  assert.equal(answered, false)
  env.core.stop()
})

/** 使用真实 core 和协议替身模拟 Claude 的 queued→held，不走立即确认的 mock-core。 */
async function pendingDeliveryCase() {
  let raw: unknown = null
  const file = {
    read: () => raw,
    write: (value: unknown) => {
      raw = structuredClone(value)
    },
  }
  const store = createPendingInputStore(file)
  const env = setup(undefined, store)
  runtime(env.handlers, 'claude')
  env.core.start()
  await settle()
  const session = watch(env.core)
  await settle()
  await env.command('session.send', { ...where, text: '阻塞工具' })
  const receipts: ThreadItem[] = []
  const send = async (text: string, images: { url: string; name: string }[] = []) => {
    await env.command('session.send', { ...where, text, images, now: true })
    const request = env.sent('turn/steer').at(-1) as {
      clientUserMessageId: string
      input: unknown[]
    }
    const item = {
      ...userText(`native-${receipts.length}`, text),
      clientId: request.clientUserMessageId,
      litchInputDelivery: 'queued',
    }
    receipts.push(item)
    env.peer.last().notify('item/completed', { threadId: 'a', turnId: 'srv-1', item })
    await settle()
    return item
  }
  const receipt = async (index: number, delivery: string) => {
    const item = { ...receipts[index]!, litchInputDelivery: delivery }
    receipts[index] = item as ThreadItem
    env.peer.last().notify('item/completed', { threadId: 'a', turnId: 'srv-1', item })
    await settle()
  }
  const stop = async () => {
    await env.command('session.interrupt', where)
    env.peer.last().notify('turn/completed', {
      threadId: 'a',
      turn: finished('srv-1', { status: 'interrupted' }),
    })
    await settle()
  }
  const users = () =>
    Object.values(session.seen.view!.items).filter((item) => item.kind === 'userMessage')
  return { ...env, file, store, session, send, receipt, stop, users, receipts }
}

test('唯一输入：同文两条和图片按身份撤回，迟到重复通知不复活；重启与无恢复材料的另一端不同', async () => {
  const env = await pendingDeliveryCase()
  await env.send('同文')
  await env.send('同文')
  await env.send('图文', [{ url: PNG, name: '保留.png' }])
  assert.equal(env.users().filter((item) => item.text === '同文').length, 2)
  await env.stop()
  for (let i = 0; i < 3; i++) await env.receipt(i, 'held')
  assert.deepEqual(
    env.users().map((item) => item.text),
    ['阻塞工具'],
  )
  assert.deepEqual(
    env.session.seen.view!.queued.map((item) => item.text),
    ['同文', '同文', '图文'],
  )
  assert.deepEqual(env.session.seen.view!.queued[2]!.images, [{ url: PNG, name: '保留.png' }])
  await env.receipt(0, 'queued')
  await env.receipt(0, 'held')
  assert.equal(env.users().length, 1)
  assert.equal(env.session.seen.view!.queued.length, 3)
  const history = thread({ id: 'a', turns: [turn('srv-1', env.receipts)] })
  const restored = setup([history], createPendingInputStore(env.file))
  restored.core.start()
  await settle()
  const reopened = watch(restored.core)
  await settle()
  assert.equal(
    Object.values(reopened.seen.view!.items).filter((item) => item.kind === 'userMessage').length,
    0,
  )
  assert.equal(reopened.seen.view!.queued.length, 3)
  assert.equal(restored.sent('turn/start').length, 0)
  // 没有来源和恢复材料时，不能把远端 held 或同文普通消息猜成已恢复。
  const stranger = setup([history])
  stranger.core.start()
  await settle()
  const other = watch(stranger.core)
  await settle()
  assert.equal(
    Object.values(other.seen.view!.items).filter((item) => item.kind === 'userMessage').length,
    3,
  )
})

test('唯一输入：重发失败回到同一记录，新尝试独立；成功后历史重读不恢复旧气泡', async () => {
  const env = await pendingDeliveryCase()
  await env.send('待发', [{ url: PNG, name: '原图' }])
  await env.stop()
  await env.receipt(0, 'held')
  const original = env.session.seen.view!.queued[0]!
  env.world.startFailure = new RpcFailure(-32000, '明确拒绝本次提交')
  await env.command('session.resumeQueue', { ...where, messageId: original.id })
  await settle()
  assert.equal(env.session.seen.view!.queued[0]!.id, original.id)
  assert.deepEqual(env.session.seen.view!.queued[0]!.images, original.images)
  assert.deepEqual(
    env.users().map((item) => item.text),
    ['阻塞工具'],
  )
  env.world.startFailure = null
  await env.command('session.resumeQueue', { ...where, messageId: original.id })
  await settle()
  const attempt = env.sent('turn/start').at(-1) as { clientUserMessageId: string }
  const failed = env.sent('turn/start').at(-2) as { clientUserMessageId: string }
  assert.notEqual(attempt.clientUserMessageId, failed.clientUserMessageId)
  assert.notEqual(attempt.clientUserMessageId, original.clientId)
  const item = { ...userText('new-native', '待发'), clientId: attempt.clientUserMessageId }
  env.peer.last().notify('item/completed', { threadId: 'a', turnId: 'srv-2', item })
  await settle()
  await env.receipt(0, 'held')
  assert.equal(env.users().filter((entry) => entry.text === '待发').length, 1)
  assert.equal(env.session.seen.view!.queued.length, 0)
  const history = thread({ id: 'a', turns: [turn('srv-1', env.receipts), turn('srv-2', [item])] })
  const restarted = setup([history], createPendingInputStore(env.file))
  restarted.core.start()
  await settle()
  const session = watch(restarted.core)
  await settle()
  assert.deepEqual(
    Object.values(session.seen.view!.items)
      .filter((entry) => entry.kind === 'userMessage')
      .map((entry) => entry.text),
    ['待发'],
  )
  assert.equal(session.seen.view!.queued.length, 0)
})

test('唯一输入：未知不自动重发，已接纳消息不因迟到取消退回；主发送仍默认先待发再草稿', async () => {
  const env = await pendingDeliveryCase()
  await env.send('已接纳')
  await env.receipt(0, 'sent')
  await env.send('未知')
  await env.send('待发')
  await env.stop()
  await env.receipt(0, 'held')
  await env.receipt(2, 'held')
  assert.deepEqual(
    env.session.seen.view!.queued.map((entry) => [entry.text, entry.delivery]),
    [
      ['未知', 'unknown'],
      ['待发', 'held'],
    ],
  )
  assert.equal(env.users().filter((entry) => entry.text === '已接纳').length, 1)
  await env.command('session.send', { ...where, text: '草稿', pending: 'include' })
  await settle()
  assert.equal(
    (env.sent('turn/start').at(-1) as { input: { text: string }[] }).input[0]!.text,
    '待发',
  )
  env.peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-2') })
  await settle()
  assert.equal(
    (env.sent('turn/start').at(-1) as { input: { text: string }[] }).input[0]!.text,
    '草稿',
  )
  assert.deepEqual(
    env.session.seen.view!.queued.map((entry) => entry.text),
    ['未知'],
  )
})

test('唯一输入：待发持久写失败保留原气泡，写成功后才移动到托盘', async () => {
  const env = await pendingDeliveryCase()
  await env.send('不能丢')
  const save = env.store.save
  env.store.save = () => {
    throw new Error('磁盘已满')
  }
  await env.stop()
  await env.receipt(0, 'held')
  assert.equal(env.users().filter((entry) => entry.text === '不能丢').length, 1)
  env.store.save = save
  await env.receipt(0, 'held')
  assert.equal(env.users().filter((entry) => entry.text === '不能丢').length, 0)
  assert.equal(createPendingInputStore(env.file).load('a')[0]!.text, '不能丢')
  const pendingId = env.session.seen.view!.queued[0]!.id
  env.store.save = () => {
    throw new Error('新尝试无法落盘')
  }
  await env.command('session.resumeQueue', where)
  await settle()
  assert.equal(env.sent('turn/start').length, 1)
  assert.equal(env.session.seen.view!.queued[0]!.id, pendingId)
  assert.equal(env.session.seen.view!.queued[0]!.delivery, 'held')
})

test('唯一输入：单发不释放其余待发，全发按原顺序且同文不去重；切走回来仍唯一', async () => {
  const env = await pendingDeliveryCase()
  await env.send('同文')
  await env.send('同文')
  await env.send('图文', [{ url: PNG, name: '保留.png' }])
  await env.stop()
  for (let index = 0; index < 3; index++) await env.receipt(index, 'held')
  const single = env.session.seen.view!.queued[1]!
  await env.command('session.resumeQueue', { ...where, messageId: single.id })
  await settle()
  assert.equal(env.session.seen.view!.queued.length, 2)
  assert.ok(env.session.seen.view!.queued.every((entry) => entry.delivery === 'held'))
  env.peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-2') })
  await settle()
  assert.equal(env.sent('turn/start').length, 2)
  await env.command('session.resumeQueue', where)
  await settle()
  env.peer.last().notify('turn/completed', { threadId: 'a', turn: finished('srv-3') })
  await settle()
  const requests = env.sent('turn/start').slice(1) as {
    input: { type: string; text?: string; url?: string }[]
  }[]
  assert.deepEqual(
    requests.map((request) => request.input[0]!.text),
    ['同文', '同文', '图文'],
  )
  assert.equal(requests[2]!.input[1]!.url, PNG)
  assert.equal(env.users().filter((entry) => entry.text === '同文').length, 2)
  assert.equal(env.users().filter((entry) => entry.text === '图文').length, 1)
  env.session.close()
  const again = watch(env.core)
  await settle()
  assert.equal(
    Object.values(again.seen.view!.items).filter(
      (entry) => entry.kind === 'userMessage' && entry.text === '同文',
    ).length,
    2,
  )
})

test('唯一输入：重发应答未到时保存新尝试，旧回执不确认它；重启用新尝试的历史对账', async () => {
  const env = await pendingDeliveryCase()
  await env.send('重试中的原文')
  await env.stop()
  await env.receipt(0, 'held')
  env.handlers['turn/start'] = () => undefined
  await env.command('session.resumeQueue', where)
  await settle()
  const attempt = env.sent('turn/start').at(-1) as { clientUserMessageId: string }
  assert.ok(attempt.clientUserMessageId)
  await env.receipt(0, 'held')
  const inFlight = createPendingInputStore(env.file).load('a')
  assert.equal(inFlight.length, 1)
  assert.equal(inFlight[0]!.clientId, attempt.clientUserMessageId)
  assert.equal(inFlight[0]!.delivery, 'unknown')
  const history = thread({
    id: 'a',
    turns: [
      turn('srv-1', env.receipts),
      turn('srv-2', [
        Object.assign(userText('accepted-attempt', '重试中的原文'), {
          clientId: attempt.clientUserMessageId,
        }),
      ]),
    ],
  })
  const restarted = setup([history], createPendingInputStore(env.file))
  restarted.core.start()
  await settle()
  const view = watch(restarted.core)
  await settle()
  assert.equal(view.seen.view!.queued.length, 0)
  assert.equal(
    Object.values(view.seen.view!.items).filter((entry) => entry.kind === 'userMessage').length,
    1,
  )
  assert.equal(restarted.sent('turn/start').length, 0)
})

test('唯一输入：取消请求失败保留原文为待确认，不隐藏、不自动恢复', async () => {
  const env = await pendingDeliveryCase()
  await env.send('取消结果未知')
  env.handlers['turn/interrupt'] = () => {
    throw new RpcFailure(-32000, '取消失败')
  }
  await assert.rejects(env.command('session.interrupt', where))
  assert.equal(env.users().filter((entry) => entry.text === '取消结果未知').length, 1)
  assert.equal(env.session.seen.view!.queued[0]!.delivery, 'unknown')
  await env.command('session.resumeQueue', where)
  await settle()
  assert.equal(env.sent('turn/start').length, 1)
})

test('唯一输入：无精确回执 harness 的本地暂停不登记原生撤回，迟到标准接纳仍可对账', async () => {
  let raw: unknown = null
  const file = {
    read: () => raw,
    write: (value: unknown) => {
      raw = structuredClone(value)
    },
  }
  const inputs = createPendingInputStore(file)
  const env = setup(undefined, inputs)
  env.core.start()
  await settle()
  const session = watch(env.core)
  await settle()
  await env.command('session.send', { ...where, text: '首条' })
  env.peer
    .last()
    .notify('item/completed', { threadId: 'a', turnId: 'srv-1', item: userText('initial', '首条') })
  await settle()
  await env.command('session.send', { ...where, text: '插话', now: true })
  const attempt = env.sent('turn/steer')[0] as { clientUserMessageId: string }
  await env.command('session.interrupt', where)
  env.peer
    .last()
    .notify('turn/completed', { threadId: 'a', turn: finished('srv-1', { status: 'interrupted' }) })
  await settle()
  assert.equal(session.seen.view!.queued[0]!.delivery, 'held')
  assert.deepEqual(inputs.withdrawn('a'), [])
  env.peer.last().notify('item/completed', {
    threadId: 'a',
    turnId: 'srv-1',
    item: { ...userText('accepted', '插话'), clientId: attempt.clientUserMessageId },
  })
  await settle()
  assert.equal(session.seen.view!.queued.length, 0)
  assert.equal(
    Object.values(session.seen.view!.items).filter(
      (entry) => entry.kind === 'userMessage' && entry.text === '插话',
    ).length,
    1,
  )
})

test('I-304 重连同步窗口保留立即插队意图，不等当前长回合结束', async () => {
  const env = setup([thread({ id: 'a', turns: [started('remote-running')] })])
  runtime(env.handlers, 'claude')
  env.core.start()
  await settle()
  const session = watch(env.core)
  await settle()
  const resume = env.handlers['thread/resume']
  assert.ok(resume)
  let release!: (value: unknown) => void
  env.handlers['thread/resume'] = () =>
    new Promise((resolve) => {
      release = resolve
    })
  env.peer.last().drop()
  await settle()
  env.time.advance(500)
  await settle()
  assert.ok(release)
  await env.command('session.send', { ...where, text: '前台恢复时插队', now: true })
  assert.equal(env.sent('turn/steer').length, 0, '旧快照不能作为插话目标')
  assert.equal(session.seen.view?.queued.length, 1)
  release(await resume({ threadId: 'a' }))
  await settle()
  await settle()
  assert.equal(env.sent('turn/steer').length, 1, '同步后应补发插队请求')
  assert.equal(env.sent('turn/start').length, 0, '仍在跑，不能另开回合')
  env.core.stop()
})

test('I-304 活动回合中的待发点击发送应真正插话，不只是改成排队', async () => {
  const env = await pendingDeliveryCase()
  await env.send('被挂起的消息')
  await env.receipt(0, 'held')
  const queued = env.session.seen.view?.queued[0]
  assert.ok(queued)
  assert.equal(queued.delivery, 'held')
  const before = env.sent('turn/steer').length
  await env.command('session.resumeQueue', { ...where, messageId: queued.id })
  await settle()
  assert.equal(env.sent('turn/steer').length, before + 1)
  env.core.stop()
})

for (const state of ['still-running', 'completed', 'remove', 'stop'] as const) {
  test(`I-304 前台重同步期间手动发送：${state}，只采用新回合状态`, async () => {
    const env = setup([thread({ id: 'a', turns: [started('before')] })])
    runtime(env.handlers, 'claude')
    env.core.start()
    await settle()
    const session = watch(env.core)
    await settle()
    await env.command('session.send', { ...where, text: '托盘里的消息' })
    const id = session.seen.view?.queued[0]?.id
    assert.ok(id)
    const resume = env.handlers['thread/resume']
    assert.ok(resume)
    let release!: (value: unknown) => void
    env.handlers['thread/resume'] = () =>
      new Promise((resolve) => {
        release = resolve
      })
    env.peer.last().drop()
    await settle()
    env.time.advance(500)
    await settle()
    await env.command('session.steer', { ...where, messageId: id })
    assert.equal(env.sent('turn/steer').length, 0)
    assert.deepEqual(session.seen.view?.note, { key: 'session.inputSyncing' })
    if (state === 'remove') await env.command('session.unqueue', { ...where, messageId: id })
    if (state === 'stop') await env.command('session.interrupt', where)
    env.world.threads[0] = thread({
      id: 'a',
      turns: [finished('before'), ...(state === 'completed' ? [] : [started('after')])],
    })
    release(await resume({ threadId: 'a' }))
    await settle()
    await settle()
    assert.equal(env.sent('turn/steer').length, state === 'still-running' ? 1 : 0)
    assert.equal(env.sent('turn/start').length, state === 'completed' ? 1 : 0)
    if (state === 'still-running')
      assert.equal(
        (env.sent('turn/steer')[0] as { expectedTurnId: string }).expectedTurnId,
        'after',
      )
    if (state === 'stop') assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
    env.core.stop()
  })
}

test('I-304 有待发时新发插队消息不再绕过 now；不含待发时其余消息仍保留', async () => {
  const env = await pendingDeliveryCase()
  await env.send('仍待发')
  await env.receipt(0, 'held')
  const before = env.sent('turn/steer').length
  await env.command('session.send', { ...where, text: '只插这条', now: true, pending: 'only' })
  assert.equal(env.sent('turn/steer').length, before + 1)
  assert.equal(env.session.seen.view?.queued[0]?.text, '仍待发')
  assert.equal(env.session.seen.view?.queued[0]?.delivery, 'held')
  env.core.stop()
})

test('压缩期间立即发送正常待发；手动压缩回合结束后只开一个新回合', async () => {
  const env = setup([
    thread({
      id: 'a',
      turns: [
        turn('compact', [{ type: 'contextCompaction', id: 'c' } as ThreadItem], {
          status: 'inProgress',
        }),
      ],
    }),
  ])
  runtime(env.handlers, 'claude')
  env.core.start()
  await settle()
  const session = watch(env.core)
  await settle()
  await env.command('session.send', { ...where, text: '压缩时输入', now: true })
  assert.equal(env.sent('turn/steer').length, 0)
  assert.equal(session.seen.view?.note, null)
  env.peer.last().notify('turn/completed', { threadId: 'a', turn: finished('compact') })
  await settle()
  assert.equal(env.sent('turn/start').length, 1)
  env.core.stop()
})

for (const engine of ['claude', 'codex', 'pi', 'opencode', 'dsh', 'acp'])
  test(`${engine} 自动压缩完成后恢复插话，不等整个回合结束且不重复`, async () => {
    const compact = { type: 'contextCompaction', id: 'c' } as ThreadItem
    const env = setup([thread({ id: 'a', turns: [turn('working', [], { status: 'inProgress' })] })])
    runtime(env.handlers, engine)
    env.core.start()
    await settle()
    const session = watch(env.core)
    await settle()
    env.peer.last().notify('item/started', { threadId: 'a', turnId: 'working', item: compact })
    await settle()
    await env.command('session.send', { ...where, text: '压缩时插话', now: true })
    assert.equal(env.sent('turn/steer').length, 0)
    env.peer.last().notify('item/completed', { threadId: 'a', turnId: 'working', item: compact })
    await settle()
    assert.equal(env.sent('turn/steer').length, 1)
    assert.equal(session.seen.view?.note, null)
    assert.equal(env.sent('turn/start').length, 0)
    assert.equal(session.seen.view?.queued.length, 0)
    env.peer.last().notify('item/completed', { threadId: 'a', turnId: 'working', item: compact })
    await settle()
    assert.equal(env.sent('turn/steer').length, 1)
    env.core.stop()
  })

test('插话请求与压缩开始竞态：明确未受理时静默等待完成，不丢失意图', async () => {
  const compact = { type: 'contextCompaction', id: 'c' } as ThreadItem
  const env = setup([thread({ id: 'a', turns: [turn('working', [], { status: 'inProgress' })] })])
  runtime(env.handlers, 'claude')
  env.core.start()
  await settle()
  const session = watch(env.core)
  await settle()
  env.handlers['turn/steer'] = () => {
    env.peer.last().notify('item/started', { threadId: 'a', turnId: 'working', item: compact })
    throw new RpcFailure(-32009, '正在压缩上下文，请等待压缩结束后发送')
  }
  await env.command('session.send', { ...where, text: '压缩前一刻插话', now: true })
  assert.equal(session.seen.view?.note, null)
  assert.equal(session.seen.view?.queued.length, 1)
  env.handlers['turn/steer'] = () => ({ turnId: 'working' })
  env.peer.last().notify('item/completed', { threadId: 'a', turnId: 'working', item: compact })
  await settle()
  assert.equal(env.sent('turn/steer').length, 2)
  assert.equal(session.seen.view?.queued.length, 0)
  env.core.stop()
})

test('明确选择排队的消息不因压缩完成而插话，整个回合结束后自动发出', async () => {
  const compact = { type: 'contextCompaction', id: 'c' } as ThreadItem
  const env = setup([thread({ id: 'a', turns: [turn('working', [], { status: 'inProgress' })] })])
  runtime(env.handlers, 'claude')
  env.core.start()
  await settle()
  watch(env.core)
  await settle()
  env.peer.last().notify('item/started', { threadId: 'a', turnId: 'working', item: compact })
  await settle()
  await env.command('session.send', { ...where, text: '下一回合处理' })
  env.peer.last().notify('item/completed', { threadId: 'a', turnId: 'working', item: compact })
  await settle()
  assert.equal(env.sent('turn/steer').length, 0)
  env.peer.last().notify('turn/completed', { threadId: 'a', turn: finished('working') })
  await settle()
  assert.equal(env.sent('turn/start').length, 1)
  env.core.stop()
})
