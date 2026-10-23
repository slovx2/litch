// 按声明来：harness 事先声明了会什么、有哪几档权限预设、认识哪些扩展，核心照着给界面；
// 没有声明的才退回“试了才知道”。另有原生 codex 接进来之后要跟着做的几件事。
// 对着假的聚合面和假对端跑，会话经真的通道订阅（wire.mts 的 watchSession）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import { abilitiesOf } from '../src/device/harness.mjs'
import type { ChannelError, UserMessageItem } from '../src/index.mjs'
import { ALL_ABLE } from '../src/projection/session.mjs'
import { declaredPreset, deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { RpcFailure } from './fake-server.mjs'
import { thread, turn, userText } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'
import { runtimeInfo, setup as single, watch, where } from './world.mjs'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

const said = (id: string) => turn(id, [userText(`${id}-u`, '问')])
const running = () => turn('t1', [userText('u', '装依赖')], { status: 'inProgress' })

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

/**
 * 三个 harness：dsh 声明了不会分叉、回退、压缩；codex 声明都会（实际不认识压缩）、不认识我们的扩展；
 * old 是旧版的适配器，没有声明
 */
const trio = () => [
  harness('dsh', {
    displayName: 'dsh',
    declaration: {
      extensions: [],
      features: features({
        fork: false,
        compact: false,
        revert: { byTurnId: false, byCount: false, restoresFiles: false },
        delete: false,
      }),
    },
    threads: [thread({ id: 'd1', turns: [said('t1')] })],
  }),
  harness('codex', {
    displayName: 'Codex',
    declaration: { extensions: [], features: features() },
    // 声明说会，这个版本却没有这个方法：聚合面替它回“不支持”
    refuses: ['thread/compact/start'],
    threads: [thread({ id: 'x1', turns: [said('t1')] }), thread({ id: 'x2' })],
  }),
  harness('old', {
    displayName: 'Old',
    lacks: ['thread/fork'],
    threads: [thread({ id: 'o1', turns: [said('t1')] })],
  }),
]

test('声明到了界面看得到的地方：harness 上带着它会什么；没有声明的是 null', async () => {
  const { core, device } = deviceWorld(trio())
  core.start()
  await settle()
  const abilities = Object.fromEntries(
    (device()?.harnesses ?? []).map((entry) => [entry.id, entry.abilities]),
  )
  assert.deepEqual(abilities.dsh, {
    fork: false,
    rollback: false,
    rollbackRestoresFiles: false,
    cutInTurn: false,
    compact: false,
    steer: true,
    steerImages: true,
    images: true,
    // 示例里声明的输入种类只有文字和图片：带不了技能
    skills: false,
    mentions: false,
    rename: true,
    archive: true,
    remove: false,
    finalOnStart: false,
    turnDiff: false,
    stopAgent: false,
    backgroundTasks: false,
    goals: false,
  })
  assert.equal(abilities.codex?.fork, true)
  assert.equal(abilities.old, null)
})

test('会话操作按声明来：声明了不会的一上来就是不会，去做也不发；没有声明的照旧试了才知道', async () => {
  const { core, command, sent } = deviceWorld(trio())
  core.start()
  await settle()
  const onDsh = watchSession(core, 'd1')
  const onOld = watchSession(core, 'o1')
  await settle()
  assert.deepEqual(onDsh.seen.view?.can, {
    fork: false,
    rollback: false,
    rollbackRestoresFiles: false,
    cutInTurn: false,
    compact: false,
    steer: true,
    steerImages: true,
    finalOnStart: false,
    backgroundTasks: false,
    goals: false,
    declared: true,
  })
  for (const [name, params] of [
    ['session.fork', { sessionId: 'd1', turnId: 't1' }],
    ['session.rollback', { sessionId: 'd1', turnId: 't1' }],
    ['session.compact', { sessionId: 'd1' }],
  ] as const) {
    await assert.rejects(command(name, params), { code: 'unsupported' }, name)
  }
  assert.deepEqual(
    [sent('thread/fork'), sent('thread/revert'), sent('thread/compact/start')],
    [[], [], []],
    '声明了不会的不去问',
  )

  // 没有声明的：先当它都会，对面说不认识了才记下
  assert.deepEqual(onOld.seen.view?.can, { ...ALL_ABLE })
  await assert.rejects(command('session.fork', { sessionId: 'o1', turnId: 't1' }), {
    code: 'unsupported',
  })
  assert.deepEqual(onOld.seen.view?.can, { ...ALL_ABLE, fork: false })
  assert.equal(sent('thread/fork').length, 1)
})

test('声明说会、对面却说不支持：照实际的来。聚合面替原生 codex 说的“不支持”带着是哪个 harness', async () => {
  const { core, command, sent } = deviceWorld(trio())
  core.start()
  await settle()
  const first = watchSession(core, 'x1')
  const second = watchSession(core, 'x2')
  const other = watchSession(core, 'o1')
  await settle()
  assert.equal(first.seen.view?.can.compact, true)

  await assert.rejects(command('session.compact', { sessionId: 'x1' }), { code: 'unsupported' })
  assert.equal(first.seen.view?.can.compact, false)
  assert.equal(second.seen.view?.can.compact, false, '同一个 harness 上别的会话也知道了')
  assert.equal(other.seen.view?.can.compact, true, '别的 harness 不受连累')
  // 记住了，不再去问
  await assert.rejects(command('session.compact', { sessionId: 'x1' }), { code: 'unsupported' })
  assert.equal(sent('thread/compact/start').length, 1)
  // 声明里别的照旧
  assert.deepEqual([first.seen.view?.can.fork, first.seen.view?.can.declared], [true, true])
})

test('引导按声明来：声明了不会的不发；引导带不了图片时，带图的消息留在队列里等回合结束', async () => {
  const { core, command, sent, peer } = deviceWorld(
    [
      harness('cc', {
        displayName: 'Claude Code',
        // 引导只把文字交给模型，图片到不了
        declaration: { features: features({ steerInputTypes: ['text'] }) },
        threads: [thread({ id: 'c1' })],
      }),
      harness('mute', {
        displayName: 'Mute',
        declaration: { features: features({ steer: false }) },
        threads: [thread({ id: 'm1' })],
      }),
    ],
    {
      extra: {
        'turn/steer': (params) => ({
          turnId: (params as { expectedTurnId: string }).expectedTurnId,
        }),
      },
    },
  )
  core.start()
  await settle()
  const onCc = watchSession(core, 'c1')
  const onMute = watchSession(core, 'm1')
  await settle()
  assert.deepEqual([onCc.seen.view?.can.steer, onCc.seen.view?.can.steerImages], [true, false])
  assert.equal(onMute.seen.view?.can.steer, false)

  await command('session.send', { sessionId: 'c1', text: '一' })
  await command('session.send', {
    sessionId: 'c1',
    text: '带图',
    images: [{ url: PNG, name: 'a.png' }],
  })
  await command('session.send', { sessionId: 'c1', text: '只有字' })
  const [withImage, plain] = onCc.seen.view?.queued ?? []
  assert.ok(withImage && plain)
  const refused = await failureOf(
    command('session.steer', { sessionId: 'c1', messageId: withImage.id }),
  )
  assert.deepEqual([refused.code, refused.text], ['rejected', { key: 'fault.steerImages' }])
  assert.equal(sent('turn/steer').length, 0)
  assert.equal(onCc.seen.view?.queued.length, 2, '消息还排着')
  // 只有字的照常插得进去
  await command('session.steer', { sessionId: 'c1', messageId: plain.id })
  assert.equal(sent('turn/steer').length, 1)

  await command('session.send', { sessionId: 'm1', text: '一' })
  await command('session.send', { sessionId: 'm1', text: '二' })
  const waiting = onMute.seen.view?.queued[0]
  assert.ok(waiting)
  await assert.rejects(command('session.steer', { sessionId: 'm1', messageId: waiting.id }), {
    code: 'unsupported',
  })
  assert.equal(sent('turn/steer').length, 1)
  assert.equal(onMute.seen.view?.queued.length, 1)
  assert.ok(peer.last())
})

test('引导：没有声明的对面说不认识，记成不会，消息放回队首', async () => {
  const { core, command } = single(undefined, {
    'turn/steer': () => {
      throw new RpcFailure(-32601, 'Method not found: turn/steer')
    },
  })
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  assert.equal(session.seen.view?.can.steer, true)
  await command('session.send', { ...where, text: '一' })
  await command('session.send', { ...where, text: '二' })
  const queued = session.seen.view?.queued[0]
  assert.ok(queued)
  await assert.rejects(command('session.steer', { ...where, messageId: queued.id }), {
    code: 'unsupported',
  })
  assert.equal(session.seen.view?.can.steer, false)
  assert.deepEqual(
    session.seen.view?.queued.map((entry) => entry.text),
    ['二'],
  )
})

test('权限预设按声明来：选项是它声明的那几档；选了只发预设的标识，审批策略由对面自己配', async () => {
  const presets = [
    declaredPreset(':read-only', { risk: 'low' }),
    declaredPreset(':danger-full-access', {
      risk: 'high',
      requiresConfirmation: true,
      switchInSession: false,
    }),
  ]
  const { core, command, sent } = deviceWorld([
    harness('cc', {
      displayName: 'Claude Code',
      declaration: { features: features(), permissionPresets: presets },
      threads: [thread({ id: 'c1' })],
    }),
    harness('old', { displayName: 'Old', threads: [thread({ id: 'o1' })] }),
  ])
  core.start()
  await settle()
  const declared = (await command('device.composeOptions', { harness: 'cc' })) as {
    permissions: unknown[]
  }
  assert.deepEqual(declared.permissions, [
    {
      id: ':read-only',
      risk: 'low',
      title: { 'zh-CN': ':read-only 的标题', en: ':read-only title' },
      note: { 'zh-CN': ':read-only 的说明', en: ':read-only note' },
      confirm: false,
      switchable: true,
    },
    {
      id: ':danger-full-access',
      risk: 'high',
      title: { 'zh-CN': ':danger-full-access 的标题', en: ':danger-full-access title' },
      note: { 'zh-CN': ':danger-full-access 的说明', en: ':danger-full-access note' },
      confirm: true,
      switchable: false,
    },
  ])
  // 没有声明的：Codex 协议内置的三档，标题和说明由界面去说
  const builtin = (await command('device.composeOptions', { harness: 'old' })) as {
    permissions: { id: string; title: unknown }[]
  }
  assert.deepEqual(
    builtin.permissions.map((entry) => [entry.id, entry.title]),
    [
      [':read-only', null],
      [':workspace', null],
      [':danger-full-access', null],
    ],
  )

  watchSession(core, 'c1')
  watchSession(core, 'o1')
  await settle()
  const pick = { settings: { permission: ':danger-full-access' } }
  await command('session.configure', { sessionId: 'c1', ...pick })
  await command('session.send', { sessionId: 'c1', text: '一' })
  const onDeclared = sent('turn/start').at(-1)
  assert.equal(onDeclared?.permissions, ':danger-full-access')
  assert.ok(!('approvalPolicy' in (onDeclared ?? {})), '有声明的只发预设的标识')

  await command('session.configure', { sessionId: 'o1', ...pick })
  await command('session.send', { sessionId: 'o1', text: '一' })
  const onBuiltin = sent('turn/start').at(-1)
  assert.deepEqual(
    [onBuiltin?.permissions, onBuiltin?.approvalPolicy],
    [':danger-full-access', 'never'],
    '没有声明的照旧把配套的审批策略一起给',
  )

  // 新建会话时也一样
  await command('session.create', { harness: 'cc', cwd: null, text: '你好', ...pick })
  const started = sent('thread/start').at(-1)
  assert.equal(started?.permissions, ':danger-full-access')
  assert.ok(!('approvalPolicy' in (started ?? {})))
})

test('单个入口也按声明来：适配器的入口在 runtime/info 里报的声明，核心一样认', async () => {
  const { core, command, sent, sidebar } = single(undefined, {
    'runtime/info': () =>
      runtimeInfo({
        displayName: 'Pi 实验版',
        badge: 'PX',
        extensions: [],
        features: features({ fork: false }),
        permissionPresets: [declaredPreset(':danger-full-access', { switchInSession: false })],
      }),
    'thread/start': () => ({ thread: thread({ id: 'new', turns: [] }), model: null }),
  })
  core.start()
  await settle()
  assert.ok(sidebar.view)
  const session = watch(core)
  await settle()
  assert.deepEqual([session.seen.view?.can.fork, session.seen.view?.can.declared], [false, true])
  const options = (await command('device.composeOptions', { deviceId: 'local' })) as {
    permissions: { id: string; switchable: boolean }[]
  }
  assert.deepEqual(
    options.permissions.map((entry) => [entry.id, entry.switchable]),
    [[':danger-full-access', false]],
  )
  await command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '你好',
    settings: { permission: ':danger-full-access' },
  })
  const started = sent('thread/start').at(-1) as Record<string, unknown>
  assert.equal(started.permissions, ':danger-full-access')
  assert.ok(!('approvalPolicy' in started))
})

