// 完整模式：一条连接接到设备服务的聚合面，里面有多个 harness。对着假的聚合面跑（fake-device.mts）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '../../protocol/src/index.mjs'
import {
  type AppOp,
  type AppView,
  type ChannelError,
  type ComposeOptions,
  checkSnapshot,
  connectChannel,
  createCore,
  createPortPair,
  type DeviceSnapshot,
  type SessionSummary,
  type SidebarOp,
  type SidebarView,
  serveChannel,
} from '../src/index.mjs'
import { ALL_ABLE } from '../src/projection/session.mjs'
import { type FakeHarness, fakeDevice, harness, infoOf, model } from './fake-device.mjs'
import { fakeOpener, RpcFailure } from './fake-server.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { setup as single, watch } from './world.mjs'

const never = { aborted: false, addEventListener() {} }

/** 两个 harness，各有两个会话，更新时间交错着 */
const pair = (): FakeHarness[] => [
  harness('pi', {
    displayName: 'Pi',
    badge: 'PI',
    threads: [
      thread({ id: 'p1', updatedAt: 1_700_000_400, preview: 'pi 的第一个' }),
      thread({ id: 'p2', updatedAt: 1_700_000_200, preview: 'pi 的第二个' }),
    ],
    models: [model('gate/pi', { isDefault: true })],
  }),
  harness('cc', {
    displayName: 'Claude Code',
    badge: 'CC',
    threads: [
      thread({ id: 'c1', updatedAt: 1_700_000_300, preview: 'cc 的第一个', projectId: 'px' }),
      thread({ id: 'c2', updatedAt: 1_700_000_100, preview: 'cc 的第二个' }),
    ],
    models: [model('claude/a', { isDefault: true }), model('claude/b')],
  }),
]

function setup(harnesses: FakeHarness[] = pair(), remembered: DeviceSnapshot | null = null) {
  const fake = fakeDevice(harnesses)
  const time = fakeClock()
  const peer = fakeOpener(fake.handlers)
  const logs: string[] = []
  const saved: DeviceSnapshot[] = []
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: (line) => logs.push(line),
    store: {
      load: () => ({ localWire: null, remotes: [] }),
      save() {},
      snapshot: () => ({
        load: () => remembered,
        save: (snapshot) => saved.push(structuredClone(snapshot)),
      }),
      forget() {},
    },
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
  const app = { first: null as AppView | null, ops: [] as AppOp[] }
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        app.first = data as AppView
      },
      delta: (ops) => app.ops.push(...(ops as AppOp[])),
      error() {},
    },
  )
  /** 侧栏：像界面那样把快照和增量落下来 */
  const side = {
    sessions: new Map<string, SessionSummary>(),
    archived: null as SessionSummary[] | null,
    workspaces: [] as SidebarView['workspaces'],
    snapshots: 0,
  }
  core.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot(data) {
        const view = data as SidebarView
        side.sessions = new Map(view.sessions.map((entry) => [entry.id, entry]))
        side.archived = view.archived
        side.workspaces = view.workspaces
        side.snapshots++
      },
      delta(ops) {
        for (const op of ops as SidebarOp[]) {
          if (op.op === 'session.upsert') side.sessions.set(op.session.id, op.session)
          else if (op.op === 'session.remove') side.sessions.delete(op.sessionId)
          else if (op.op === 'archived.set') side.archived = op.sessions
        }
      },
      error() {},
    },
  )
  const device = () => {
    const last = app.ops.findLast((op) => op.op === 'device.upsert')
    return last?.op === 'device.upsert' ? last.device : app.first?.devices[0]
  }
  /** 侧栏里的会话和各自的 harness，按标识排好 */
  const rows = () => [...side.sessions.values()].map((entry) => [entry.id, entry.harness]).sort()
  const command = (name: string, params: object) => core.command(name, params, never)
  /** 对面收到过的某个方法的参数，按到达顺序 */
  const sent = (method: string) =>
    peer
      .last()
      .seen.filter((entry) => entry.method === method)
      .map((entry) => entry.params as Record<string, unknown>)
  const find = (id: string): FakeHarness => {
    const entry = fake.device.harnesses.find((item) => item.id === id)
    if (!entry) throw new Error(`没有这个假 harness：${id}`)
    return entry
  }
  /** 改一个 harness 的可用状态，并像设备服务那样发通知 */
  const set = (id: string, down: FakeHarness['down']) => {
    const entry = find(id)
    entry.down = down
    peer.last().notify('litch/harness/status/changed', { harness: id, info: infoOf(entry) })
  }
  return {
    core,
    fake: fake.device,
    peer,
    time,
    logs,
    saved,
    side,
    device,
    rows,
    command,
    sent,
    find,
    set,
  }
}

