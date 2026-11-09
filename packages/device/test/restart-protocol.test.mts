import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSystemMessage } from '../../protocol/src/system-messages.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread, FakeCodex } from './fake-codex.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig, settle } from './helpers.mjs'

function control(pid: number, harness = 'pi'): FakeControl {
  const value = new FakeControl([{ ...managed(harness), native: harness === 'codex' }])
  value.service = {
    pid,
    startedAt: `start-${pid}`,
    version: '9.9.9',
    root: '/isolated',
    detached: true,
  }
  value.push()
  return value
}

test('Codex watch：真实设备控制链保存登记，换代后只发一次核对回合，不重新登记旧进程', async () => {
  const fake = new FakeCodex()
  fake.cliVersion = '0.163.0'
  const turns: { id: string; status: string; items: unknown[] }[] = []
  const stored = codexThread(99, 400, { status: { type: 'idle' }, turns })
  fake.threads.push(stored)
  fake.handlers['thread/start'] = () => ({ thread: stored })
  fake.handlers['thread/goal/get'] = () => ({ goal: null })
  fake.handlers['thread/queue/list'] = () => ({ data: [] })
  fake.handlers['thread/read'] = (params) => ({
    thread: { ...stored, turns: params.includeTurns ? turns : [] },
  })
  const original = { id: 'original', status: 'inProgress', items: [] }
  fake.handlers['turn/start'] = () => {
    const turn = turns.length ? { id: 'restored', status: 'inProgress', items: [] } : original
    turns.push(turn)
    return { turn }
  }
  fake.handlers['thread/backgroundTerminals/list'] = () => ({
    data: [{ itemId: 'cmd', processId: '123' }],
  })
  const ctl = control(1, 'codex')
  let env = codexRig({ fake, device: { control: ctl, wrapUpReminder: false } })
  try {
    const client = env.connect()
    await client.initialize(['harness', 'backgroundTasks', 'nativeBackgroundWake'])
    const { thread } = await client.call('thread/start', { harness: 'codex', cwd: env.stateDir })
    await client.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '监听一次消息' }],
    })
    fake.notify('item/started', {
      threadId: thread.id,
      turnId: 'original',
      item: {
        type: 'commandExecution',
        id: 'cmd',
        command: 'watch --once',
        processId: '123',
        status: 'inProgress',
      },
    })
    await settle()
    const watch = await env.device.nativeBackground.tool({
      harness: 'codex',
      threadId: thread.id,
      turnId: 'original',
      callId: 'watch-original',
      namespace: 'litch_background',
      tool: 'watch',
      arguments: { session_id: '123', purpose: '收到消息后核对结果' },
    })
    assert.equal(watch.success, true)
    original.status = 'completed'
    fake.notify('turn/completed', { threadId: thread.id, turn: original })
    await settle()
    assert.deepEqual(await ctl.onAsk?.('restart.prepare'), { prepared: 1 }, env.logs.join('\n'))
    assert.equal(sentTo(fake, 'turn/interrupt').length, 0)
    await env.device.close()
    env = codexRig({
      fake,
      device: { stateDir: env.stateDir, control: control(2, 'codex'), wrapUpReminder: false },
    })
    for (let attempt = 0; attempt < 100 && sentTo(fake, 'turn/start').length !== 2; attempt++)
      await settle()
    const starts = sentTo(fake, 'turn/start')
    assert.equal(starts.length, 2)
    assert.match(
      starts[1].input[0].text,
      /litch_background.watch.*session_id=123.*watch --once.*收到消息后核对结果/,
    )
    assert.deepEqual(env.device.nativeBackground.restartTasks(thread.id), [])
    await env.device.restart.recover()
    assert.equal(sentTo(fake, 'turn/start').length, 2)
  } finally {
    await env.close()
  }
})