const commandItem = (id: string): ThreadItem =>
  ({
    type: 'commandExecution',
    id,
    command: 'npm i',
    cwd: '/work/app',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  }) as unknown as ThreadItem

test('拒绝并附说明：同样列了这一项，只有声明了这项扩展的 harness 上才出写说明的入口', async () => {
  const { core, command, peer } = deviceWorld([
    harness('cc', {
      displayName: 'Claude Code',
      declaration: { extensions: ['declineWithNote'], features: features() },
      threads: [thread({ id: 'c1', turns: [running()] })],
    }),
    harness('codex', {
      displayName: 'Codex',
      declaration: { extensions: [], features: features() },
      threads: [thread({ id: 'x1', turns: [running()] })],
    }),
    harness('old', { displayName: 'Old', threads: [thread({ id: 'o1', turns: [running()] })] }),
  ])
  core.start()
  await settle()
  const views = {
    c1: watchSession(core, 'c1'),
    x1: watchSession(core, 'x1'),
    o1: watchSession(core, 'o1'),
  }
  await settle()
  const server = peer.last()
  const ask = (threadId: string, decisions: unknown[]) =>
    server.ask('item/commandExecution/requestApproval', {
      threadId,
      turnId: 't1',
      itemId: 'c',
      command: 'npm i',
      availableDecisions: decisions,
    })
  const optionsOf = (id: keyof typeof views) => {
    const request = views[id].seen.view?.requests.at(-1)
    return request?.kind === 'approval' ? request : null
  }
  const listed = ['accept', 'decline', 'declineWithNote']
  const answers = { c1: ask('c1', listed), x1: ask('x1', listed), o1: ask('o1', listed) }
  await settle()
  assert.deepEqual(optionsOf('c1')?.options, [
    { id: 'accept', role: 'accept' },
    { id: 'decline', role: 'decline', note: true },
  ])
  // 没声明这项扩展的、根本没有声明的：这一项照样并到“拒绝”上，只是不给写说明的入口
  for (const id of ['x1', 'o1'] as const) {
    assert.deepEqual(
      optionsOf(id)?.options,
      [
        { id: 'accept', role: 'accept' },
        { id: 'decline', role: 'decline' },
      ],
      id,
    )
    await assert.rejects(
      command('session.respond', {
        sessionId: id,
        requestId: optionsOf(id)?.id,
        optionId: 'decline',
        note: '为什么不行',
      }),
      { code: 'rejected' },
    )
    await command('session.respond', {
      sessionId: id,
      requestId: optionsOf(id)?.id,
      optionId: 'decline',
    })
    assert.deepEqual(((await answers[id]) as { result: unknown }).result, { decision: 'decline' })
  }
  // 声明了的那个：这一次没列，入口也不出
  await command('session.respond', {
    sessionId: 'c1',
    requestId: optionsOf('c1')?.id,
    optionId: 'decline',
    note: '用现成的',
  })
  assert.deepEqual(((await answers.c1) as { result: unknown }).result, {
    decision: { declineWithNote: { note: '用现成的' } },
  })
  void ask('c1', ['accept', 'decline'])
  await settle()
  assert.deepEqual(optionsOf('c1')?.options, [
    { id: 'accept', role: 'accept' },
    { id: 'decline', role: 'decline' },
  ])
})