const DOWN = { kind: 'disconnected', message: '和这个运行时的连接断开了，正在重连' }

/** 聚合面给出来的会话：对象上带着它属于哪个 harness */
const owned = (harnessId: string, source: Thread): Thread =>
  ({ ...source, harness: harnessId }) as Thread

/** 一个说完了的回合 */
const said = (id: string) => turn(id, [userText(`${id}-u`, '问'), agentText(`${id}-m`, '答')])

/** 一条命令没做成时的错误 */
async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('认出设备服务：报成完整模式，harness 的名字、状态和不可用的原因都来自它的声明', async () => {
  const { core, device } = setup([
    ...pair(),
    harness('dsh', { down: { kind: 'unreachable', message: '连不上这个运行时：ENOENT' } }),
    // 这一版还不认识的原因：按一般的“不可用”说，它的原话照带
    harness('codex', { down: { kind: 'notSignedIn', message: '还没登录' }, version: null }),
  ])
  core.start()
  await settle()
  const view = device()
  assert.equal(view?.connection, 'online')
  assert.equal(view?.mode, 'full')
  // 对面的系统是设备服务报的：路径的另一种写法按它认（pathTwin）
  assert.equal(view?.os, 'macos')
  assert.deepEqual(
    view?.harnesses.map((entry) => [entry.id, entry.name, entry.badge, entry.state]),
    [
      ['pi', 'Pi', 'PI', 'ready'],
      ['cc', 'Claude Code', 'CC', 'ready'],
      ['dsh', 'DSH', 'DS', 'unavailable'],
      ['codex', 'CODEX', 'CO', 'unavailable'],
    ],
  )
  assert.deepEqual(
    view?.harnesses.map((entry) => [entry.reason, entry.detail]),
    [
      [null, null],
      [null, null],
      [{ key: 'harness.unreachable' }, '连不上这个运行时：ENOENT'],
      [{ key: 'harness.unavailable' }, '还没登录'],
    ],
  )
})

test('设备上已知的 harness 全都列着：没装的、停用的各说各的原因，不占新建会话的默认，也不引出说明', async () => {
  const { core, device, command, sent } = setup([
    harness('claude-code', {
      displayName: 'Claude Code',
      badge: 'CC',
      version: null,
      down: { kind: 'notInstalled', message: '没有找到 claude 命令' },
    }),
    harness('dsh', { version: null, down: { kind: 'disabled', message: '在设置里停用了' } }),
    harness('codex', { down: { kind: 'versionTooLow', message: '0.90.0 低于要求的 0.160.0' } }),
    harness('pi', { displayName: 'Pi', threads: [thread({ id: 'p1' })] }),
  ])
  core.start()
  await settle()
  assert.deepEqual(
    device()?.harnesses.map((entry) => [entry.id, entry.state, entry.reason, entry.detail]),
    [
      ['claude-code', 'unavailable', { key: 'harness.notInstalled' }, '没有找到 claude 命令'],
      // 用户自己停用的单算一种状态
      ['dsh', 'disabled', { key: 'harness.disabled' }, '在设置里停用了'],
      ['codex', 'unavailable', { key: 'harness.versionTooLow' }, '0.90.0 低于要求的 0.160.0'],
      ['pi', 'ready', null, null],
    ],
  )
  // 它们没有会话留在侧栏里：用不着为它们提示什么
  assert.equal(device()?.note, null)
  assert.deepEqual(device()?.stranded, [])
  // 没说建在哪：第一个可用的，不是排在最前面的那个
  await command('session.create', { deviceId: 'local', cwd: null, text: '开一个' })
  assert.equal(sent('thread/start')[0]?.harness, 'pi')
})