for (const harness of ['claude-code', 'pi', 'opencode', 'acp', 'dsh', 'agy']) {
  test(`${harness} 空闲后台会话：设备换代后恢复一次且保留原 completed 回合`, async () => {
    const engine = new FakeEngine(harness)
    const ctl = control(1, harness)
    let env = rig({ [harness]: engine }, {}, { control: ctl, wrapUpReminder: false })
    try {
      const client = env.connect()
      await client.initialize()
      const { thread } = await client.call('thread/start', { harness, cwd: env.stateDir })
      await client.call('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '看护任务' }],
      })
      engine.notify('litch/thread/background/changed', {
        threadId: thread.id,
        tasks: [{ id: 'monitor', kind: 'monitor', title: 'watch --events', status: 'running' }],
        wakesOnFinish: true,
      })
      engine.end(thread.id, 'completed', '后台继续看护')
      await settle()
      assert.deepEqual(await ctl.onAsk?.('restart.prepare'), { prepared: 1 })
      assert.equal(
        engine.seen.some((frame) => frame.method === 'turn/interrupt'),
        false,
      )
      await env.device.close()
      env = rig(
        { [harness]: engine },
        {},
        { stateDir: env.stateDir, control: control(2, harness), wrapUpReminder: false },
      )
      for (let attempt = 0; attempt < 100 && engine.turns.get(thread.id)?.length !== 2; attempt++)
        await settle()
      const turns = engine.turns.get(thread.id) ?? []
      assert.equal(turns.length, 2)
      assert.equal(turns[0]?.status, 'completed')
      const sent = engine.seen.filter((frame) => frame.method === 'turn/start')
      assert.match(sent[1]?.params.input[0].text, /monitor monitor: watch --events/)
      await env.device.restart.recover()
      assert.equal(engine.seen.filter((frame) => frame.method === 'turn/start').length, 2)
    } finally {
      await env.close()
    }
  })
}

test('恢复占用时订阅和插话返回明确的暂态标记，释放后原会话仍能订阅', async () => {
  const engine = new FakeEngine('pi')
  const ctl = control(1)
  const env = rig({ pi: engine }, {}, { control: ctl, wrapUpReminder: false })
  try {
    const client = env.connect()
    await client.initialize()
    const { thread } = await client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    await ctl.onAsk?.('restart.prepare')
    for (const method of ['thread/resume', 'turn/steer']) {
      await assert.rejects(client.call(method, { threadId: thread.id }), {
        code: -32051,
        data: { litch: 'sessionRecovering', method, harness: 'pi', threadId: thread.id },
      })
    }
    env.device.restart.release()
    assert.equal((await client.call('thread/resume', { threadId: thread.id })).thread.id, thread.id)
  } finally {
    await env.close()
  }
})

for (const harness of ['pi', 'claude-code']) {
  test(`${harness} 设备协议：重启后先按新开关恢复工具，再在原线程发送一次标准文本`, async () => {
    const engine = new FakeEngine(harness)
    const oldControl = control(1, harness)
    oldControl.patch({ values: { 'tools.machine': false } as never })
    let env = rig({ [harness]: engine }, {}, { control: oldControl, wrapUpReminder: false })
    try {
      const client = env.connect()
      await client.initialize()
      const { thread } = await client.call('thread/start', { harness, cwd: env.stateDir })
      const { turn } = await client.call('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '原任务' }],
      })
      env.device.background.reportedChanged({
        threadId: thread.id,
        tasks: [
          { id: 'job-1', kind: 'command', title: 'sleep 120', status: 'running' },
          { id: 'job-2', kind: 'command', title: 'npm run dev', status: 'running' },
        ],
      })
      assert.deepEqual(await oldControl.onAsk?.('restart.prepare'), { prepared: 1 })
      assert.equal(engine.turns.get(thread.id)?.[0]?.status, 'interrupted')
      await env.device.close()
      const newControl = control(2, harness)
      newControl.patch({ values: { 'tools.machine': true } as never })
      env = rig(
        { [harness]: engine },
        {},
        { stateDir: env.stateDir, control: newControl, wrapUpReminder: false },
      )
      for (let attempt = 0; attempt < 100 && engine.turns.get(thread.id)?.length !== 2; attempt++)
        await settle()
      const turns = engine.turns.get(thread.id) ?? []
      assert.equal(turns.length, 2)
      assert.equal(turns[0]?.id, turn.id)
      assert.ok(
        env.device.sessionTree.store
          .tools(thread.id)
          ?.some((tool: any) => tool.name === 'litch_machine'),
      )
      const resumed = engine.seen.findLast((frame) => frame.method === 'thread/resume')
      assert.ok(resumed?.params.dynamicTools.some((tool: any) => tool.name === 'litch_machine'))
      const sent = engine.seen.filter((frame) => frame.method === 'turn/start')
      assert.equal(sent.length, 2)
      const input = sent[1]?.params
      assert.deepEqual(Object.keys(input).sort(), ['input', 'threadId'])
      assert.equal(parseSystemMessage(input.input[0].text)?.kind, 'restart')
      assert.match(input.input[0].text, /sleep 120/)
      assert.match(input.input[0].text, /npm run dev/)
      await env.device.restart.recover()
      assert.equal(engine.seen.filter((frame) => frame.method === 'turn/start').length, 2)
    } finally {
      await env.close()
    }
  })
}