/** 单个入口上一个正停在审批上的会话 */
async function approving() {
  const world = single([thread({ id: 'a', turns: [running()] })])
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  const server = world.peer.last()
  const base = { threadId: 'a', turnId: 't1' }
  server.notify('item/started', { ...base, item: commandItem('c1'), startedAtMs: 0 })
  await settle()
  const ask = (decisions: unknown) =>
    server.ask('item/commandExecution/requestApproval', {
      ...base,
      itemId: 'c1',
      command: 'npm i',
      availableDecisions: decisions,
    })
  const pending = () => {
    const request = session.seen.view?.requests.at(-1)
    if (request?.kind !== 'approval') throw new Error('不是审批')
    return request
  }
  return { ...world, ask, pending }
}

test('命令审批里带参数的决定：认得的画成“以后都允许”并写明记下的规则，认不出的不画；答复时原样带回去', async () => {
  const { ask, pending, command } = await approving()
  const byPrefix = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'install'] } }
  const allowHost = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: 'registry.npmjs.org', action: 'allow' },
    },
  }
  const denyHost = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: 'registry.npmjs.org', action: 'deny' },
    },
  }
  const first = ask([
    'accept',
    byPrefix,
    allowHost,
    // 以后都拒绝这个主机：不是“允许”，不画
    denyHost,
    // 这一版不认识的、形状不对的：不能让卡片出不来
    { somethingNew: { level: 3 } },
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: 'npm' } },
    42,
    null,
    'cancel',
  ])
  await settle()
  assert.deepEqual(pending().options, [
    { id: 'accept', role: 'accept' },
    { id: 'always1', role: 'acceptAlways', rule: 'npm install' },
    { id: 'always2', role: 'acceptAlways', rule: 'registry.npmjs.org' },
    { id: 'cancel', role: 'cancel' },
  ])
  await command('session.respond', { ...where, requestId: pending().id, optionId: 'always2' })
  assert.deepEqual(((await first) as { result: unknown }).result, { decision: allowHost })

  const second = ask(['accept', byPrefix])
  await settle()
  await command('session.respond', { ...where, requestId: pending().id, optionId: 'always1' })
  assert.deepEqual(((await second) as { result: unknown }).result, { decision: byPrefix })
})

