import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import {
  DEFAULT_MANAGER_IDLE_COMPACT,
  IDLE_COMPACT_READ,
  type IdleCompactSnapshot,
  type ManagerIdleCompactSettings,
} from '../../protocol/src/manager-idle-compact.mjs'
import { startChild } from '../src/session-start.mjs'
import { treeRig, until } from './tree-kit.mjs'

const minute = 60_000
const rules = '规则夹具：保留固定说明和外部工具。'

async function setup() {
  let now = Date.now()
  let queued = false
  let engineBusy = false
  let attempts = 0
  const logs: string[] = []
  const env = treeRig(
    {},
    {
      managerIdleCompactClock: () => now,
      external: {},
      log: (line) => logs.push(line),
    },
  )
  const client = env.connect()
  const { managers, sessionTree: tree, external } = env.device
  assert.ok(external)
  const { claude } = env
  await client.initialize(['harness', 'litchManager', 'sessionTree'])
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'claude-code',
    model: null,
    effort: null,
    name: '压缩经理',
    scope: '',
    rules,
    template: 'blank',
    firstTask: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, harness: 'pi' },
    contact: MANAGER_DEFAULT_CONTACT,
  })
  await until(() => claude.running(threadId), '经理开场')
  const end = claude.end(threadId)
  await until(() => !tree.isActive(threadId), '经理闲置')
  const sample: IdleCompactSnapshot = {
    idle: true,
    lastTurnId: end.id,
    lastTurnActivityAt: now,
    usageTurnId: end.id,
    usedTokens: 80_000,
    windowTokens: 100_000,
  }
  claude.handlers[IDLE_COMPACT_READ] = () => ({
    ...sample,
    idle: !queued && !engineBusy && !claude.running(threadId),
  })
  claude.handlers['thread/compact/start'] = (params) => {
    assert.deepEqual(params.litchIdleCompact, { ...sample, idle: true })
    attempts++
    const turn = claude.selfTurn(threadId)
    turn.items.push({ type: 'contextCompaction', id: `compact-${attempts}` })
    return { turnId: turn.id }
  }
  function assign() {
    external!.store.config.saveAssignment(
      { managerId: manager.id, identityId: 'identity', repoIds: ['r1'] },
      0,
      'idle-compact-assignment',
      () => {},
    )
  }
  return {
    env,
    client,
    claude,
    tree,
    external,
    managers,
    sample,
    threadId,
    id: manager.id as string,
    logs,
    assign,
    now: () => now,
    advance: (ms: number) => (now += ms),
    queued: (value: boolean) => (queued = value),
    engineBusy: (value: boolean) => (engineBusy = value),
    attempts: () => attempts,
    config: (idleCompact: ManagerIdleCompactSettings) =>
      client.call(MANAGER_METHOD.update, { managerId: manager.id, idleCompact }),
    scan: async () => {
      managers.idleCompact.tick(manager.id)
      await tree.settleIdleCompacts()
    },
    start: () => managers.idleCompact.tick(manager.id),
    finish(status: 'completed' | 'failed', after: number | null) {
      const turn = claude.current(threadId)
      assert.ok(turn)
      if (after !== null) {
        sample.usedTokens = after
        sample.usageTurnId = turn.id
      }
      claude.end(threadId, status)
    },
  }
}

