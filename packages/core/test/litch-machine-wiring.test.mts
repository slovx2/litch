// litch_machine 的接线：开关、三档审批、命令里提到禁止位置时再弹、卡片过期、
// 同一回合里拒过的不再问、对话里和全局待处理两种卡片、系统通知、关开关时收拾、握手声明、建会话时的说明、
// 交给执行器的两台机器。执行器是假的（真的那份归执行器那条线，见 machine-*.test.mts），设备是假对端。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import type { JsonRpcMessage, Thread } from '../../protocol/src/index.mjs'
import { codexRejects } from '../../shared/test/codex-params.mjs'
import { SENSITIVE_PRESETS } from '../src/device/machine/presets.mjs'
import type {
  MachineApprovalResult,
  MachineCallContext,
  MachineExecutor,
  MachineFacts,
  MachineProcessRecord,
} from '../src/device/machine/types.mjs'
import {
  CLIENT_TOOL,
  type ClientAskRequest,
  type ClientToolPort,
  checkSaved,
  createCore,
  type DeviceView,
  type ToolToCore,
  type ToolToMain,
} from '../src/index.mjs'
import { MACHINE_ASK_EXPIRES_MS } from '../src/machine-wiring.mjs'
import type {
  MachineActivityView,
  MachineAskView,
  MachineLogEntry,
  MachineOp,
} from '../src/model-machine.mjs'
import { fakeOpener, type Handler } from './fake-server.mjs'
import { thread, turn } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const never = { aborted: false, addEventListener() {} }

const DESKTOP: MachineFacts = {
  name: 'Song 的 MacBook',
  hostname: 'songs-mbp',
  system: 'macOS 26.5 arm64',
  user: 'song',
  home: '/Users/song',
  shell: '/bin/zsh',
}

/** 远程设备上现查情况时那条 sh 的输出：主机名、内核、架构、用户、主目录、shell、macOS 版本（空） */
const BOX_FACTS = 'box.internal\nLinux\nx86_64\ndev\n/home/dev\n/bin/bash\n\n'

/** 假的主进程：只记核心发来的（这里只关心系统通知） */
function fakeMain() {
  const sent: ToolToMain[] = []
  const port: ClientToolPort = {
    namespaces: () => [],
    post: (message) => sent.push(structuredClone(message)),
    listen(_handler: (message: ToolToCore) => void) {},
  }
  return {
    port,
    notices: () =>
      sent.filter(
        (message): message is Extract<ToolToMain, { op: 'notify' }> => message.op === 'notify',
      ),
  }
}

interface Seen {
  tool: string
  args: Record<string, unknown>
  context: MachineCallContext
}

/**
 * 假的执行器：exec、write_file 按 mutate 要用户点头，read_file 按 read；args.flagged 原样放进卡片。
 * 点头了回 ok，没点头回 declined 并带上结局（expired、cancelled、declined:理由）。machines 回两台机器的情况
 */