test('命令审批：列的决定一个都认不出时只给两种拒绝，不替对面编一个“允许”；列表不是数组按没给算', async () => {
  const { ask, pending, command } = await approving()
  const first = ask([{ somethingNew: {} }, 'alsoNew'])
  await settle()
  assert.deepEqual(pending().options, [
    { id: 'decline', role: 'decline' },
    { id: 'cancel', role: 'cancel' },
  ])
  await command('session.respond', { ...where, requestId: pending().id, optionId: 'cancel' })
  assert.deepEqual(((await first) as { result: unknown }).result, { decision: 'cancel' })

  void ask('accept')
  await settle()
  assert.deepEqual(
    pending().options.map((option) => option.id),
    ['accept', 'acceptSession', 'decline', 'cancel'],
  )
})

test('会话列表：一律带 modelProviders 空数组，原生 codex 才不会只列当前供应商的', async () => {
  const world = single()
  world.core.start()
  await settle()
  await world.command('device.loadArchived', { deviceId: 'local' })
  const lists = world.sent('thread/list') as Record<string, unknown>[]
  assert.equal(lists.length, 2)
  for (const params of lists) assert.deepEqual(params.modelProviders, [])

  const full = deviceWorld(trio())
  full.core.start()
  await settle()
  assert.deepEqual(full.sent('thread/list')[0]?.modelProviders, [])
})