test('设备协议：客户端停止撤销资格，普通停止也不会留下恢复票', async () => {
  const engine = new FakeEngine('pi')
  const ctl = control(1)
  const env = rig({ pi: engine }, {}, { control: ctl, wrapUpReminder: false })
  try {
    const client = env.connect()
    await client.initialize()
    const { thread } = await client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    const { turn } = await client.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '原任务' }],
    })
    await client.call('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    assert.deepEqual(await ctl.onAsk?.('restart.prepare'), { prepared: 0 })
    await ctl.onAsk?.('restart.cancel')
  } finally {
    await env.close()
  }
})

test('真实内部连接在异步配额等待后再检查停止，撤票后没有恢复 turn/start', async () => {
  const engine = new FakeEngine('pi')
  const ctl = control(1)
  const env = rig({ pi: engine }, {}, { control: ctl, wrapUpReminder: false })
  let release = () => {}
  try {
    const client = env.connect()
    await client.initialize()
    const { thread } = await client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    await client.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '原任务' }],
    })
    await ctl.onAsk?.('restart.prepare')
    let arrived = () => {}
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = env.device.managers.lines.reserve.bind(env.device.managers.lines)
    env.device.managers.lines.reserve = async (...args) => {
      arrived()
      await gate
      return original(...args)
    }
    const recovery = env.device.restart.recover('pi')
    await waiting
    // 用户的停止在内部请求获得配额前到达；即使目标旧回合已结束，撤销也必须先发生。
    await client.call('turn/interrupt', { threadId: thread.id }).catch(() => {})
    release()
    await recovery
    assert.equal(engine.seen.filter((frame) => frame.method === 'turn/start').length, 1)
  } finally {
    release()
    await env.close()
  }
})

test('内部派出的子会话持久登记，重启只续一次，最终结果回报父会话', async () => {
  const engine = new FakeEngine('claude-code')
  const ctl = control(1, 'claude-code')
  let env = rig({ 'claude-code': engine }, {}, { control: ctl, wrapUpReminder: false })
  try {
    const client = env.connect()
    await client.initialize(['harness', 'sessionTree'])
    const { thread: parent } = await client.call('thread/start', {
      harness: 'claude-code',
      cwd: env.stateDir,
    })
    const { threadId: child } = await client.call('litch/session/start', {
      parentThreadId: parent.id,
      kind: 'fresh',
      title: '可恢复的子会话',
      prompt: '继续任务',
      wakeParent: true,
    })
    assert.deepEqual(await ctl.onAsk?.('restart.prepare'), { prepared: 1 })
    assert.equal(
      env.device.sessionTree.store.notes(parent.id).length,
      0,
      '计划中断不作为子会话完成回报',
    )
    await env.device.close()
    env = rig(
      { 'claude-code': engine },
      {},
      { stateDir: env.stateDir, control: control(2, 'claude-code'), wrapUpReminder: false },
    )
    for (let i = 0; i < 100 && engine.turns.get(child)?.length !== 2; i++) await settle()
    assert.equal(engine.turns.get(child)?.length, 2)
    const turn = engine.turns.get(child)?.at(-1)
    assert.ok(turn)
    engine.end(child, 'completed', '子会话恢复完成')
    for (let i = 0; i < 100 && !env.device.sessionTree.store.notes(parent.id).length; i++)
      await settle()
    assert.ok(env.device.sessionTree.store.notes(parent.id).some((n) => n.threadId === child))
    await env.device.restart.recover()
    assert.equal(engine.turns.get(child)?.length, 2)
  } finally {
    await env.close()
  }
})

