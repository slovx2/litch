// 计划模式：会不会怎么问、模式怎么跟着回合发出去、对面自己改了怎么跟上、“执行计划”发的是什么。
// 对着假对端和假的聚合面跑，会话经真的通道订阅。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ChannelError,
  type ComposeOptions,
  createMockCore,
  type PlanItem,
  type QuestionRequest,
  type SessionView,
} from '../src/index.mjs'
import { deviceWorld } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { RpcFailure } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock, settle, withoutTools } from './helpers.mjs'
import { watchSession } from './wire.mjs'
import { setup, watch, where } from './world.mjs'

const never = { aborted: false, addEventListener() {} }

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

const modes = (...list: string[]) => ({
  data: list.map((mode) => ({ name: mode, mode, model: null, reasoning_effort: null })),
})

/** 订阅会话时对面报的设置：模型、强度、现在是哪种模式 */
const resumed = (mode: string | null) => (params: unknown) => ({
  thread: thread({ id: (params as { threadId: string }).threadId, turns: [] }),
  model: 'gate/small',
  reasoningEffort: 'low',
  ...(mode ? { collaborationMode: { mode, settings: { model: 'gate/small' } } } : {}),
})

type Sent = { collaborationMode?: unknown; clientUserMessageId?: string; input?: unknown }

test('会不会计划模式：看协作模式清单里有没有 plan；对面不认识、没问成都当不会', async () => {
  const ask = async (handler: (() => unknown) | null) => {
    const world = setup(undefined, handler ? { 'collaborationMode/list': handler } : {})
    world.core.start()
    await settle()
    const options = (await world.command('device.composeOptions', {
      deviceId: 'local',
    })) as ComposeOptions
    return { plan: options.plan, sent: world.sent('collaborationMode/list') }
  }
  const able = await ask(() => modes('default', 'plan'))
  assert.equal(able.plan, true)
  // 单个入口上不带 harness
  assert.deepEqual(able.sent, [{}])
  assert.equal((await ask(() => modes('default'))).plan, false)
  // 假对端默认没有这个方法
  assert.equal((await ask(null)).plan, false)
  assert.equal(
    (
      await ask(() => {
        throw new RpcFailure(-32603, '内部错误')
      })
    ).plan,
    false,
  )
})

test('会不会计划模式：聚合面上各 harness 各问各的', async () => {
  const asked: unknown[] = []
  const world = deviceWorld([harness('cc'), harness('plain')], {
    extra: {
      'collaborationMode/list': (params) => {
        asked.push(params)
        return (params as { harness?: string }).harness === 'cc'
          ? modes('default', 'plan')
          : modes('default')
      },
    },
  })
  world.core.start()
  await settle()
  const plan = async (id: string) =>
    ((await world.command('device.composeOptions', { harness: id })) as ComposeOptions).plan
  assert.equal(await plan('cc'), true)
  assert.equal(await plan('plain'), false)
  assert.deepEqual(asked, [{ harness: 'cc' }, { harness: 'plain' }])
})

test('握手时声明了计划确认：Claude Code 和 Pi 交计划时由引擎在回合里问，界面不再问一次', async () => {
  const world = setup()
  world.core.start()
  await settle()
  const hello = world.peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[] }
  }
  assert.ok(hello.capabilities.litchExtensions.includes('planConfirmation'))
})

test('模式跟着回合发：连着会话现在的模型和强度；发过一次之后不重复发', async () => {
  const world = setup(undefined, { 'thread/resume': resumed('default') })
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  assert.equal(session.seen.view?.settings.mode, 'default')

  await world.command('session.configure', { ...where, settings: { mode: 'plan' } })
  await settle()
  // 改了马上显示成新的，不等发出去
  assert.equal(session.seen.view?.settings.mode, 'plan')
  assert.equal(world.sent('turn/start').length, 0)

  await world.command('session.send', { ...where, text: '先出个计划' })
  const first = world.sent('turn/start')[0] as Sent
  assert.deepEqual(first.collaborationMode, {
    mode: 'plan',
    settings: { model: 'gate/small', reasoning_effort: 'low', developer_instructions: null },
  })
  world.peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: turn('srv-1', [], { status: 'completed' }),
  })
  await settle()
  await world.command('session.send', { ...where, text: '再来' })
  assert.equal('collaborationMode' in (world.sent('turn/start')[1] as Sent), false)
  assert.equal(session.seen.view?.settings.mode, 'plan')
})