test('会话正被别处的 codex 用着：只读地打开并说清楚是怎么回事；归档、删除被拒时给专门的提示', async () => {
  const held = () => {
    throw new RpcFailure(-32600, 'thread a already has an active writer')
  }
  const { core, command, sidebar } = single([thread({ id: 'a', turns: [said('t1')] })], {
    'thread/resume': held,
    'thread/archive': held,
    'thread/delete': held,
  })
  core.start()
  await settle()
  const session = watch(core)
  await settle()
  // 内容照样看得到，只是发不了消息；说明是专门的那一句，不是甩一句原话
  assert.deepEqual(
    [session.seen.view?.live, session.seen.view?.note],
    [false, { key: 'session.heldElsewhere' }],
  )
  assert.equal(session.seen.view?.turns.length, 1)
  for (const name of ['session.archive', 'session.delete']) {
    const refused = await failureOf(command(name, where))
    assert.deepEqual(
      [refused.code, refused.text],
      ['rejected', { key: 'fault.heldElsewhere' }],
      name,
    )
  }
  // 没做成：会话还在侧栏里
  assert.ok(sidebar.view?.sessions.some((entry) => entry.id === 'a'))
  assert.ok(!sidebar.ops.some((op) => op.op === 'session.remove'))
})

test('不可用的种类原样带到界面：认识的说得出是哪一句，这一版不认识的按一般的“不可用”说', async () => {
  const { core, device } = deviceWorld([
    harness('codex', { down: { kind: 'notInstalled', message: '找不到 codex' } }),
    harness('pi', { down: { kind: 'needsLogin', message: '还没登录' } }),
    harness('cc'),
  ])
  core.start()
  await settle()
  assert.deepEqual(
    device()?.harnesses.map((entry) => [entry.id, entry.down, entry.reason, entry.detail]),
    [
      ['codex', 'notInstalled', { key: 'harness.notInstalled' }, '找不到 codex'],
      ['pi', 'needsLogin', { key: 'harness.unavailable' }, '还没登录'],
      ['cc', null, null, null],
    ],
  )
})