test('会话目录：合并的列表翻页取完，重复给的按标识去重，每个会话记着自己属于哪个 harness', async () => {
  const { core, fake, rows, side, sent } = setup()
  fake.pageSize = 2
  fake.repeatAcrossPages = true
  core.start()
  await settle()
  assert.deepEqual(rows(), [
    ['c1', 'cc'],
    ['c2', 'cc'],
    ['p1', 'pi'],
    ['p2', 'pi'],
  ])
  assert.equal(sent('thread/list').length, 2, '四条会话、每页两条，翻两页')
  assert.ok(
    sent('thread/list').every((params) => !('harness' in params)),
    '取全部的时候不指定 harness',
  )
  // 设备级的工作区还没有：聚合面不提供项目这组方法，引擎自己透传上来的归属不看
  assert.deepEqual(side.workspaces, [])
  assert.equal(side.sessions.get('c1')?.workspaceId, null)
})

test('有 harness 没包含进来：它上次的会话留着，设备下面说一句；问了没成的把原因说出来', async () => {
  const remembered: DeviceSnapshot = {
    mode: 'full',
    harnesses: [],
    workspaces: [],
    sections: [],
    threads: [
      // 上次留下的：cc 的一个会话当时还在跑，pi 的一个会话后来被删了
      owned('cc', thread({ id: 'c-old', status: { type: 'active', activeFlags: [] } })),
      owned('pi', thread({ id: 'p-gone' })),
    ],
    unread: [],
  }
  const harnesses = pair()
  const cc = harnesses[1] as FakeHarness
  cc.down = DOWN
  const { core, device, rows, side, command, find } = setup(harnesses, remembered)
  core.start()
  await settle()
  assert.deepEqual(rows(), [
    ['c-old', 'cc'],
    ['p1', 'pi'],
    ['p2', 'pi'],
  ])
  assert.equal(side.sessions.get('c-old')?.status, 'idle', '当时在跑的，现在不知道了')
  assert.equal(device()?.stale, false, '连上对过了，整体不再算旧的')
  // 它用不了、会话还留着：不占一句说明，只给出是哪一个
  assert.equal(device()?.note, null)
  assert.deepEqual(device()?.stranded, ['cc'])

  // 另一种没包含进来：问了，它回了错
  cc.down = null
  find('pi').listFailure = '扫描会话目录超时'
  await command('device.refresh', { deviceId: 'local' })
  assert.deepEqual(device()?.note, {
    key: 'device.catalogPartial',
    args: { names: 'Pi', message: '扫描会话目录超时' },
  })
  assert.deepEqual(
    rows().map(([id]) => id),
    ['c1', 'c2', 'p1', 'p2'],
    'pi 没取到，它原来的会话留着；cc 这次取到了',
  )
})

test('harness 的状态变了：设备的显示数据跟着变；恢复可用之后只补取它那一份', async () => {
  const harnesses = pair()
  ;(harnesses[1] as FakeHarness).down = DOWN
  const { core, device, rows, sent, set, find } = setup(harnesses)
  core.start()
  await settle()
  const state = (id: string) => device()?.harnesses.find((entry) => entry.id === id)
  assert.equal(state('cc')?.state, 'unavailable')
  assert.deepEqual(state('cc')?.reason, { key: 'harness.disconnected' })
  assert.deepEqual(
    rows().map(([id]) => id),
    ['p1', 'p2'],
  )
  const before = sent('thread/list').length

  // 换了一种原因：还是不可用，不去取
  set('cc', { kind: 'unreachable', message: '连不上' })
  await settle()
  assert.deepEqual(state('cc')?.reason, { key: 'harness.unreachable' })
  assert.equal(sent('thread/list').length, before)

  set('cc', null)
  await settle()
  assert.equal(state('cc')?.state, 'ready')
  assert.equal(state('cc')?.reason, null)
  assert.deepEqual(
    sent('thread/list')
      .slice(before)
      .map((params) => params.harness),
    ['cc'],
    '只列恢复的这一个',
  )
  assert.deepEqual(rows(), [
    ['c1', 'cc'],
    ['c2', 'cc'],
    ['p1', 'pi'],
    ['p2', 'pi'],
  ])
  assert.equal(device()?.note, null)
  assert.deepEqual(device()?.stranded, [])

  // 再掉线：它的会话留在侧栏里，设备的显示数据里记着是它；别的 harness 不动
  find('cc').threads.push(thread({ id: 'c3' }))
  set('cc', DOWN)
  await settle()
  assert.equal(state('cc')?.state, 'unavailable')
  assert.equal(state('pi')?.state, 'ready')
  assert.equal(rows().length, 4)
  assert.equal(device()?.note, null)
  assert.deepEqual(device()?.stranded, ['cc'])
  // 回来：掉线期间新出现的会话补上了
  set('cc', null)
  await settle()
  assert.deepEqual(
    rows().map(([id]) => id),
    ['c1', 'c2', 'c3', 'p1', 'p2'],
  )
  assert.deepEqual(device()?.stranded, [])
})