test('按严格阈值和最后活动判断；无分配、用量未知、引擎队列、待投递和活动回合均不压缩', async () => {
  const f = await setup()
  try {
    assert.deepEqual(f.managers.manager(f.id).idleCompact, DEFAULT_MANAGER_IDLE_COMPACT)
    f.advance(50 * minute - 1)
    await f.scan()
    f.assign()
    await f.scan()
    assert.equal(f.attempts(), 0)
    f.advance(1)
    f.sample.usedTokens = 70_000
    await f.scan()
    await f.scan()
    assert.equal(f.logs.filter((line) => line.includes('"reason":"belowThreshold"')).length, 1)
    f.sample.usedTokens = null
    await f.scan()
    f.sample.usedTokens = 80_000
    f.queued(true)
    await f.scan()
    f.queued(false)
    const waiting = f.external.store.queue.queueDeliveryGroup({
      groupId: 'queued-external',
      sourceId: 'fixture',
      managerId: f.id,
      subjectKey: 'r1/1',
      eventKeys: ['note-fixture'],
      availableAt: f.now() / 1_000,
    })
    await f.scan()
    assert.ok(f.logs.some((line) => line.includes('"reason":"externalDeliveryPending"')))
    f.external.store.queue.finishDelivery(waiting.groupId, 'blocked', f.now() / 1_000)
    const queuedManager = f.managers.store.enqueue(f.id, '待投递事件夹具')
    await f.scan()
    f.managers.store.delivered(queuedManager)
    f.claude.selfTurn(f.threadId)
    await f.scan()
    assert.equal(f.attempts(), 0)
    const ended = f.claude.end(f.threadId)
    f.sample.lastTurnId = ended.id
    f.sample.lastTurnActivityAt = f.now()
    await until(() => !f.tree.isActive(f.threadId), '普通回合结束')
    f.advance(50 * minute)
    f.start()
    await until(() => f.attempts() === 1, '达标后进入原生压缩')
    f.finish('completed', 78_000)
    await f.tree.settleIdleCompacts()
    assert.deepEqual(f.managers.manager(f.id).idleCompactLast, {
      at: f.now(),
      before: 80,
      after: 78,
    })
    assert.ok(f.logs.some((line) => line.includes('manager.idleCompact.completed')))
    f.advance(120 * minute)
    await f.scan()
    assert.equal(f.attempts(), 1, '仍超过阈值也不在同一轮反复压缩')
  } finally {
    await f.env.close()
  }
})

test('改阈值立即生效；关闭不运行；失败留日志并在同一轮不重试', async () => {
  const f = await setup()
  try {
    f.assign()
    f.advance(10 * minute)
    await f.config({ enabled: false, idleMinutes: 5, contextPercent: 75 })
    await f.scan()
    assert.equal(f.attempts(), 0)
    const invalid = await f.client.fails(MANAGER_METHOD.update, {
      managerId: f.id,
      idleCompact: { enabled: true, idleMinutes: 4, contextPercent: 75 },
    })
    assert.equal(invalid.data.field, 'idleCompact.idleMinutes')
    await f.config({ enabled: true, idleMinutes: 5, contextPercent: 90 })
    await f.tree.settleIdleCompacts()
    assert.equal(f.attempts(), 0)
    await f.config({ enabled: true, idleMinutes: 5, contextPercent: 75 })
    await until(() => f.attempts() === 1, '保存后当即按新阈值压缩')
    f.finish('failed', null)
    await f.tree.settleIdleCompacts()
    assert.ok(f.logs.some((line) => line.includes('manager.idleCompact.failed')))
    assert.equal(f.managers.manager(f.id).idleCompactLast, undefined)
    f.advance(60 * minute)
    await f.scan()
    assert.equal(f.attempts(), 1)
    // 任一普通回合结束才开启新的空闲计时；此处模拟引擎主动回合。
    f.claude.selfTurn(f.threadId)
    const ended = f.claude.end(f.threadId)
    f.sample.lastTurnId = ended.id
    f.sample.lastTurnActivityAt = f.now()
    await until(() => !f.tree.isActive(f.threadId), '普通回合结束')
    await f.scan()
    assert.equal(f.attempts(), 1)
    f.advance(5 * minute)
    f.start()
    await until(() => f.attempts() === 2, '新活动后允许再压缩')
    f.finish('completed', null)
    await f.tree.settleIdleCompacts()
    assert.equal(f.managers.manager(f.id).idleCompactLast?.after, null)
  } finally {
    await f.env.close()
  }
})