function fakeExecutor() {
  const seen: Seen[] = []
  const outcomes: MachineApprovalResult[] = []
  const stopped: (string | undefined)[] = []
  const presence: [string, boolean][] = []
  let records: MachineProcessRecord[] = []
  const listeners = new Set<() => void>()
  const executor: MachineExecutor = {
    async call(tool, raw, context): Promise<ClientToolCallResponse> {
      const args = (raw ?? {}) as Record<string, unknown>
      seen.push({ tool, args, context })
      if (tool === 'machines') {
        const list = await Promise.all(
          context.targets().map(async (target) => ({ id: target.id, ...(await target.facts()) })),
        )
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(list) }] }
      }
      const mutate = tool !== 'read_file'
      const ask: MachineAskView = {
        kind: 'machine',
        action: tool === 'exec' ? 'exec' : tool === 'write_file' ? 'write' : 'read',
        command: typeof args.command === 'string' ? args.command : null,
        cwd: null,
        path: typeof args.path === 'string' ? args.path : null,
        copy: null,
        flagged: Array.isArray(args.flagged) ? (args.flagged as string[]) : [],
      }
      const result = await context.approve({ class: mutate ? 'mutate' : 'read', ask })
      outcomes.push(result)
      if (result.kind !== 'allowed') {
        const note = result.kind === 'declined' && result.note ? `:${result.note}` : ''
        context.log({
          tool,
          summary: String(args.command ?? args.path),
          result: result.kind === 'expired' ? 'expired' : 'declined',
          flagged: false,
        })
        return clientToolFailure('declined', `${result.kind}${note}`)
      }
      context.log({
        tool,
        summary: String(args.command ?? args.path),
        result: 'ok',
        flagged: ask.flagged.length > 0,
      })
      return { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] }
    },
    processes: () => records,
    onProcessesChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    kill(processId) {
      const before = records.length
      records = records.filter((record) => record.id !== processId)
      for (const listener of listeners) listener()
      return records.length !== before
    },
    stopAll(deviceId) {
      stopped.push(deviceId)
      records = records.filter(
        (record) => deviceId !== undefined && record.owner.deviceId !== deviceId,
      )
      for (const listener of listeners) listener()
    },
    ownerPresence(deviceId, online) {
      presence.push([deviceId, online])
    },
    dispose() {},
  }
  return {
    executor,
    seen,
    outcomes,
    stopped,
    presence,
    /** 假装起了一个进程 */
    start(record: MachineProcessRecord) {
      records = [...records, record]
      for (const listener of listeners) listener()
    },
  }
}