test('恢复可用之后，它上面打开着的会话重新订阅；别的 harness 的会话不动', async () => {
  const { core, peer, sent, set } = setup()
  core.start()
  await settle()
  const onCc = watch(core, 'c1')
  const onPi = watch(core, 'p1')
  await settle()
  const resumed = () => sent('thread/resume').map((params) => params.threadId)
  assert.deepEqual(resumed(), ['c1', 'p1'])
  assert.equal(onCc.seen.view?.harness, 'cc')
  assert.equal(onPi.seen.view?.harness, 'pi')

  // cc 上有一个审批在等，这时它掉线：请求作废，卡片收掉
  const asked = peer
    .last()
    .ask(
      'item/commandExecution/requestApproval',
      { threadId: 'c1', turnId: 't', itemId: 'i', command: 'ls', cwd: '/', reason: null },
      'litch:cc:1',
    )
  await settle()
  assert.equal(onCc.seen.view?.requests.length, 1)
  set('cc', DOWN)
  await settle()
  assert.equal(onCc.seen.view?.requests.length, 0)
  assert.deepEqual(resumed(), ['c1', 'p1'], '掉线的时候不去重新订阅')
  void asked

  set('cc', null)
  await settle()
  assert.deepEqual(resumed(), ['c1', 'p1', 'c1'], '只重新订阅恢复的那个 harness 上的')
  assert.equal(onCc.seen.snapshots, 2)
  assert.equal(onPi.seen.snapshots, 1)
  assert.deepEqual(onCc.seen.errors, [])
})

test('所属的 harness 不可用时打开会话：先等着，不报错；它恢复了再载入', async () => {
  const harnesses = pair()
  ;(harnesses[1] as FakeHarness).down = DOWN
  const remembered: DeviceSnapshot = {
    mode: 'full',
    harnesses: [],
    workspaces: [],
    sections: [],
    threads: [owned('cc', thread({ id: 'c1' }))],
    unread: [],
  }
  const { core, sent, set } = setup(harnesses, remembered)
  core.start()
  await settle()
  const session = watch(core, 'c1')
  await settle()
  assert.equal(session.seen.snapshots, 0)
  assert.deepEqual(session.seen.errors, [])
  assert.equal(sent('thread/resume').length, 0, '不可用的时候不去问')

  set('cc', null)
  await settle()
  assert.equal(session.seen.view?.sessionId, 'c1')
  assert.equal(session.seen.view?.harness, 'cc')
})

test('载入到一半 harness 断开了：不当成失败，等它恢复之后重新载入', async () => {
  const { core, sent, set, find } = setup()
  core.start()
  await settle()
  // 我们这边还当它可用，它其实已经断了：聚合面对这次订阅回“不可用”
  find('cc').down = DOWN
  const session = watch(core, 'c1')
  await settle()
  assert.deepEqual(session.seen.errors, [], '不报错，也不退回去只读地取')
  assert.equal(sent('thread/read').length, 0)
  set('cc', DOWN)
  set('cc', null)
  await settle()
  assert.equal(session.seen.view?.sessionId, 'c1')
})

test('新建会话：带上选的 harness，建在它上面；没说就用第一个可用的', async () => {
  const { core, command, sent, side, set } = setup()
  core.start()
  await settle()
  const created = (await command('session.create', {
    deviceId: 'local',
    harness: 'cc',
    cwd: null,
    text: '在 cc 上开一个',
  })) as { sessionId: string }
  assert.equal(sent('thread/start')[0]?.harness, 'cc')
  assert.equal(side.sessions.get(created.sessionId)?.harness, 'cc')
  const view = watch(core, created.sessionId)
  assert.equal(view.seen.view?.harness, 'cc')

  // 第一个不可用了：没说建在哪的落到下一个可用的上
  set('pi', DOWN)
  await settle()
  const second = (await command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '随便哪个',
  })) as { sessionId: string }
  assert.equal(sent('thread/start')[1]?.harness, 'cc')
  assert.equal(side.sessions.get(second.sessionId)?.harness, 'cc')

  // 一个都不可用：说得出是哪一句
  set('cc', DOWN)
  await settle()
  const none = await failureOf(
    command('session.create', { deviceId: 'local', cwd: null, text: '没处建' }),
  )
  assert.deepEqual(none.text, { key: 'fault.noHarness' })
})