test('开始与结束都重置计时；漏掉事件时仍以引擎的实时忙闲为准', async () => {
  const f = await setup()
  try {
    f.assign()
    f.advance(51 * minute)
    f.engineBusy(true)
    assert.equal(f.tree.isActive(f.threadId), false, '设备没有收到开始事件')
    await f.scan()
    assert.equal(f.attempts(), 0, '引擎实时忙，不能压缩')
    f.engineBusy(false)

    const missed = f.claude.selfTurn(f.threadId)
    await until(() => f.tree.isActive(f.threadId), '只收到回合开始')
    missed.status = 'interrupted' // 引擎不再运行，但没有结束通知到设备。
    f.advance(40 * minute)
    await f.scan()
    assert.equal(f.attempts(), 0, '仅开始也会重置，即便读取的活动快照暂时还是上一轮')

    const both = f.claude.selfTurn(f.threadId)
    await until(() => f.tree.activeTurn(f.threadId) === both.id, '新回合开始')
    f.advance(35 * minute)
    f.claude.end(f.threadId)
    await until(() => !f.tree.isActive(f.threadId), '同时收到结束')
    f.sample.lastTurnId = both.id
    f.sample.lastTurnActivityAt = f.now()
    f.advance(30 * minute)
    await f.scan()
    assert.equal(f.attempts(), 0, '距开始已有 65 分钟，距结束只有 30 分钟')
    f.advance(20 * minute)
    f.start()
    await until(() => f.attempts() === 1, '结束后满 50 分钟')
    f.finish('completed', 25_000)
    await f.tree.settleIdleCompacts()
  } finally {
    await f.env.close()
  }
})

test('压缩期间外部事件和工作线回报等到压缩完成；经理固定说明、外部工具与已安装指纹保留', async () => {
  const f = await setup()
  try {
    f.assign()
    const before = f.managers.store.manager(f.id)!
    const tools = structuredClone(f.tree.store.tools(f.threadId))
    const installed = structuredClone(f.claude.thread(f.threadId).dynamicTools)
    const applied = f.managers.store.reset(f.id)?.applied
    assert.match(JSON.stringify(tools), /external_write/)
    assert.match(JSON.stringify(installed), /保留固定说明/)
    assert.ok(applied)
    assert.equal(f.managers.externalReady(before).ready, true)
    const line = await startChild(
      f.tree,
      f.threadId,
      {
        kind: 'fresh',
        title: '并行工作线',
        prompt: '跑一项工作',
        worktree: false,
        wakeParent: true,
      },
      'model',
    )
    f.advance(51 * minute)
    f.start()
    await until(() => f.attempts() === 1, '进入压缩')
    assert.equal(f.tree.canDeliverExternal(f.threadId), false)
    let sent = false
    const external = f.tree
      .deliverManagerEvent(f.threadId, '外部待投递提醒', 'external-fixture', {
        automatic: true,
        external: { beforeSend: () => f.tree.canDeliverExternal(f.threadId) },
      })
      .then((result) => {
        sent = result
      })
    await until(() => f.env.pi.running(line.threadId), '工作线启动')
    f.env.pi.end(line.threadId, 'completed', '工作线的回报夹具')
    await until(() => f.tree.store.notes(f.threadId).length > 0, '回报留在持久队列')
    assert.equal(sent, false)
    assert.deepEqual(
      f.claude.current(f.threadId)?.items.map(({ type }) => type),
      ['contextCompaction'],
    )
    f.finish('completed', 25_000)
    await external
    await until(() => sent && f.tree.store.notes(f.threadId).length === 0, '外部事件和回报已送达')
    const items = JSON.stringify(f.claude.current(f.threadId)?.items)
    assert.match(items, /外部待投递提醒/)
    assert.match(items, /工作线的回报夹具/)
    assert.deepEqual(f.tree.store.tools(f.threadId), tools)
    assert.deepEqual(f.claude.thread(f.threadId).dynamicTools, installed)
    assert.equal(f.managers.store.reset(f.id)?.applied, applied)
    assert.equal(f.managers.externalReady(f.managers.store.manager(f.id)!).ready, true)
  } finally {
    await f.env.close()
  }
})