test('对面没报模型：模式先不发（协议里它连着模型一起给），留着', async () => {
  // 假对端默认的订阅应答里没有模型
  const world = setup()
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  assert.equal(session.seen.view?.settings.mode, null)
  await world.command('session.configure', { ...where, settings: { mode: 'plan' } })
  await world.command('session.send', { ...where, text: '一' })
  assert.equal('collaborationMode' in (world.sent('turn/start')[0] as Sent), false)
  // 同时选了模型的话就发得出去了
  world.peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: turn('srv-1', [], { status: 'completed' }),
  })
  await settle()
  await world.command('session.configure', { ...where, settings: { model: 'gate/large' } })
  await world.command('session.send', { ...where, text: '二' })
  const second = world.sent('turn/start')[1] as Sent
  assert.deepEqual(second.collaborationMode, {
    mode: 'plan',
    settings: { model: 'gate/large', reasoning_effort: null, developer_instructions: null },
  })
  assert.equal(session.seen.view?.settings.mode, 'plan')
})

test('对面自己改了模式（模型退出了计划模式）：界面跟着变，这边没发出去的那一下不留', async () => {
  const world = setup(undefined, { 'thread/resume': resumed('plan') })
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  assert.equal(session.seen.view?.settings.mode, 'plan')
  const said = (mode: string) =>
    world.peer.last().notify('thread/settings/updated', {
      threadId: 'a',
      threadSettings: { model: 'gate/large', collaborationMode: { mode, settings: {} } },
    })
  said('default')
  await settle()
  assert.equal(session.seen.view?.settings.mode, 'default')
  // 只跟模式：模型那几项不从这条通知里取
  assert.equal(session.seen.view?.settings.model, 'gate/small')
  // 不认识的模式不理
  said('pair')
  await settle()
  assert.equal(session.seen.view?.settings.mode, 'default')

  // 这边想切到计划、还没发出去，对面又说了一次“现在是照常干活”：下个回合不带着计划发
  await world.command('session.configure', { ...where, settings: { mode: 'plan' } })
  said('default')
  await settle()
  assert.equal(session.seen.view?.settings.mode, 'default')
  await world.command('session.send', { ...where, text: '一' })
  assert.equal('collaborationMode' in (world.sent('turn/start')[0] as Sent), false)
})

test('执行计划：退出计划模式和那句话在同一个回合里发，标识以 plan: 开头；回合在跑的时候做不了', async () => {
  const world = setup(undefined, { 'thread/resume': resumed('plan') })
  world.core.start()
  await settle()
  const session = watch(world.core)
  await settle()
  await world.command('session.implementPlan', { ...where, text: '按这份计划执行。' })
  const first = world.sent('turn/start')[0] as Sent
  assert.deepEqual(first.collaborationMode, {
    mode: 'default',
    settings: { model: 'gate/small', reasoning_effort: 'low', developer_instructions: null },
  })
  assert.match(first.clientUserMessageId ?? '', /^plan:/)
  assert.deepEqual(first.input, [{ type: 'text', text: '按这份计划执行。', text_elements: [] }])
  assert.equal(session.seen.view?.settings.mode, 'default')
  assert.deepEqual(session.texts(), [['按这份计划执行。']])

  const busy = await failureOf(
    world.command('session.implementPlan', { ...where, text: '按这份计划执行。' }),
  )
  assert.equal(busy.code, 'rejected')
  // 平常发的消息不带这个标识
  world.peer.last().notify('turn/completed', {
    threadId: 'a',
    turn: turn('srv-1', [], { status: 'completed' }),
  })
  await settle()
  await world.command('session.send', { ...where, text: '接着来' })
  assert.equal('clientUserMessageId' in (world.sent('turn/start')[1] as Sent), false)
})