test('底栏的选择器按 harness 取：各问一遍、各记各的，掉线再回来的那个重新问', async () => {
  const { core, command, sent, set, peer } = setup()
  core.start()
  await settle()
  const options = (harnessId?: string) =>
    command('device.composeOptions', {
      deviceId: 'local',
      ...(harnessId ? { harness: harnessId } : {}),
    }) as Promise<ComposeOptions>
  const ids = (value: ComposeOptions) => value.models.map((entry) => entry.id)
  assert.deepEqual(ids(await options('cc')), ['claude/a', 'claude/b'])
  assert.deepEqual(ids(await options('pi')), ['gate/pi'])
  assert.deepEqual(ids(await options('cc')), ['claude/a', 'claude/b'])
  assert.deepEqual(ids(await options()), ['gate/pi'], '没说要哪个的给第一个可用的')
  assert.deepEqual(
    sent('model/list').map((params) => params.harness),
    ['cc', 'pi'],
    '每个 harness 只问一遍',
  )

  set('cc', DOWN)
  set('cc', null)
  await settle()
  await options('cc')
  await options('pi')
  assert.deepEqual(
    sent('model/list').map((params) => params.harness),
    ['cc', 'pi', 'cc'],
  )

  // 供应商、登录变了（Claude 的选单按能用的供应商拼）：那个 harness 的重新问，别的不动
  peer.last().notify('litch/harness/config/changed', { harness: 'cc', part: 'providers' })
  peer.last().notify('litch/harness/config/changed', { harness: 'pi', part: 'mcp' })
  await settle()
  await options('cc')
  await options('pi')
  assert.deepEqual(
    sent('model/list').map((params) => params.harness),
    ['cc', 'pi', 'cc', 'cc'],
  )
})

test('单 harness 模式下请求里不带 harness：对面没声明这个扩展', async () => {
  const { core, command, sent } = single(undefined, {
    'thread/start': () => ({ thread: thread({ id: 'new', turns: [] }), model: null }),
  })
  core.start()
  await settle()
  await command('session.create', { deviceId: 'local', harness: 'pi', cwd: null, text: '你好' })
  await command('device.composeOptions', { deviceId: 'local', harness: 'pi' })
  for (const method of ['thread/list', 'thread/start', 'model/list']) {
    const all = sent(method) as Record<string, unknown>[]
    assert.ok(all.length > 0, `${method} 应该发过`)
    assert.ok(
      all.every((params) => !('harness' in params)),
      `${method} 不该带 harness`,
    )
  }
})

test('能力降级按 harness 记：一个 harness 不会分叉，不连累别的 harness 的会话', async () => {
  const { core, command, sent, set, side } = setup([
    harness('pi', {
      displayName: 'Pi',
      lacks: ['thread/fork'],
      threads: [thread({ id: 'p1', turns: [said('t1')] }), thread({ id: 'p2' })],
    }),
    harness('cc', {
      displayName: 'Claude Code',
      threads: [thread({ id: 'c1', turns: [said('t1')] })],
    }),
  ])
  core.start()
  await settle()
  const onPi = watch(core, 'p1')
  const otherPi = watch(core, 'p2')
  const onCc = watch(core, 'c1')
  await settle()
  const fork = (sessionId: string) =>
    command('session.fork', { deviceId: 'local', sessionId, turnId: 't1' })
  // 这两个 harness 都没有声明：先当它都会
  const all = { ...ALL_ABLE }
  assert.deepEqual(onPi.seen.view?.can, all)

  await assert.rejects(fork('p1'), { code: 'unsupported' })
  assert.deepEqual(onPi.seen.view?.can, { ...all, fork: false })
  assert.deepEqual(
    otherPi.seen.view?.can,
    { ...all, fork: false },
    '同一个 harness 上别的会话也知道了',
  )
  assert.deepEqual(onCc.seen.view?.can, all, '别的 harness 的会话不受影响')

  // cc 照常能分叉，分出来的会话归它
  const forked = (await fork('c1')) as { sessionId: string }
  assert.equal(side.sessions.get(forked.sessionId)?.harness, 'cc')
  // pi 这边记住了，不再去问
  await assert.rejects(fork('p1'), { code: 'unsupported' })
  assert.deepEqual(
    sent('thread/fork').map((params) => params.threadId),
    ['p1', 'c1'],
  )
  // 压缩两边都会：记的是“哪个 harness 不会哪件事”，不是整个 harness 降级
  await command('session.compact', { deviceId: 'local', sessionId: 'p1' })

  // pi 掉线又回来（可能换了一版）：它的从头再试，cc 的不动
  set('pi', DOWN)
  set('pi', null)
  await settle()
  assert.deepEqual(onPi.seen.view?.can, all)
  assert.deepEqual(otherPi.seen.view?.can, all)
  await assert.rejects(fork('p1'), { code: 'unsupported' })
  assert.equal(sent('thread/fork').length, 3)
})