test('提到的文件：声明了收 mention 的用 mention 带；原生 codex 的 mention 不是给文件用的，和没有声明的一样把路径写进正文', async () => {
  const withMention = features({ inputTypes: ['text', 'image', 'skill', 'mention'] })
  const { core, command, sent, device } = deviceWorld([
    harness('pi', {
      displayName: 'Pi',
      declaration: { extensions: [], features: withMention },
      threads: [thread({ id: 'p1', turns: [] })],
    }),
    harness('codex', {
      displayName: 'Codex',
      declaration: { extensions: [], features: withMention },
      threads: [thread({ id: 'x1', turns: [] })],
    }),
    harness('old', { displayName: 'Old', threads: [thread({ id: 'o1', turns: [] })] }),
  ])
  core.start()
  await settle()
  assert.deepEqual(
    Object.fromEntries(
      (device()?.harnesses ?? []).map((entry) => [entry.id, entry.abilities?.mentions ?? null]),
    ),
    { pi: true, codex: false, old: null },
  )
  const onPi = watchSession(core, 'p1')
  const onCodex = watchSession(core, 'x1')
  const onOld = watchSession(core, 'o1')
  await settle()
  const extras = [
    { kind: 'file', name: 'app.ts', path: 'src/app.ts' },
    { kind: 'text', name: 'notes.md', text: '# 备忘\n一行' },
    { kind: 'file', name: 'docs', path: '/work/docs' },
  ]
  for (const sessionId of ['p1', 'x1', 'o1']) {
    await command('session.send', { sessionId, text: '看看这两处', extras })
  }
  const inputOf = (threadId: string) =>
    (sent('turn/start') as { threadId: string; input: unknown }[]).find(
      (params) => params.threadId === threadId,
    )?.input
  const first = (seen: typeof onPi.seen) => {
    const view = seen.view
    return view?.items[view.turns[0]?.itemIds[0] ?? ''] as UserMessageItem
  }
  // 有名字的那段文字（一个文件的内容）并进正文时前面有一行名字
  const body = '看看这两处\n\nnotes.md:\n# 备忘\n一行'
  assert.deepEqual(inputOf('p1'), [
    { type: 'text', text: body, text_elements: [] },
    { type: 'mention', name: 'app.ts', path: 'src/app.ts' },
    { type: 'mention', name: 'docs', path: '/work/docs' },
  ])
  assert.equal(first(onPi.seen).text, body)
  assert.deepEqual(first(onPi.seen).attachments, [
    { kind: 'file', label: 'app.ts' },
    { kind: 'file', label: 'docs' },
  ])
  // 路径写进正文：一行一个，排在最后；对话里那条消息就是这一整段，不另画附件
  const spelled = `${body}\n\nsrc/app.ts\n/work/docs`
  for (const [threadId, seen] of [
    ['x1', onCodex.seen],
    ['o1', onOld.seen],
  ] as const) {
    assert.deepEqual(inputOf(threadId), [{ type: 'text', text: spelled, text_elements: [] }])
    assert.equal(first(seen).text, spelled)
    assert.deepEqual(first(seen).attachments, [])
  }
  // 形状不对的不收
  const refused = await failureOf(
    command('session.send', {
      sessionId: 'p1',
      text: '嗯',
      extras: [{ kind: 'file', name: 'app.ts', path: '' }],
    }),
  )
  assert.equal(refused.code, 'rejected')
})

