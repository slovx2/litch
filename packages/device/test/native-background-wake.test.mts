import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { NATIVE_BACKGROUND_TOOLS } from '../../protocol/src/native-background-wake.mjs'
import type { EngineLink } from '../src/engine-link.mjs'
import { NativeBackgroundStore } from '../src/native-background-store.mjs'
import { NativeBackgroundWake } from '../src/native-background-wake.mjs'
import { openSessionDatabase, SessionStore } from '../src/session-store.mjs'
import { UpstreamRpcError } from '../src/wire.mjs'

const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
function fixture(startIntervalMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'native-wake-'))
  const db = openSessionDatabase(dir)
  const sessions = new SessionStore(db)
  const store = new NativeBackgroundStore(db)
  sessions.setTools('t', [NATIVE_BACKGROUND_TOOLS])
  const terminals = new Map<string, string>()
  const starts: any[] = []
  const steers: any[] = []
  let idle = true
  let fail = false
  let readHook: (() => void | Promise<void>) | undefined
  let steerHook: (() => void | Promise<void>) | undefined
  let allowed = true
  const wire = async (method: string, params: any): Promise<any> => {
    if (method === 'thread/backgroundTerminals/list')
      return { data: [...terminals].map(([itemId, processId]) => ({ itemId, processId })) }
    if (method === 'thread/read') {
      await readHook?.()
      return { thread: { status: { type: idle ? 'idle' : 'active' } } }
    }
    if (method === 'turn/start') {
      starts.push(params)
      if (fail) throw new Error('response lost')
      idle = false
      return { turn: { id: `wake-${starts.length}`, status: 'inProgress' } }
    }
    if (method === 'turn/steer') {
      steers.push(params)
      await steerHook?.()
      return { turnId: params.expectedTurnId }
    }
    return {}
  }
  const link = {
    native: true,
    request: (method: string, params: unknown) =>
      wake.request(method, params, (p) => wire(method, p)),
  } as EngineLink
  const wake = new NativeBackgroundWake({
    store,
    sessions,
    link: async () => link,
    watch: async () => {},
    canContinue: () => allowed,
    confirmIdle: async () => idle,
    changed: () => {},
    log: () => {},
    settleMs: 1,
    startIntervalMs,
  })
  const event = (method: string, params: Record<string, unknown>) =>
    wake.observe('codex', method, { threadId: 't', ...params })
  const command = (id: string, processId = id) => {
    terminals.set(id, processId)
    event('item/started', {
      turnId: 'original',
      item: {
        id,
        type: 'commandExecution',
        processId,
        command: 'finite job',
        status: 'inProgress',
      },
    })
  }
  const finish = (id: string, output = 'done') => {
    const processId = terminals.get(id) ?? id
    terminals.delete(id)
    event('item/completed', {
      turnId: 'original',
      item: {
        id,
        type: 'commandExecution',
        processId,
        command: 'finite job',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: output,
      },
    })
  }
  const tool = async (name: string, args: unknown) => {
    const result = await wake.tool({
      harness: 'codex',
      threadId: 't',
      turnId: 'original',
      callId: 'call',
      namespace: 'litch_background',
      tool: name,
      arguments: args,
    })
    return {
      result,
      value: result.success ? JSON.parse((result.contentItems[0] as { text: string }).text) : null,
    }
  }
  const watch = async (id: string) => {
    const answer = await tool('watch', { session_id: id, purpose: 'report test result' })
    assert.equal(answer.result.success, true)
    return answer.value.task_id as string
  }
  return {
    wake,
    store,
    sessions,
    starts,
    steers,
    command,
    finish,
    watch,
    tool,
    event,
    idle: (value: boolean) => {
      idle = value
    },
    fail: () => {
      fail = true
    },
    onRead: (hook: () => void | Promise<void>) => {
      readHook = hook
    },
    onSteer: (hook: () => void | Promise<void>) => {
      steerHook = hook
    },
    allowed: (value: boolean) => {
      allowed = value
    },
    close: () => {
      wake.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('NATIVE-WAKE-013 idle 查询期间回合结束重排检查，不丢失最后一次完成通知', async () => {
  const f = fixture()
  try {
    f.command('job')
    await f.watch('job')
    let reads = 0
    f.onRead(async () => {
      if (++reads !== 1) return
      f.wake.input('turn/start', { threadId: 't' }, true)
      // 旧批次的 epoch 已失效；此时新回合也结束了，必须在检查结束后再投递。
      f.event('turn/completed', { turn: { id: 'user', status: 'completed' } })
      await setImmediate()
    })
    f.finish('job')
    for (let i = 0; i < 50 && !f.starts.length; i++) await pause(10)
    assert.equal(f.starts.length, 1)
    assert.equal(f.store.list('t')[0]?.state, 'delivered')
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-014 活动回合立即插话，完成历史只标消息，不篡改用户回合来源', async () => {
  const f = fixture()
  try {
    f.event('turn/started', { turn: { id: 'original' } })
    f.command('job')
    await f.watch('job')
    const ended = Date.now()
    f.finish('job', 'background output')
    for (let i = 0; i < 50 && !f.steers.length; i++) await pause(10)
    assert.equal(f.steers.length, 1)
    assert.ok(Date.now() - ended < 1000, '活动回合不等待 turn/completed')
    assert.equal(f.starts.length, 0)
    assert.equal(f.store.list('t')[0]?.state, 'delivered')
    const steer = f.steers[0]
    assert.equal(steer.expectedTurnId, 'original')
    assert.match(steer.input[0].text, /^<litch-background-completed>.*background output/)
    const item = { id: 'native-id', clientId: steer.clientUserMessageId, type: 'userMessage' }
    const history: any = { data: [{ id: 'original', items: [{ ...item }] }] }
    f.wake.decorate('t', history)
    assert.equal(history.data[0].litchOrigin, undefined)
    assert.equal(history.data[0].items[0].litchOrigin, 'backgroundTask')
    const legacy: any = { item: { ...item } }
    f.wake.decorate('t', legacy, false)
    assert.equal(legacy.item.litchOrigin, undefined)
    f.finish('job')
    f.idle(true)
    f.event('turn/completed', { turn: { id: 'original', status: 'completed' } })
    await pause()
    assert.equal(f.steers.length + f.starts.length, 1)
    // 任务保留策略不能使历史消息失去来源凭据。
    f.store.recover()
    assert.equal(f.store.isInput('t', steer.clientUserMessageId), true)
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-018 活动回合超过一批的结果持续投递，不等当前回合结束', async () => {
  const f = fixture()
  try {
    f.event('turn/started', { turn: { id: 'original' } })
    for (let i = 0; i < 9; i++) {
      f.command(String(i))
      await f.watch(String(i))
    }
    for (let i = 0; i < 9; i++) f.finish(String(i))
    for (let i = 0; i < 50 && f.steers.length < 3; i++) await pause(10)
    assert.equal(f.steers.length, 3)
    assert.equal(f.starts.length, 0)
    assert.ok(f.store.list('t').every((task) => task.state === 'delivered'))
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-019 空闲查询撞上新回合开始，结果转为插话而不是等新回合结束', async () => {
  const f = fixture()
  try {
    f.command('job')
    await f.watch('job')
    let first = true
    f.onRead(() => {
      if (!first) return
      first = false
      f.wake.input('turn/start', { threadId: 't' }, true)
      f.event('turn/started', { turn: { id: 'user-new' } })
    })
    f.finish('job')
    for (let i = 0; i < 50 && !f.steers.length; i++) await pause(10)
    assert.equal(f.steers.length, 1)
    assert.equal(f.steers[0].expectedTurnId, 'user-new')
    assert.equal(f.starts.length, 0)
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-020 明确无活动回合且权威查询为空闲，结束通知迟到也能回退一次', async () => {
  const f = fixture()
  try {
    f.event('turn/started', { turn: { id: 'original' } })
    f.idle(false)
    f.command('job')
    await f.watch('job')
    f.onSteer(() => {
      f.idle(true)
      throw new UpstreamRpcError({ code: -32600, message: 'no active turn to steer' })
    })
    f.finish('job')
    for (let i = 0; i < 50 && !f.starts.length; i++) await pause(10)
    assert.equal(f.steers.length, 1)
    assert.equal(f.starts.length, 1)
    f.event('turn/completed', { turn: { id: 'original', status: 'completed' } })
    await pause()
    assert.equal(f.starts.length, 1)
    assert.equal(f.store.list('t')[0]?.state, 'delivered')
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-015 原生明确拒绝后仅回退空闲路径，同一批次不重复插话', async () => {
  for (const message of [
    'no active turn to steer',
    'expected active turn id `old` but found `new`',
    'cannot steer a compact turn',
    'cannot steer a review turn',
  ]) {
    const f = fixture()
    try {
      f.event('turn/started', { turn: { id: 'original' } })
      f.idle(false)
      f.command('job')
      await f.watch('job')
      f.onSteer(() => {
        throw new UpstreamRpcError({ code: -32600, message })
      })
      f.finish('job')
      await pause(50)
      assert.equal(f.steers.length, 1)
      assert.equal(f.starts.length, 0)
      assert.equal(f.store.list('t')[0]?.state, 'pending')
      f.wake.schedule('t')
      await pause()
      assert.equal(f.steers.length, 1)
      f.idle(true)
      f.event('turn/completed', { turn: { id: 'original', status: 'completed' } })
      await pause()
      assert.equal(f.starts.length, 1)
      const batch = f.steers[0].input[0].text.slice(
        '<litch-background-completed>'.length,
        -'</litch-background-completed>'.length,
      )
      assert.equal(f.starts[0].toolOutput.output, batch)
    } finally {
      f.close()
    }
  }
})

test('NATIVE-WAKE-016 插话应答撞上回合结束，成功只消费一次，明确拒绝只开一次空闲回合', async () => {
  for (const rejected of [false, true]) {
    const f = fixture()
    try {
      f.event('turn/started', { turn: { id: 'original' } })
      f.command('job')
      await f.watch('job')
      f.onSteer(async () => {
        f.idle(true)
        f.event('turn/completed', { turn: { id: 'original', status: 'completed' } })
        await setImmediate()
        if (rejected)
          throw new UpstreamRpcError({ code: -32600, message: 'no active turn to steer' })
      })
      f.finish('job')
      await pause(50)
      assert.equal(f.steers.length, 1)
      assert.equal(f.starts.length, rejected ? 1 : 0)
      assert.equal(f.store.list('t')[0]?.state, 'delivered')
    } finally {
      f.close()
    }
  }
})

test('NATIVE-WAKE-017 活动回合的停止、待答和不明投递仍保留保护边界', async () => {
  for (const mode of ['block', 'pending', 'unknown']) {
    const f = fixture()
    try {
      f.event('turn/started', { turn: { id: 'original' } })
      f.command('job')
      await f.watch('job')
      if (mode === 'block') f.wake.block('t')
      if (mode === 'pending') f.allowed(false)
      if (mode === 'unknown')
        f.onSteer(() => {
          throw new Error('response lost')
        })
      f.finish('job')
      await pause()
      assert.equal(f.steers.length, mode === 'unknown' ? 1 : 0)
      if (mode === 'pending') {
        f.allowed(true)
        f.wake.schedule('t')
        await pause()
        assert.equal(f.steers.length, 1)
      }
      f.idle(true)
      f.event('turn/completed', { turn: { id: 'original', status: 'completed' } })
      await pause()
      assert.equal(f.starts.length, 0)
      assert.equal(
        f.store.list('t')[0]?.state,
        mode === 'block' ? 'paused' : mode === 'unknown' ? 'unknown' : 'delivered',
      )
    } finally {
      f.close()
    }
  }
})

test('计划重启快照保留 watch 命令、目的和进程号，取消或用户停止的登记不纳入', async () => {
  const f = fixture()
  try {
    f.command('job', '123')
    const id = await f.watch('123')
    assert.match(
      f.wake.restartTasks('t')[0] ?? '',
      /litch_background.watch.*session_id=123.*command=finite job.*purpose=report test result/,
    )
    await f.tool('cancel', { task_id: id })
    assert.deepEqual(f.wake.restartTasks('t'), [])
    assert.deepEqual(
      f.wake.restartTasks('t', [
        {
          id: 'job',
          itemId: 'job',
          turnId: 'original',
          kind: 'shell',
          title: 'finite job',
          status: 'running',
        },
      ]),
      [],
    )
    f.command('next', '124')
    await f.watch('124')
    f.wake.block('t')
    assert.deepEqual(f.wake.restartTasks('t'), [])
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-011 原生 processId 重用按条目识别；登记等待中关闭设置不再登记', async () => {
  const f = fixture()
  try {
    f.command('old', '123')
    f.finish('old')
    f.command('new', '123')
    const id = await f.watch('123')
    assert.equal(f.store.list('t').find((task) => task.id === id)?.itemId, 'new')
    assert.equal(f.store.list('t')[0]?.state, 'watching')
    f.command('other')
    const registering = f.tool('watch', { session_id: 'other', purpose: 'read result' })
    f.wake.setEnabled('codex', false)
    assert.equal((await registering).result.success, false)
    assert.equal(f.store.list('t').length, 1)
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-012 连续完成按时间节流，不丢弃下一轮任务', async (t) => {
  // 整包并发运行会让真实 sleep 超过节流窗口；固定时钟验证边界而不依赖机器负载。
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 })
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms)
    await setImmediate()
  }
  const f = fixture(100)
  try {
    f.command('1')
    await f.watch('1')
    f.finish('1')
    await advance(1)
    assert.equal(f.starts.length, 1)
    f.command('2')
    await f.watch('2')
    f.finish('2')
    f.idle(true)
    f.event('turn/completed', { turn: { id: 'wake-1', status: 'completed' } })
    await advance(99)
    assert.equal(f.starts.length, 1)
    await advance(1)
    assert.equal(f.starts.length, 2)
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-010 Unicode 与控制字符转义后仍限制完成回报大小，读取明确标记截断', async () => {
  const f = fixture()
  try {
    f.idle(false)
    for (let i = 0; i < 4; i++) {
      const id = String(i)
      f.command(id)
      const watched = await f.tool('watch', {
        session_id: id,
        purpose: '测\u0001试'.repeat(300),
      })
      assert.equal(watched.result.success, true)
      f.finish(id, '\u0000'.repeat(64_000))
    }
    await pause()
    f.idle(true)
    f.wake.schedule('t')
    await pause()
    assert.equal(f.starts.length, 1)
    const encoded = f.starts[0].toolOutput.output
    assert.ok(Buffer.byteLength(encoded) <= 16_384)
    assert.equal(JSON.parse(encoded).events.length, 4)
    assert.ok(JSON.parse(encoded).events.every((event: any) => event.truncated))
    const task = f.store.list('t')[0]
    assert.ok(task)
    const read = await f.tool('read', { task_id: task.id, max_bytes: 2 })
    assert.equal(read.value.output.length, 2)
    assert.equal(read.value.truncated, true)
    assert.equal(read.value.outputMayBeTruncated, true)
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-001 仅显式登记的有限任务唤醒，合批、去重、原生工具输出与来源', async () => {
  const f = fixture()
  try {
    f.command('server')
    f.finish('server')
    await pause()
    assert.equal(f.starts.length, 0)
    f.command('1')
    f.command('2')
    await f.watch('1')
    await f.watch('2')
    f.finish('1', 'a'.repeat(70_000))
    f.finish('1')
    f.finish('2')
    await pause()
    assert.equal(f.starts.length, 1)
    const params = f.starts[0]
    assert.equal(params.__litchWakeEpoch, undefined)
    assert.equal(params.toolOutput.namespace, 'litch_background')
    assert.deepEqual(params.input, [])
    const output = JSON.parse(params.toolOutput.output)
    assert.equal(output.events.length, 2)
    assert.ok(Buffer.byteLength(params.toolOutput.output) < 16_384)
    assert.equal(output.events[0].truncated, true)
    assert.ok(f.store.isWake('t', 'wake-1'))
    assert.ok(f.store.list('t').every((t) => t.state === 'delivered'))
    f.finish('2')
    await pause()
    assert.equal(f.starts.length, 1)
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-002 停止后任务可结束但不续跑；待发消息不解除，明确发送才解除', async () => {
  const f = fixture()
  try {
    f.command('1')
    await f.watch('1')
    f.wake.input('turn/interrupt', { threadId: 't' }, true)
    f.finish('1')
    await pause()
    assert.equal(f.starts.length, 0)
    assert.equal(f.store.list('t')[0]?.state, 'paused')
    f.wake.input('thread/queue/add', { threadId: 't' }, true)
    await pause()
    assert.equal(f.starts.length, 0)
    f.wake.input('turn/start', { threadId: 't' }, true)
    f.event('turn/completed', { turn: { id: 'user', status: 'completed' } })
    await pause()
    assert.equal(f.starts.length, 1)
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-003 idle 查询窗口内收到停止或用户输入不会提交旧批次', async () => {
  for (const method of ['turn/interrupt', 'turn/start']) {
    const f = fixture()
    try {
      f.command('1')
      await f.watch('1')
      f.onRead(() => f.wake.input(method, { threadId: 't' }, true))
      f.finish('1')
      await pause()
      assert.equal(f.starts.length, 0)
    } finally {
      f.close()
    }
  }
})

test('NATIVE-WAKE-004 结果投递超时不重试，原生重启及设备重启不续跑', async () => {
  const f = fixture()
  try {
    f.command('1')
    await f.watch('1')
    f.fail()
    f.finish('1')
    await pause()
    assert.equal(f.store.list('t')[0]?.state, 'unknown')
    f.event('turn/completed', { turn: { id: 'user', status: 'completed' } })
    await pause()
    assert.equal(f.starts.length, 1)
    f.command('2')
    await f.watch('2')
    f.wake.disconnected('codex')
    assert.equal(f.store.list('t')[1]?.state, 'lost')
    f.finish('2')
    await pause()
    assert.equal(f.starts.length, 1)
    f.store.recover()
    assert.ok(
      f.store
        .list('t')
        .every((t) => !['watching', 'pending', 'paused', 'unknown'].includes(t.state)),
    )
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-005 已完成、读取消费、取消登记和用户停任务均不额外唤醒', async () => {
  const f = fixture()
  try {
    f.command('1')
    f.finish('1')
    const done = await f.tool('watch', { session_id: '1', purpose: 'result' })
    assert.equal(done.value.state, 'completed')
    f.command('2')
    const id = await f.watch('2')
    f.finish('2')
    await f.tool('read', { task_id: id })
    f.command('3')
    const cancelled = await f.watch('3')
    await f.tool('cancel', { task_id: cancelled })
    assert.equal(
      f.wake.decorateBackground('t', null)?.tasks.find((task) => task.itemId === '3')?.status,
      'running',
      '取消登记不代表原生命令已停止',
    )
    f.finish('3')
    f.command('4')
    await f.watch('4')
    f.wake.input('thread/backgroundTerminals/terminate', { threadId: 't', processId: '4' }, true)
    f.finish('4')
    await pause()
    assert.equal(f.starts.length, 0)
    assert.equal(
      (await f.tool('watch', { session_id: 'foreign', purpose: 'result' })).result.success,
      false,
    )
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-006 默认新建注入、关闭不注入、临时/恢复不注入，工具登记权限不能靠入参伪造', async () => {
  const f = fixture()
  try {
    assert.ok(Array.isArray(f.wake.prepare('codex', 'thread/start', {}).dynamicTools))
    assert.deepEqual(f.wake.prepare('codex', 'thread/start', { ephemeral: true }), {
      ephemeral: true,
    })
    assert.deepEqual(f.wake.prepare('codex', 'thread/resume', {}), {})
    f.wake.setEnabled('codex', false)
    assert.deepEqual(f.wake.prepare('codex', 'thread/start', {}), {})
    f.command('1')
    assert.equal(
      (await f.tool('watch', { session_id: '1', purpose: 'result' })).result.success,
      false,
    )
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-007 用户预约阻塞后台，超过五次仍能接续且不重置原生权限', async () => {
  const f = fixture()
  try {
    const release = await f.wake.acquire('t')
    f.command('0')
    await f.watch('0')
    f.finish('0')
    await pause()
    assert.equal(f.starts.length, 0)
    release()
    await pause()
    for (let i = 1; i < 7; i++) {
      f.idle(true)
      f.event('turn/completed', { turn: { id: `wake-${i}`, status: 'completed' } })
      f.command(String(i))
      await f.watch(String(i))
      f.finish(String(i))
      await pause()
    }
    assert.equal(f.starts.length, 7)
    assert.ok(
      f.starts.every(
        (p) =>
          p.permissions === undefined &&
          p.sandboxPolicy === undefined &&
          p.approvalPolicy === undefined,
      ),
    )
  } finally {
    f.close()
  }
})

test('NATIVE-WAKE-008 idle 查询期间结果被读取或功能关闭，批次不再发送', async () => {
  for (const cancel of [false, true]) {
    const f = fixture()
    try {
      f.command('1')
      const id = await f.watch('1')
      f.onRead(() => {
        if (cancel) f.wake.setEnabled('codex', false)
        else void f.tool('read', { task_id: id })
      })
      f.finish('1')
      await pause()
      assert.equal(f.starts.length, 0)
    } finally {
      f.close()
    }
  }
})

test('NATIVE-WAKE-009 多批完成不丢事件；迟到的 turn/started 不重置已完成回合', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 9; i++) {
      f.command(String(i))
      await f.watch(String(i))
    }
    for (let i = 0; i < 9; i++) f.finish(String(i))
    await pause()
    assert.equal(f.starts.length, 1)
    for (let i = 1; i < 3; i++) {
      f.idle(true)
      f.event('turn/completed', { turn: { id: `wake-${i}`, status: 'completed' } })
      f.event('turn/started', { turn: { id: `wake-${i}`, status: 'inProgress' } })
      await pause()
    }
    assert.equal(f.starts.length + f.steers.length, 3)
    const batches = [
      ...f.starts.map((p) => p.toolOutput.output),
      ...f.steers.map((p) =>
        p.input[0].text.slice(
          '<litch-background-completed>'.length,
          -'</litch-background-completed>'.length,
        ),
      ),
    ]
    const ids = batches.flatMap((batch) => JSON.parse(batch).events.map((e: any) => e.taskId))
    assert.equal(new Set(ids).size, 9)
    assert.equal(ids.length, 9)
  } finally {
    f.close()
  }
})