test('错误说得出是哪一句：harness 不可用、没有这个 harness、找不到会话', async () => {
  const { core, command, set, find, fake } = setup()
  core.start()
  await settle()
  watch(core, 'c1')
  watch(core, 'p1')
  watch(core, 'p2')
  await settle()
  const send = (sessionId: string) =>
    failureOf(command('session.send', { deviceId: 'local', sessionId, text: '在吗' }))

  // 我们这边还当它可用，聚合面说它不可用：用的是它声明的名字，不是标识
  find('cc').down = DOWN
  const late = await send('c1')
  assert.equal(late.code, 'remote')
  assert.deepEqual(late.text, { key: 'fault.harnessUnavailable', args: { name: 'Claude Code' } })

  // 已经知道它不可用：不去问，直接说同一句
  set('cc', DOWN)
  await settle()
  const known = await send('c1')
  assert.deepEqual(known.text, { key: 'fault.harnessUnavailable', args: { name: 'Claude Code' } })
  // 别的 harness 上照常能发
  await command('session.send', { deviceId: 'local', sessionId: 'p1', text: '在吗' })

  // 新建会话、模型清单指到不可用的 harness 上：同一句
  const create = await failureOf(
    command('session.create', { deviceId: 'local', harness: 'cc', cwd: null, text: '开一个' }),
  )
  assert.deepEqual(create.text, { key: 'fault.harnessUnavailable', args: { name: 'Claude Code' } })
  const options = await failureOf(
    command('device.composeOptions', { deviceId: 'local', harness: 'cc' }),
  )
  assert.deepEqual(options.text, { key: 'fault.harnessUnavailable', args: { name: 'Claude Code' } })

  // 这台设备上没有配置的 harness
  const unknown = await failureOf(
    command('session.create', { deviceId: 'local', harness: 'nope', cwd: null, text: '开一个' }),
  )
  assert.deepEqual(unknown.text, { key: 'fault.unknownHarness', args: { name: 'nope' } })

  // 找不到的会话：有 harness 当时没问到，就说它可能在那里；都问到了就直说找不到
  const maybe = await failureOf(
    command('session.rename', { deviceId: 'local', sessionId: '没有这个会话', title: '新名字' }),
  )
  assert.deepEqual(maybe.text, {
    key: 'fault.unknownThreadMaybe',
    args: { names: 'Claude Code' },
  })
  set('cc', null)
  await settle()
  const gone = await failureOf(
    command('session.rename', { deviceId: 'local', sessionId: '没有这个会话', title: '新名字' }),
  )
  assert.deepEqual(gone.text, { key: 'fault.unknownThread' })

  // 上游引擎自己回的错没有这些：原话照给，不带句子
  fake.turnFailure = new RpcFailure(-32000, '模型网关回了 502')
  const plain = await send('p2')
  assert.equal(plain.code, 'remote')
  assert.equal(plain.message, '模型网关回了 502')
  assert.equal(plain.text, undefined)
})

test('错误里的那一句过得了通道：界面那一头拿到的还是“哪一句”', async () => {
  const { core, time, set } = setup()
  core.start()
  await settle()
  const [near, far] = createPortPair()
  const stop = serveChannel(far, core, { clock: time.clock })
  const client = connectChannel(near)
  set('cc', DOWN)
  await settle()
  const failure = await failureOf(
    client.command('session.create', {
      deviceId: 'local',
      harness: 'cc',
      cwd: null,
      text: '开一个',
    }),
  )
  assert.equal(failure.code, 'remote')
  assert.deepEqual(failure.text, {
    key: 'fault.harnessUnavailable',
    args: { name: 'Claude Code' },
  })
  client.close()
  stop()
})