function setup(options: { threads?: Thread[]; machine?: boolean } = {}) {
  const threads = options.threads ?? [
    thread({ id: 'a', cwd: '/work/app', turns: [turn('t1', [], { status: 'inProgress' })] }),
  ]
  const remoteHandlers: Record<string, Handler> = {
    'runtime/info': () => ({
      engine: 'pi',
      protocolVersion: '0.163.0',
      cliBuild: '0.99.1',
      capabilities: [],
      releaseReady: true,
      extensions: ['clientTools'],
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
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    // 现查设备情况的那条 sh：应答之后发退出的通知，输出是 BOX_FACTS
    'process/spawn': (params) => {
      const { processHandle } = params as { processHandle: string }
      setImmediate(() =>
        remote
          .last()
          .notify('process/exited', { processHandle, exitCode: 0, stdout: BOX_FACTS, stderr: '' }),
      )
      return {}
    },
  }
  const localHandlers: Record<string, Handler> = {
    'runtime/info': () => ({
      engine: 'pi',
      protocolVersion: '0.163.0',
      cliBuild: '0.99.1',
      capabilities: [],
      releaseReady: true,
      extensions: ['clientTools'],
    }),
    'project/list': () => ({ data: [], nextCursor: null }),
    'thread/list': () => ({ data: [], nextCursor: null, backwardsCursor: null }),
    'thread/start': () => ({
      thread: thread({ id: 'mine', preview: '', turns: [] }),
      model: 'm',
      reasoningEffort: null,
      sandbox: { type: 'readOnly' },
    }),
    'turn/start': () => ({ turn: turn('srv-1', [], { status: 'inProgress' }) }),
  }
  const remote = fakeOpener(remoteHandlers)
  const local = fakeOpener(localHandlers)
  const time = fakeClock()
  const main = fakeMain()
  const fake = fakeExecutor()
  const logs = new Map<string, unknown>()
  const core = createCore({
    clock: time.clock,
    version: '9.9.9',
    log: () => {},
    clientTools: main.port,
    ...(options.machine === false
      ? {}
      : { machine: { desktop: DESKTOP, executor: () => fake.executor } }),
    store: {
      load: () => ({ localWire: null, remotes: [] }),
      save() {},
      snapshot: () => ({ load: () => null, save() {} }),
      forget() {},
      machineLog: (deviceId) => ({
        load: () => logs.get(deviceId) ?? null,
        save: (entries) => logs.set(deviceId, structuredClone(entries)),
      }),
    },
    devices: [
      {
        id: 'local',
        name: '本机',
        host: 'song@songs-mbp',
        kind: 'local',
        target: null,
        wire: 'green',
        open: local.open,
      },
      {
        id: 'box',
        name: 'dev-box',
        host: 'dev@box',
        kind: 'ssh',
        target: { kind: 'host', host: 'box', port: null, user: 'dev', keyFile: null },
        wire: 'orange',
        open: remote.open,
      },
    ],
  })
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
  const activity = { view: null as MachineActivityView | null }
  core.subscribe(
    { kind: 'machine' },
    {
      snapshot: (data) => {
        activity.view = data as MachineActivityView
      },
      delta: (ops) => {
        for (const op of ops as MachineOp[]) activity.view = op.view
      },
      error() {},
    },
  )
  const command = (name: string, params: object) => core.command(name, params, never)
  /** 远程设备上的引擎发来一次回合里的工具调用 */
  const call = (args: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    remote.last().ask('item/tool/call', {
      threadId: 'a',
      turnId: 't1',
      callId: `c${Math.random()}`,
      namespace: 'litch_machine',
      tool: 'exec',
      arguments: args,
      ...more,
    })
  /** 设备进程转来的命令行调用 */
  const detached = (args: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    remote.last().ask('litch/clientTool/call', {
      callId: `d${Math.random()}`,
      namespace: 'litch_machine',
      tool: 'exec',
      arguments: args,
      threadId: null,
      turnId: null,
      harness: null,
      ...more,
    })
  const enable = () => command('device.tools.set', { deviceId: 'box', machine: true })
  const box = () => app.devices.find((entry) => entry.id === 'box')
  return {
    core,
    remote,
    local,
    time,
    main,
    fake,
    logs,
    app,
    activity,
    command,
    call,
    detached,
    enable,
    box,
  }
}

const textOf = (message: JsonRpcMessage) => {
  const result = (message as { result?: ClientToolCallResponse }).result
  const first = result?.contentItems[0]
  return first?.type === 'inputText' ? first.text : ''
}

/** 会话 a 里挂着的 litch_machine 卡片 */
const cardsOf = (session: ReturnType<typeof watchSession>) =>
  (session.seen.view?.requests ?? []).filter(
    (request): request is ClientAskRequest =>
      request.kind === 'clientAsk' && request.ask.kind === 'machine',
  )

async function started() {
  const world = setup()
  world.core.start()
  await settle()
  await settle()
  return world
}

test('开关：远程设备默认关、本机没有这一项；关着当场回 disabled（说明写给模型）不找执行器，记一条操作记录', async () => {
  const { app, call, command, fake, box } = await started()
  assert.equal(app.devices.find((entry) => entry.id === 'local')?.machine, null)
  assert.deepEqual(box()?.machine, {
    enabled: false,
    approval: 'session',
    access: { mode: 'sensitive', custom: [] },
    presets: [...SENSITIVE_PRESETS],
  })
  const off = textOf(await call({ command: 'ls' }))
  assert.match(off, /^\[litch:disabled\] .*Operate this computer/)
  assert.equal(fake.seen.length, 0)
  const { entries } = (await command('machine.log', { deviceId: 'box' })) as {
    entries: MachineLogEntry[]
  }
  assert.deepEqual(
    entries.map((entry) => [entry.tool, entry.summary, entry.result, entry.sessionId]),
    [['exec', 'ls', 'disabled', 'a']],
  )
  // 本机设备改不了这一项
  await assert.rejects(command('device.tools.set', { deviceId: 'local', machine: true }), {
    code: 'invalid',
  })
  await assert.rejects(command('device.machine.set', { deviceId: 'local', approval: 'never' }), {
    code: 'invalid',
  })
  // 打开之后下一次就交给执行器
  await command('device.tools.set', { deviceId: 'box', machine: true })
  assert.equal(box()?.machine?.enabled, true)
  void call({ command: 'ls' })
  await settle()
  assert.equal(fake.seen.length, 1)
})

test('握手：远程设备声明 litch_machine 并报桌面端的主机名和名字；本机设备不声明', async () => {
  const { remote, local } = await started()
  const capsOf = (server: typeof remote) => {
    const init = server.last().seen.find((entry) => entry.method === 'initialize')
    assert.ok(init)
    return (init.params as { capabilities: Record<string, unknown> }).capabilities
  }
  const far = capsOf(remote)
  assert.ok((far.litchExtensions as string[]).includes('clientTools'))
  assert.deepEqual(far.litchClientTools, {
    namespaces: ['litch_machine'],
    desktop: { hostname: 'songs-mbp', name: 'Song 的 MacBook' },
  })
  // 本机：主进程什么都执行不了，litch_machine 也不给本机，干脆不声明
  const near = capsOf(local)
  assert.equal(near.litchClientTools, undefined)

  // 这台桌面端执行不了 litch_machine（核心没给）：远程也不声明
  const bare = setup({ machine: false })
  bare.core.start()
  await settle()
  assert.equal(capsOf(bare.remote).litchClientTools, undefined)
})

test('建会话：远程会话带上 litch_machine，说明开头写这个会话在哪台、桌面端是哪台；本机会话不带', async () => {
  const { command, remote, local } = await started()
  await command('session.create', { deviceId: 'box', cwd: '/work', text: '你好' })
  const start = remote.last().seen.find((entry) => entry.method === 'thread/start')
  assert.ok(start)
  const tools = (start.params as { dynamicTools?: { name: string; description: string }[] })
    .dynamicTools
  const spec = tools?.find((entry) => entry.name === 'litch_machine')
  assert.ok(spec)
  assert.match(spec.description, /^You are running on "dev-box" \(box\.internal, Linux x86_64\)\./)
  assert.match(
    spec.description,
    /"Song 的 MacBook" \(songs-mbp, macOS 26\.5 arm64\) is the user's desktop/,
  )
  assert.ok(spec.description.length <= 1024)
  // 整份参数过得了原生 codex 对 thread/start 的校验（命名空间说明的上限就在这里面）
  assert.deepEqual(codexRejects('thread/start', start.params), [])

  await command('session.create', { deviceId: 'local', cwd: '/work', text: '你好' })
  const mine = local.last().seen.find((entry) => entry.method === 'thread/start')
  assert.ok(mine)
  assert.equal((mine.params as { dynamicTools?: unknown }).dynamicTools, undefined)
})

test('机器：desktop 是外壳给的这台桌面端，session 是会话所在设备现查的；本机设备的连接在 desktop 背后', async () => {
  const { call, enable, fake } = await started()
  await enable()
  const listed = JSON.parse(textOf(await call({}, { tool: 'machines' })))
  assert.deepEqual(listed, [
    { id: 'desktop', ...DESKTOP },
    {
      id: 'session',
      name: 'dev-box',
      hostname: 'box.internal',
      system: 'Linux x86_64',
      user: 'dev',
      home: '/home/dev',
      shell: '/bin/bash',
    },
  ])
  const { context } = fake.seen[0] ?? {}
  assert.deepEqual(context?.owner, { deviceId: 'box', threadId: 'a', harness: 'pi' })
  assert.deepEqual(context?.settings, { approval: 'session', access: 'sensitive' })
  assert.deepEqual(context?.policy, { mode: 'sensitive', denied: SENSITIVE_PRESETS })
  assert.equal(context?.target('desktop')?.role, 'desktop')
  assert.equal(context?.target('session')?.role, 'session')
  assert.equal(context?.target('elsewhere'), null)
})

/** 在会话 a 里答一张卡片 */
const respond = (
  world: Awaited<ReturnType<typeof started>>,
  card: ClientAskRequest | undefined,
  optionId: string,
  note?: string,
) =>
  world.command('session.respond', {
    deviceId: 'box',
    sessionId: 'a',
    requestId: card?.id,
    optionId,
    ...(note === undefined ? {} : { note }),
  })

test('审批·每个会话确认一次（默认）：执行、读各弹一次，“本会话都允许”两类各管各的', async () => {
  const world = await started()
  const { call, enable, fake } = world
  await enable()
  const session = watchSession(world.core, 'a', 'box')
  const first = call({ command: 'make' })
  await settle()
  const [card] = cardsOf(session)
  assert.equal(card?.tool.namespace, 'litch_machine')
  assert.deepEqual(card?.device, { name: 'dev-box', kind: 'ssh', host: 'dev@box' })
  assert.deepEqual(
    card?.options.map((option) => [option.role, option.note === true]),
    [
      ['accept', false],
      ['acceptSession', false],
      ['decline', true],
    ],
  )
  await respond(world, card, 'session')
  assert.equal(textOf(await first), 'ok')
  // 同一会话再执行：不弹
  assert.equal(textOf(await call({ command: 'make test' })), 'ok')
  assert.equal(cardsOf(session).length, 0)
  // 读是另一类：第一次照样弹
  const read = call({ path: '/etc/hosts' }, { tool: 'read_file' })
  await settle()
  const [readCard] = cardsOf(session)
  assert.equal(readCard?.ask.kind === 'machine' && readCard.ask.action, 'read')
  await respond(world, readCard, 'once')
  assert.equal(textOf(await read), 'ok')
  // “允许这一次”只管那一条
  const again = call({ path: '/etc/hosts' }, { tool: 'read_file' })
  await settle()
  assert.equal(cardsOf(session).length, 1)
  await respond(world, cardsOf(session)[0], 'session')
  assert.equal(textOf(await again), 'ok')
  assert.equal(fake.outcomes.length, 4)
})

test('审批·逐条确认：执行每次都弹，读每个会话一次；不确认：都不弹，命令里提到禁止位置也不弹', async () => {
  const world = await started()
  const { call, enable, command } = world
  await enable()
  await command('device.machine.set', { deviceId: 'box', approval: 'each' })
  assert.equal(world.box()?.machine?.approval, 'each')
  const session = watchSession(world.core, 'a', 'box')
  for (const cmd of ['a', 'b']) {
    const pending = call({ command: cmd })
    await settle()
    assert.equal(cardsOf(session).length, 1, `命令 ${cmd} 要弹`)
    const [card] = cardsOf(session)
    // 每次都问：卡片上没有“本会话都允许”
    assert.deepEqual(
      card?.options.map((option) => option.id),
      ['once', 'decline'],
    )
    await respond(world, card, 'once')
    assert.equal(textOf(await pending), 'ok')
  }
  const read = call({ path: '/x' }, { tool: 'read_file' })
  await settle()
  await respond(world, cardsOf(session)[0], 'session')
  await read
  assert.equal(textOf(await call({ path: '/y' }, { tool: 'read_file' })), 'ok')

  await command('device.machine.set', { deviceId: 'box', approval: 'never' })
  assert.equal(textOf(await call({ command: 'rm -rf build' })), 'ok')
  assert.equal(textOf(await call({ command: 'cat ~/.ssh/id', flagged: ['~/.ssh'] })), 'ok')
  assert.equal(cardsOf(session).length, 0)
  const { entries } = (await command('machine.log', { deviceId: 'box' })) as {
    entries: MachineLogEntry[]
  }
  // 新的在前；不确认那档下照样跑了的禁止位置标出来
  assert.deepEqual(
    entries.slice(0, 2).map((entry) => [entry.summary, entry.flagged]),
    [
      ['cat ~/.ssh/id', true],
      ['rm -rf build', false],
    ],
  )
})

test('审批·命令里提到禁止位置：已经“本会话都允许”也再弹一次；卡片上带着是哪几处', async () => {
  const world = await started()
  const { call, enable } = world
  await enable()
  const session = watchSession(world.core, 'a', 'box')
  const first = call({ command: 'ls' })
  await settle()
  await respond(world, cardsOf(session)[0], 'session')
  await first
  const flagged = call({ command: 'cat ~/.aws/credentials', flagged: ['~/.aws'] })
  await settle()
  const [card] = cardsOf(session)
  assert.deepEqual(card?.ask.kind === 'machine' && card.ask.flagged, ['~/.aws'])
  await respond(world, card, 'once')
  assert.equal(textOf(await flagged), 'ok')
  // 没提到的照旧不弹
  assert.equal(textOf(await call({ command: 'pwd' })), 'ok')
})

test('卡片过期：10 分钟没人答当作拒绝（expired），卡片撤掉；等人答的时候不算 120 秒的超时', async () => {
  const world = await started()
  const { call, enable, time, fake } = world
  await enable()
  const session = watchSession(world.core, 'a', 'box')
  const pending = call({ command: 'sleep 1' })
  await settle()
  assert.equal(cardsOf(session).length, 1)
  // 过了 120 秒：卡片挂着，不超时
  time.advance(200_000)
  await settle()
  assert.equal(cardsOf(session).length, 1)
  // 拨到正好 10 分钟（再往后拨的话，卡片作废之后重新起的 120 秒也会在同一次拨动里到点）
  time.advance(MACHINE_ASK_EXPIRES_MS - 200_000)
  assert.match(textOf(await pending), /^\[litch:declined\] expired/)
  assert.equal(cardsOf(session).length, 0)
  assert.deepEqual(fake.outcomes, [{ kind: 'expired' }])
})

test('拒绝：理由交给执行器；同一回合里拒过的同一件事不再问直接拒，换一件事、换一个回合照样问', async () => {
  const world = await started()
  const { call, enable, fake, remote } = world
  await enable()
  const session = watchSession(world.core, 'a', 'box')
  const first = call({ command: 'rm -rf /tmp/x' })
  await settle()
  await respond(world, cardsOf(session)[0], 'decline', '别删')
  assert.match(textOf(await first), /^\[litch:declined\] declined:别删/)
  // 同一回合、同一条：不弹，原样拒
  assert.match(textOf(await call({ command: 'rm -rf /tmp/x' })), /declined:别删/)
  assert.equal(cardsOf(session).length, 0)
  // 换一条：照样问
  const other = call({ command: 'ls /tmp' })
  await settle()
  assert.equal(cardsOf(session).length, 1)
  await respond(world, cardsOf(session)[0], 'once')
  await other
  // 回合结束之后（下一个回合）同一条再问
  remote.last().notify('turn/completed', {
    threadId: 'a',
    turn: turn('t1', [], { status: 'completed' }),
  })
  await settle()
  const next = call({ command: 'rm -rf /tmp/x' }, { turnId: 't2' })
  await settle()
  assert.equal(cardsOf(session).length, 1)
  await respond(world, cardsOf(session)[0], 'decline')
  assert.match(textOf(await next), /^\[litch:declined\] declined$/)
  assert.equal(fake.outcomes.filter((outcome) => outcome.kind === 'declined').length, 3)
})

test('命令行调用：找不到会话的卡片进全局待处理并发系统通知，machine.answer 答它；会话找得到的进那个会话', async () => {
  const world = await started()
  const { detached, enable, activity, main, command } = world
  await enable()
  const pending = detached({ command: 'uname -a' })
  await settle()
  const [card] = activity.view?.pending ?? []
  assert.ok(card)
  assert.deepEqual(
    { deviceId: card.deviceId, deviceName: card.deviceName, host: card.host, ask: card.ask },
    {
      deviceId: 'box',
      deviceName: 'dev-box',
      host: 'dev@box',
      ask: {
        kind: 'machine',
        action: 'exec',
        command: 'uname -a',
        cwd: null,
        path: null,
        copy: null,
        flagged: [],
      },
    },
  )
  assert.deepEqual(
    card.options.map((option) => option.role),
    ['accept', 'acceptSession', 'decline'],
  )
  assert.equal(card.expiresAt, world.time.clock.now() + MACHINE_ASK_EXPIRES_MS)
  assert.deepEqual(main.notices(), [
    {
      type: CLIENT_TOOL,
      op: 'notify',
      notice: {
        pendingId: card.id,
        deviceName: 'dev-box',
        host: 'dev@box',
        action: 'exec',
        summary: 'uname -a',
      },
    },
  ])
  await command('machine.answer', { pendingId: card.id, optionId: 'session' })
  assert.equal(textOf(await pending), 'ok')
  assert.deepEqual(activity.view?.pending, [])
  await assert.rejects(command('machine.answer', { pendingId: card.id, optionId: 'once' }), {
    code: 'notFound',
  })
  // “本会话都允许”在全局那里是“这台设备上找不到会话的调用都允许”
  assert.equal(textOf(await detached({ command: 'id' })), 'ok')

  // 会话在这台设备上找得到：卡片进那个会话，不进全局、不发通知
  const session = watchSession(world.core, 'a', 'box')
  const known = detached({ command: 'whoami' }, { threadId: 'a', harness: 'claude' })
  await settle()
  assert.equal(activity.view?.pending.length, 0)
  assert.equal(cardsOf(session).length, 1)
  assert.equal(main.notices().length, 1)
  await respond(world, cardsOf(session)[0], 'once')
  assert.equal(textOf(await known), 'ok')
  // 只认 litch_machine
  const other = await detached({}, { namespace: 'litch_browser', tool: 'tabs' })
  assert.match(textOf(other), /^\[litch:noExecutor\]/)
})

test('关开关的那一刻：进行中的调用回 disabled、两种卡片都撤掉、这台设备起的进程都结束、“本会话都允许”作废', async () => {
  const world = await started()
  const { call, detached, enable, command, fake, activity } = world
  await enable()
  const session = watchSession(world.core, 'a', 'box')
  // 先拿到“本会话都允许”
  const granted = call({ command: 'ls' })
  await settle()
  await respond(world, cardsOf(session)[0], 'session')
  await granted
  fake.start({
    id: 'p1',
    owner: { deviceId: 'box', threadId: 'a', harness: 'pi' },
    targetId: 'desktop',
    command: 'npm run dev',
    cwd: '/Users/song/app',
    startedAt: 5,
  })
  const inSession = call({ path: '/x' }, { tool: 'read_file' })
  const global = detached({ command: 'id' })
  await settle()
  assert.equal(cardsOf(session).length, 1)
  assert.equal(activity.view?.pending.length, 1)
  assert.equal(activity.view?.running.length, 1)

  await command('device.tools.set', { deviceId: 'box', machine: false })
  assert.match(textOf(await inSession), /^\[litch:disabled\] .*Operate this computer/)
  assert.match(textOf(await global), /^\[litch:disabled\]/)
  await settle()
  assert.equal(cardsOf(session).length, 0)
  assert.deepEqual(activity.view, { running: [], pending: [] })
  assert.deepEqual(fake.stopped, ['box'])
  assert.equal(world.box()?.machine?.enabled, false)

  // 再打开：之前的“本会话都允许”不算数了
  await enable()
  void call({ command: 'ls' })
  await settle()
  assert.equal(cardsOf(session).length, 1)
})

test('主题 machine：执行器的进程表带上设备名和会话，变了整份推；结束一个、全部停', async () => {
  const world = await started()
  const { fake, activity, command, enable, detached } = world
  await enable()
  assert.deepEqual(activity.view, { running: [], pending: [] })
  fake.start({
    id: 'p2',
    owner: { deviceId: 'box', threadId: null, harness: 'dsh' },
    targetId: 'desktop',
    command: 'make',
    cwd: '/Users/song',
    startedAt: 9,
  })
  assert.deepEqual(activity.view?.running, [
    {
      id: 'p2',
      deviceId: 'box',
      deviceName: 'dev-box',
      sessionId: null,
      harness: 'dsh',
      command: 'make',
      cwd: '/Users/song',
      startedAt: 9,
    },
  ])
  await command('machine.process.kill', { processId: 'p2' })
  assert.deepEqual(activity.view?.running, [])
  await assert.rejects(command('machine.process.kill', { processId: 'p2' }), { code: 'notFound' })

  const waiting = detached({ command: 'id' })
  await settle()
  assert.equal(activity.view?.pending.length, 1)
  await command('machine.stopAll', {})
  assert.match(textOf(await waiting), /^\[litch:declined\] cancelled/)
  assert.deepEqual(activity.view, { running: [], pending: [] })
  assert.deepEqual(fake.stopped, [undefined])
})

test('设备断开、连回来时告诉执行器（断开 10 分钟由执行器计）', async () => {
  const { remote, fake, time } = await started()
  assert.deepEqual(fake.presence, [['box', true]])
  remote.last().drop()
  await settle()
  assert.deepEqual(fake.presence.at(-1), ['box', false])
  time.advance(60_000)
  await settle()
  await settle()
  assert.deepEqual(fake.presence.at(-1), ['box', true])
})

test('设置：审批方式和访问范围存起来；第一次切到自定义从内置名单抄一份，之后给什么存什么（去空、去重）', async () => {
  const world = await started()
  const { command, box, enable, call, fake } = world
  await command('device.machine.set', { deviceId: 'box', access: { mode: 'custom' } })
  assert.deepEqual(box()?.machine?.access, { mode: 'custom', custom: [...SENSITIVE_PRESETS] })
  await command('device.machine.set', {
    deviceId: 'box',
    access: { mode: 'custom', custom: [' ~/secret ', '', '~/secret', '/opt/keys'] },
  })
  assert.deepEqual(box()?.machine?.access, { mode: 'custom', custom: ['~/secret', '/opt/keys'] })
  // 切走再切回来：自定义的那份还在
  await command('device.machine.set', { deviceId: 'box', access: { mode: 'open' } })
  await command('device.machine.set', { deviceId: 'box', access: { mode: 'custom' } })
  assert.deepEqual(box()?.machine?.access.custom, ['~/secret', '/opt/keys'])
  await assert.rejects(command('device.machine.set', { deviceId: 'box', approval: 'sometimes' }), {
    code: 'invalid',
  })
  // 交给执行器的访问范围按设置算
  await enable()
  await command('device.machine.set', { deviceId: 'box', approval: 'never' })
  await call({ command: 'ls' })
  assert.deepEqual(fake.seen.at(-1)?.context.policy, {
    mode: 'custom',
    denied: ['~/secret', '/opt/keys'],
  })
  await command('device.machine.set', { deviceId: 'box', access: { mode: 'open' } })
  await call({ command: 'ls' })
  assert.deepEqual(fake.seen.at(-1)?.context.policy, { mode: 'open', denied: [] })
})

test('操作记录：按设备存在外壳给的存储里，新的在前、条数有上限，能清空', async () => {
  const world = await started()
  const { command, enable, call, logs } = world
  await enable()
  await command('device.machine.set', { deviceId: 'box', approval: 'never' })
  for (let n = 0; n < 3; n++) await call({ command: `echo ${n}` })
  const { entries } = (await command('machine.log', { deviceId: 'box' })) as {
    entries: MachineLogEntry[]
  }
  assert.deepEqual(
    entries.map((entry) => entry.summary),
    ['echo 2', 'echo 1', 'echo 0'],
  )
  assert.equal((logs.get('box') as unknown[]).length, 3)
  await command('machine.log.clear', { deviceId: 'box' })
  assert.deepEqual((await command('machine.log', { deviceId: 'box' })) as object, { entries: [] })
  assert.deepEqual(logs.get('box'), [])
})

test('存下来的设置：本机没有“操作这台电脑”的开关；审批方式、访问范围不合规矩的那一项丢掉', () => {
  const target = { kind: 'host', host: 'box', port: null, user: 'dev', keyFile: null }
  const saved = checkSaved({
    remotes: [{ id: 'ssh-1', name: 'box', target, wire: 'orange' }],
    tools: { local: { machine: true, browser: false }, 'ssh-1': { machine: true } },
    machine: {
      'ssh-1': { approval: 'each', access: 'nowhere', custom: ['~/a', 3, '~/a', ' '] },
      gone: { approval: 'never' },
    },
  })
  assert.deepEqual(saved.tools, { local: { browser: false }, 'ssh-1': { machine: true } })
  assert.deepEqual(saved.machine, { 'ssh-1': { approval: 'each', custom: ['~/a'] } })
})