test('回退会不会连文件一起恢复照声明给界面：OpenCode 这样的声明 restoresFiles，别的不算', () => {
  const restores = abilitiesOf(
    features({ revert: { byTurnId: true, byCount: false, restoresFiles: true } }),
    'opencode',
  )
  assert.deepEqual([restores?.rollback, restores?.rollbackRestoresFiles], [true, true])
  assert.equal(abilitiesOf(features(), 'pi')?.rollbackRestoresFiles, false)
  assert.equal(ALL_ABLE.rollbackRestoresFiles, false)
})

test('切在回合中间只认声明：声明了的发 beforeItemId，切口换成协议里的条目标识，回退后照对面重新载入；没声明的不发', async () => {
  const steered = turn('t1', [
    userText('u1', '开头'),
    userText('s1', '插的话'),
    userText('s2', '又插一句'),
  ])
  const { core, command, sent } = deviceWorld([
    harness('claude', {
      displayName: 'Claude Code',
      declaration: {
        extensions: [],
        features: features({
          revert: { byTurnId: true, byCount: true, restoresFiles: false, byItemId: true },
        }),
      },
      threads: [thread({ id: 'c1', turns: [steered] })],
    }),
    harness('pi', {
      displayName: 'Pi',
      declaration: { extensions: [], features: features() },
      threads: [thread({ id: 'p1', turns: [steered] })],
    }),
  ])
  core.start()
  await settle()
  const onClaude = watchSession(core, 'c1')
  const onPi = watchSession(core, 'p1')
  await settle()
  assert.equal(onClaude.seen.view?.can.cutInTurn, true)
  assert.equal(onPi.seen.view?.can.cutInTurn, false)

  await command('session.fork', { sessionId: 'c1', turnId: 't1', itemId: 't1:s2' })
  await command('session.fork', { sessionId: 'c1', turnId: 't1' })
  assert.deepEqual(
    sent('thread/fork').map(({ threadId, lastTurnId, beforeTurnId, beforeItemId }) => ({
      threadId,
      lastTurnId,
      beforeTurnId,
      beforeItemId,
    })),
    [
      { threadId: 'c1', lastTurnId: undefined, beforeTurnId: 't1', beforeItemId: 's2' },
      { threadId: 'c1', lastTurnId: 't1', beforeTurnId: undefined, beforeItemId: undefined },
    ],
  )
  // 回合开头那条不是插进来的话，不能拿来切
  await assert.rejects(
    command('session.rollback', { sessionId: 'c1', turnId: 't1', itemId: 't1:u1' }),
    { code: 'rejected' },
  )
  const reads = sent('thread/resume').length + sent('thread/read').length
  await command('session.rollback', { sessionId: 'c1', turnId: 't1', itemId: 't1:s1' })
  await settle()
  assert.deepEqual(sent('thread/revert'), [
    { threadId: 'c1', beforeTurnId: 't1', beforeItemId: 's1' },
  ])
  assert.ok(sent('thread/resume').length + sent('thread/read').length > reads, '回退后重新载入')

  for (const [name, params] of [
    ['session.fork', { sessionId: 'p1', turnId: 't1', itemId: 't1:s1' }],
    ['session.rollback', { sessionId: 'p1', turnId: 't1', itemId: 't1:s1' }],
  ] as const) {
    await assert.rejects(command(name, params), { code: 'unsupported' }, name)
  }
  assert.equal(sent('thread/revert').length, 1)
  onClaude.close()
  onPi.close()
})