test('聚合面给的请求号是字符串：应答时原样带回去', async () => {
  const { core, peer, command } = setup()
  core.start()
  await settle()
  const session = watch(core, 'c1')
  await settle()
  const asked = peer
    .last()
    .ask(
      'item/commandExecution/requestApproval',
      { threadId: 'c1', turnId: 't', itemId: 'i', command: 'ls', cwd: '/', reason: null },
      'litch:cc:7',
    )
  await settle()
  const request = session.seen.view?.requests[0]
  assert.ok(request, '审批卡片应该出来了')
  await command('session.respond', {
    deviceId: 'local',
    sessionId: 'c1',
    requestId: request.id,
    optionId: 'accept',
  })
  const answer = await asked
  assert.ok('result' in answer)
  assert.equal(answer.id, 'litch:cc:7')
})

test('记下来的侧栏带着模式和各 harness：下次没连上之前就知道这是完整模式；旧形状的读不懂就当没有', async () => {
  const first = setup()
  first.core.start()
  await settle()
  first.time.advance(5_000)
  await settle()
  const kept = first.saved.at(-1)
  assert.ok(kept, '对账之后应该记过一次')
  assert.equal(kept.mode, 'full')
  assert.deepEqual(
    kept.harnesses.map((entry) => entry.id),
    ['pi', 'cc'],
  )
  assert.deepEqual(
    kept.threads.map((entry) => [entry.id, (entry as { harness?: string }).harness]).sort(),
    [
      ['c1', 'cc'],
      ['c2', 'cc'],
      ['p1', 'pi'],
      ['p2', 'pi'],
    ],
  )
  // 过一遍磁盘（JSON）再读回来，形状认得
  assert.deepEqual(checkSnapshot(JSON.parse(JSON.stringify(kept))), kept)
  // 上一版记的形状（只有一个 harness 字段）：当没有
  assert.equal(
    checkSnapshot({ harness: kept.harnesses[0], workspaces: [], threads: kept.threads }),
    null,
  )
  assert.equal(checkSnapshot(null), null)

  // 带着它启动，对面这次连不上：设备已经是完整模式，会话各归各的 harness
  const second = setup(pair(), kept)
  second.peer.failures.push(new Error('连不上'))
  second.core.start()
  await settle()
  assert.equal(second.device()?.mode, 'full')
  assert.equal(second.device()?.stale, true)
  assert.deepEqual(second.rows(), [
    ['c1', 'cc'],
    ['c2', 'cc'],
    ['p1', 'pi'],
    ['p2', 'pi'],
  ])
})

test('已归档的列表也是合并的：每个会话带着自己的 harness，重新可用的 harness 的补进来', async () => {
  const harnesses = pair()
  const [pi, cc] = harnesses as [FakeHarness, FakeHarness]
  pi.archived = [thread({ id: 'pa', updatedAt: 1_700_000_050 })]
  cc.archived = [thread({ id: 'ca', updatedAt: 1_700_000_060 })]
  cc.down = DOWN
  const { core, command, side, sent, set } = setup(harnesses)
  core.start()
  await settle()
  await command('device.loadArchived', { deviceId: 'local' })
  assert.deepEqual(
    side.archived?.map((entry) => [entry.id, entry.harness]),
    [['pa', 'pi']],
  )
  set('cc', null)
  await settle()
  assert.deepEqual(side.archived?.map((entry) => [entry.id, entry.harness]).sort(), [
    ['ca', 'cc'],
    ['pa', 'pi'],
  ])
  const archivedAsks = sent('thread/list').filter((params) => params.archived === true)
  assert.deepEqual(
    archivedAsks.map((params) => params.harness),
    [undefined, 'cc'],
  )
})

test('设备服务没有声明设备级的工作区：问一次、说没有就记住，引擎自己透传上来的项目通知不引起重取', async () => {
  const { core, peer, side, sent, device } = setup()
  core.start()
  await settle()
  const before = side.snapshots
  peer.last().notify('thread/project/updated', { threadId: 'c1', projectId: 'px' })
  peer.last().notify('project/changed', {})
  await settle()
  assert.equal(side.sessions.get('c1')?.workspaceId, null)
  assert.deepEqual(side.workspaces, [])
  assert.equal(side.snapshots, before, '没有因此重新对一遍')
  assert.equal(sent('project/list').length, 1, '没声明的只在连上时问过那一次')
  assert.equal(device()?.organizable, false)
})