test('新建会话选了计划模式：建会话的请求里不带（协议里没有），跟着第一个回合发', async () => {
  const world = setup([], {
    'thread/start': () => ({
      thread: thread({ id: 'new-0', turns: [] }),
      model: 'gate/small',
      reasoningEffort: null,
      collaborationMode: { mode: 'default', settings: {} },
    }),
  })
  world.core.start()
  await settle()
  await world.command('session.create', {
    deviceId: 'local',
    cwd: '/work/app',
    text: '先出个计划',
    settings: { mode: 'plan' },
  })
  assert.deepEqual(withoutTools(world.sent('thread/start')), [{ cwd: '/work/app' }])
  assert.deepEqual((world.sent('turn/start')[0] as Sent).collaborationMode, {
    mode: 'plan',
    settings: { model: 'gate/small', reasoning_effort: null, developer_instructions: null },
  })
})

test('模拟核心：dsh 不会计划模式；别的出一份计划，Claude Code 和 Pi 自己接着问，Codex 等界面来问', async () => {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  const command = (name: string, params: object) => core.command(name, params, never)
  const plan = async (id: string) =>
    ((await command('device.composeOptions', { deviceId: 'local', harness: id })) as ComposeOptions)
      .plan
  assert.deepEqual([await plan('claude'), await plan('pi'), await plan('dsh')], [true, true, false])

  const run = async (deviceId: string, sessionId: string) => {
    const at = { deviceId, sessionId }
    const session = watchSession(core, sessionId, deviceId)
    await settle()
    await command('session.configure', { ...at, settings: { mode: 'plan' } })
    await command('session.send', { ...at, text: '给首页加一个状态条' })
    time.advance(50)
    await settle()
    const view = session.seen.view as SessionView
    const last = view.turns.at(-1)
    const plans = (last?.itemIds ?? [])
      .map((id) => view.items[id])
      .filter((item) => item?.kind === 'plan')
    return { at, session, view, last, plans: plans as PlanItem[] }
  }
  /** 答掉计划后面的那一问：选第几项 */
  const answer = async (ran: Awaited<ReturnType<typeof run>>, pick: number) => {
    const request = ran.view.requests[0] as QuestionRequest
    const asked = request.questions[0]
    await command('session.respond', {
      ...ran.at,
      requestId: request.id,
      answers: { [asked?.id ?? '']: [asked?.options?.[pick]?.label ?? ''] },
    })
    time.advance(50)
    await settle()
    return asked?.id
  }

  // Codex（build-01 上的 b6）：出了计划，回合结束，没有请求；界面答“执行”
  const codex = await run('build', 'b6')
  assert.equal(codex.plans.length, 1)
  assert.equal(codex.last?.status, 'completed')
  assert.equal(codex.view.requests.length, 0)
  assert.equal(codex.view.settings.mode, 'plan')
  await command('session.implementPlan', { ...codex.at, text: '按这份计划执行。' })
  time.advance(50)
  await settle()
  assert.equal(codex.session.seen.view?.settings.mode, 'default')
  assert.equal(codex.session.texts().at(-1)?.[0], '按这份计划执行。')

  // Claude Code（s8）：出了计划接着问；选“执行计划”之后它自己退出计划模式
  const cc = await run('local', 's8')
  assert.equal(cc.plans.length, 1)
  assert.equal(await answer(cc, 0), 'execute_plan')
  assert.equal(cc.session.seen.view?.settings.mode, 'default')

  // Pi（s3）：计划插件的那张菜单。选“留在计划模式”不退出
  const pi = await run('local', 's3')
  assert.equal(pi.plans.length, 1)
  await answer(pi, 2)
  assert.equal(pi.session.seen.view?.settings.mode, 'plan')
})