test('要唤醒经理但暂时等工作线的回报不挡压缩，压完后回报仍在', async () => {
  const f = await setup()
  try {
    f.assign()
    const line = (title: string) =>
      startChild(
        f.tree,
        f.threadId,
        { kind: 'fresh', title, prompt: '跑一项工作', worktree: false, wakeParent: true },
        'model',
      )
    const reporter = await line('先完成的工作线')
    const busy = await line('仍在运行的工作线')
    f.env.pi.end(reporter.threadId, 'completed', '第一条回报')
    await until(() => f.tree.store.notes(f.threadId).length === 1, '第一条回报排队')
    await f.tree.settleManagerQueue(f.threadId)

    f.advance(51 * minute)
    f.start()
    await until(() => f.attempts() === 1, '仍可压缩经理')
    assert.equal(f.tree.store.notes(f.threadId).length, 1)
    f.finish('completed', 25_000)
    await f.tree.settleIdleCompacts()
    await f.tree.settleManagerQueue(f.threadId)
    assert.equal(f.tree.store.notes(f.threadId).length, 1)
    const wakeSkips = f.logs.filter(
      (line) => line.startsWith('sessionTree.wake.skipped ') && line.includes(f.threadId),
    )
    assert.equal(wakeSkips.length, 1, '同一批忙碌工作线不重复记')
    const [wakeSkip] = wakeSkips
    assert.ok(wakeSkip)
    assert.match(wakeSkip, /"reason":"childrenWorking"/)
    assert.ok(wakeSkip.includes(busy.threadId), '指出是哪个工作线在等')

    f.env.pi.end(busy.threadId, 'completed', '第二条回报')
    await until(() => f.claude.running(f.threadId), '工作线停下后唤醒')
    await f.tree.settleManagerQueue(f.threadId)
    assert.equal(f.tree.store.notes(f.threadId).length, 0)
    const items = JSON.stringify(f.claude.current(f.threadId)?.items)
    assert.match(items, /第一条回报/)
    assert.match(items, /第二条回报/)
  } finally {
    await f.env.close()
  }
})

test('空闲压缩检查先投递能立即唤醒的回报', async () => {
  const f = await setup()
  try {
    f.assign()
    const line = await startChild(
      f.tree,
      f.threadId,
      {
        kind: 'fresh',
        title: '准备好的工作线',
        prompt: '跑一项工作',
        worktree: false,
        wakeParent: false,
      },
      'model',
    )
    f.env.pi.end(line.threadId, 'completed', '待投递的回报')
    await until(() => f.tree.store.notes(f.threadId).length === 1, '准备好的回报排队')
    await f.tree.settleManagerQueue(f.threadId)
    // 只改持久数据，不触发正常的立即检查，专门验证压缩预检的优先顺序。
    f.tree.store.setWakeParent(line.threadId, true)
    f.advance(51 * minute)
    await f.scan()
    assert.equal(f.attempts(), 0)
    assert.equal(f.tree.store.notes(f.threadId).length, 0)
    assert.match(JSON.stringify(f.claude.current(f.threadId)?.items), /待投递的回报/)
    assert.ok(f.logs.some((line) => line.includes('"reason":"reportDelivered"')))
  } finally {
    await f.env.close()
  }
})

test('压缩预检等待工作线状态期间收到用户输入：回报交给用户回合，不另开自动回合', async () => {
  const f = await setup()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    f.assign()
    const line = await startChild(
      f.tree,
      f.threadId,
      {
        kind: 'fresh',
        title: '已完成的工作线',
        prompt: '跑一项工作',
        worktree: false,
        wakeParent: false,
      },
      'model',
    )
    const { pi } = f.env
    pi.end(line.threadId, 'completed', '并入用户回合的回报')
    await until(() => f.tree.store.notes(f.threadId).length === 1, '回报排队')
    await f.tree.settleManagerQueue(f.threadId)
    f.tree.store.setWakeParent(line.threadId, true)
    const read = pi.handlers['thread/read']
    assert.ok(read)
    let checking = false
    pi.handlers['thread/read'] = (params, connection) => {
      const result = read(params, connection)
      if (params.threadId !== line.threadId) return result
      checking = true
      const { id } = JSON.parse(connection.raw.at(-1) ?? '{}')
      void gate.then(() => connection.send({ id, result }))
      return undefined
    }
    const previous = f.claude.sent('turn/start').length
    f.advance(51 * minute)
    f.start()
    await until(() => checking, '压缩检查已经持锁')
    const user = f.client
      .call('turn/start', {
        threadId: f.threadId,
        input: [{ type: 'text', text: '我先说一句', text_elements: [] }],
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    await until(() => f.tree.idleCompactBlock(f.threadId) === 'inputWaiting', '用户在等锁')
    release()
    assert.equal(await user, null)
    await f.tree.settleManagerQueue(f.threadId)
    assert.equal(f.attempts(), 0)
    assert.equal(f.claude.sent('turn/start').length, previous + 1)
    const items = JSON.stringify(f.claude.current(f.threadId)?.items)
    assert.match(items, /并入用户回合的回报/)
    assert.match(items, /我先说一句/)
  } finally {
    release()
    await f.env.close()
  }
})