test('内部连接显式停止撤销子会话资格；未标记的定时任务不登记', async () => {
  const engine = new FakeEngine('pi')
  const ctl = control(1)
  const env = rig({ pi: engine }, {}, { control: ctl, wrapUpReminder: false })
  try {
    const link = await env.device.openEngineLink('pi')
    const { thread } = await link.request('thread/start', { cwd: env.stateDir })
    const { turn } = await link.request(
      'turn/start',
      { threadId: thread.id, input: [] },
      { restartable: true },
    )
    await link.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    await link.request('turn/start', { threadId: thread.id, input: [] })
    assert.deepEqual(await ctl.onAsk?.('restart.prepare'), { prepared: 0 })
  } finally {
    await env.close()
  }
})

for (const status of ['active', 'paused', 'ending', 'ended', 'resetting'] as const) {
  test(`经理恢复遵守状态：${status}；收尾与暂停不会被重启唤醒`, async () => {
    const engine = new FakeEngine('claude-code')
    const ctl = control(1, 'claude-code')
    const env = rig({ 'claude-code': engine }, {}, { control: ctl, wrapUpReminder: false })
    try {
      const client = env.connect()
      await client.initialize(['harness', 'litchManager'])
      const { manager, threadId } = await client.call('litch/manager/create', {
        cwd: env.stateDir,
        harness: 'claude-code',
        model: null,
        effort: null,
        name: '重启经理',
        scope: '',
        rules: '',
        firstTask: '',
        template: 'blank',
        permission: null,
        dispatch: {
          harness: 'claude-code',
          model: null,
          effort: null,
          worktree: false,
          merge: 'manager',
          maxRunningLines: 4,
        },
        contact: { desktopNotification: false, unanswered: 'wait' },
      })
      // 直接使用与经理持久事件相同的内部连接；不把 ending 的收尾事件算新授权。
      const link = await env.device.openEngineLink('claude-code')
      if (engine.current(threadId)) engine.end(threadId)
      await link.request(
        'turn/start',
        { threadId, input: [{ type: 'text', text: '原任务' }] },
        { restartable: true },
      )
      env.device.managers.store.saveManager({
        ...manager,
        status: status === 'resetting' ? 'active' : status,
      })
      if (status === 'resetting')
        env.device.managers.store.saveReset({
          managerId: manager.id,
          oldThreadId: threadId,
          applied: null,
          phase: 'waiting',
        })
      assert.deepEqual(await ctl.onAsk?.('restart.prepare'), {
        prepared: status === 'active' ? 1 : 0,
      })
    } finally {
      await env.close()
    }
  })
}

test('经理事件已等配额时开始重启，排队请求不能越过准备屏障', async () => {
  const engine = new FakeEngine('pi')
  const ctl = control(1)
  const env = rig({ pi: engine }, {}, { control: ctl, wrapUpReminder: false })
  let release = () => {}
  try {
    const link = await env.device.openEngineLink('pi')
    const { thread } = await link.request('thread/start', { cwd: env.stateDir })
    let arrived = () => {}
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reserve = env.device.managers.lines.reserve.bind(env.device.managers.lines)
    env.device.managers.lines.reserve = async (...args) => {
      arrived()
      await gate
      return reserve(...args)
    }
    const sending = link.request(
      'turn/start',
      { threadId: thread.id, input: [] },
      { restartable: true },
    )
    const rejected = assert.rejects(sending, /设备正在准备重启/)
    await waiting
    await ctl.onAsk?.('restart.prepare')
    release()
    await rejected
    assert.equal(engine.sent('turn/start').length, 0)
  } finally {
    release()
    await env.close()
  }
})
