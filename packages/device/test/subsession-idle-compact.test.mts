import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import {
  IDLE_COMPACT_READ,
  type IdleCompactSnapshot,
  type ManagerIdleCompactSettings,
} from '../../protocol/src/manager-idle-compact.mjs'
import type { SessionPendingRequest } from '../../protocol/src/session-pending.mjs'
import { startChild } from '../src/session-start.mjs'
import { treeRig, until } from './tree-kit.mjs'

const minute = 60_000

/** 经理（用量低，不压）下挂一条 Claude 工作线、它的 Claude 子线，以及一条 Pi 工作线。 */
async function setup() {
  let now = Date.now()
  const busy = new Set<string>()
  const attempts: string[] = []
  const reads: string[] = []
  const logs: string[] = []
  const env = treeRig(
    {},
    { managerIdleCompactClock: () => now, external: {}, log: (line) => logs.push(line) },
  )
  const client = env.connect()
  const { managers, sessionTree: tree, external } = env.device
  assert.ok(external)
  const { claude, pi } = env
  await client.initialize(['harness', 'litchManager', 'sessionTree'])
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: env.stateDir,
    harness: 'claude-code',
    model: null,
    effort: null,
    name: '子会话压缩经理',
    scope: '',
    rules: '规则夹具。',
    template: 'blank',
    firstTask: '',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, harness: 'claude-code' },
    contact: MANAGER_DEFAULT_CONTACT,
  })
  const id = manager.id as string
  const samples = new Map<string, IdleCompactSnapshot>()
  const settle = async (target: string) => {
    const ended = claude.end(target)
    await until(() => !tree.isActive(target), `${target} 闲置`)
    samples.set(target, {
      idle: true,
      lastTurnId: ended.id,
      lastTurnActivityAt: now,
      usageTurnId: ended.id,
      usedTokens: samples.get(target)?.usedTokens ?? 80_000,
      windowTokens: 100_000,
    })
  }
  await until(() => claude.running(threadId), '经理开场')
  samples.set(threadId, {} as IdleCompactSnapshot)
  await settle(threadId)
  samples.get(threadId)!.usedTokens = 10_000
  claude.handlers[IDLE_COMPACT_READ] = (params) => {
    const target = String(params.threadId)
    reads.push(target)
    const sample = samples.get(target)
    assert.ok(sample, `没有 ${target} 的用量夹具`)
    return { ...sample, idle: !busy.has(target) && !claude.running(target) }
  }
  claude.handlers['thread/compact/start'] = (params) => {
    const target = String(params.threadId)
    assert.deepEqual(params.litchIdleCompact, { ...samples.get(target), idle: true })
    attempts.push(target)
    const turn = claude.selfTurn(target)
    turn.items.push({ type: 'contextCompaction', id: `compact-${attempts.length}` })
    return { turnId: turn.id }
  }
  const known = new Set([threadId])
  /** 子会话结束会叫醒父会话；把这些唤醒回合都跑完，让各层都闲着、没有排队的回报。 */
  const quiet = async () => {
    for (let round = 0; round < 6; round++) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      for (const target of known) if (claude.running(target)) await settle(target)
    }
    for (const target of known)
      assert.equal(tree.store.notes(target).length, 0, `${target} 还有排队的回报`)
  }
  const child = async (parentId: string, title: string, harness = 'claude-code') => {
    const started = await startChild(
      tree,
      parentId,
      { kind: 'fresh', title, prompt: '跑一项工作', worktree: false, wakeParent: true, harness },
      'model',
    )
    const engine = harness === 'pi' ? pi : claude
    await until(() => engine.running(started.threadId), `${title} 启动`)
    if (harness === 'pi') {
      pi.end(started.threadId)
      await until(() => !tree.isActive(started.threadId), `${title} 闲置`)
    } else {
      known.add(started.threadId)
      await settle(started.threadId)
    }
    await quiet()
    return started.threadId
  }
  const line = await child(threadId, 'Claude 工作线')
  const grandchild = await child(line, '子线的子线')
  const piLine = await child(threadId, 'Pi 工作线', 'pi')
  external.store.config.saveAssignment(
    { managerId: id, identityId: 'identity', repoIds: ['r1'] },
    0,
    'subsession-idle-compact',
    () => {},
  )
  return {
    child,
    env,
    client,
    claude,
    tree,
    managers,
    samples,
    id,
    threadId,
    line,
    grandchild,
    piLine,
    attempts,
    reads,
    logs,
    busy,
    settle,
    now: () => now,
    advance: (ms: number) => (now += ms),
    config: (idleCompact: ManagerIdleCompactSettings) =>
      client.call(MANAGER_METHOD.update, { managerId: id, idleCompact }),
    /** 预期不会压缩时用：跑一轮并等检查做完。 */
    scan: async () => {
      managers.idleCompact.tick(id)
      await tree.settleIdleCompacts()
    },
    /** 预期会压缩时用：只触发，随后等 attempts 变化。 */
    start: () => managers.idleCompact.tick(id),
    /** 结束正在进行的压缩回合，压缩后用量降到 after。 */
    async finish(after: number) {
      for (const target of new Set(attempts)) {
        if (!claude.running(target)) continue
        const turn = claude.current(target)!
        const sample = samples.get(target)!
        sample.usedTokens = after
        sample.usageTurnId = turn.id
        claude.end(target)
      }
      await tree.settleIdleCompacts()
    },
  }
}

test('各层 Claude 子会话空闲超阈值后各压一次，记录进工作线；经理用量低不压，Pi 工作线不探测', async () => {
  const f = await setup()
  try {
    // 计时起点取会话登记时间（真实时钟的秒）和最近活动的较晚者，测试时钟与之有亚秒差，边界留余量。
    f.advance(49 * minute)
    await f.scan()
    assert.deepEqual(f.attempts, [], '未满 50 分钟不压')
    f.advance(2 * minute)
    f.start()
    await until(() => f.attempts.length === 2, '工作线和子线都进入压缩')
    assert.deepEqual(new Set(f.attempts), new Set([f.line, f.grandchild]))
    assert.ok(!f.reads.includes(f.piLine), 'Pi 会话不走 Claude 的空闲探测')
    await f.finish(30_000)
    const lines = f.managers.lines.lines(f.id)
    const record = (threadId: string) =>
      lines.find((line) => line.threadId === threadId)?.idleCompactLast
    assert.deepEqual(record(f.line), { at: f.now(), before: 80, after: 30 })
    assert.deepEqual(record(f.grandchild), { at: f.now(), before: 80, after: 30 })
    assert.equal(record(f.piLine), undefined)
    assert.equal(f.managers.manager(f.id).idleCompactLast, undefined, '经理本身未过阈值')
    assert.ok(f.logs.some((line) => line.includes('"line":true')))
    // 压缩回合不是工作，不给经理回报
    assert.equal(
      f.tree.store.notes(f.threadId).filter((note) => note.threadId === f.line).length,
      0,
    )
    f.advance(120 * minute)
    await f.scan()
    await f.scan()
    assert.equal(f.attempts.length, 2, '同一段空闲只试一次')
    const lineReads = () => f.reads.filter((id) => id === f.line || id === f.grandchild).length
    const reads = lineReads()
    f.advance(minute)
    f.managers.idleCompact.tick()
    await f.tree.settleIdleCompacts()
    assert.equal(lineReads(), reads, '试过的子会话在新活动前不再探测引擎')
  } finally {
    await f.env.close()
  }
})

test('经理关掉开关或未分配仓库时子会话也不压；重新打开立即生效', async () => {
  const f = await setup()
  try {
    await f.config({ enabled: false, idleMinutes: 5, contextPercent: 50 })
    f.advance(60 * minute)
    await f.scan()
    assert.deepEqual(f.attempts, [])
    f.env.device.external!.store.config.saveAssignment(
      { managerId: f.id, identityId: 'identity', repoIds: [] },
      1,
      'subsession-idle-compact-clear',
      () => {},
    )
    await f.config({ enabled: true, idleMinutes: 5, contextPercent: 50 })
    await f.tree.settleIdleCompacts()
    assert.deepEqual(f.attempts, [], '经理未分配仓库')
    f.env.device.external!.store.config.saveAssignment(
      { managerId: f.id, identityId: 'identity', repoIds: ['r1'] },
      2,
      'subsession-idle-compact-again',
      () => {},
    )
    await f.config({ enabled: true, idleMinutes: 5, contextPercent: 90 })
    await f.tree.settleIdleCompacts()
    assert.deepEqual(f.attempts, [], '用量 80% 未过 90%')
    await f.config({ enabled: true, idleMinutes: 5, contextPercent: 75 })
    await until(() => f.attempts.length === 2, '改设置后按新阈值压缩')
    await f.finish(20_000)
  } finally {
    await f.env.close()
  }
})

test('子会话回合开始和结束都重置计时', async () => {
  const f = await setup()
  try {
    f.advance(30 * minute)
    const both = f.claude.selfTurn(f.line)
    await until(() => f.tree.activeTurn(f.line) === both.id, '工作线新回合开始')
    f.advance(40 * minute)
    f.busy.add(f.grandchild) // 只看工作线
    await f.scan()
    assert.deepEqual(f.attempts, [], '回合在跑')
    await f.settle(f.line)
    f.advance(30 * minute)
    await f.scan()
    assert.deepEqual(f.attempts, [], '距开始 70 分钟，距结束只有 30 分钟')
    f.advance(20 * minute)
    f.start()
    await until(() => f.attempts.length === 1, '结束后满 50 分钟')
    assert.deepEqual(f.attempts, [f.line])
    await f.finish(20_000)
    // 新回合结束后允许下一段空闲再压一次
    f.claude.selfTurn(f.line)
    await until(() => f.tree.isActive(f.line), '又一轮开始')
    f.samples.get(f.line)!.usedTokens = 85_000
    await f.settle(f.line)
    f.advance(50 * minute)
    f.start()
    await until(() => f.attempts.length === 2, '新的空闲段再压')
    await f.finish(20_000)
  } finally {
    await f.env.close()
  }
})

test('有后台任务、待答审批或没答的提问时不压子会话', async () => {
  const f = await setup()
  try {
    f.busy.add(f.grandchild)
    const host = f.tree.host
    const background = host.backgroundRunning
    host.backgroundRunning = (threadId) => (threadId === f.line ? 1 : background(threadId))
    f.advance(60 * minute)
    await f.scan()
    assert.deepEqual(f.attempts, [], '后台任务在跑')
    host.backgroundRunning = background

    const requests = host.clientRequests
    const request = { createdAt: f.now() } as unknown as SessionPendingRequest
    host.clientRequests = (threadId) =>
      threadId === f.line ? [request] : (requests?.(threadId) ?? [])
    await f.scan()
    assert.deepEqual(f.attempts, [], '审批在等用户')
    if (requests) host.clientRequests = requests
    else delete host.clientRequests

    const asked = f.tree.awaitingAnswer.bind(f.tree)
    let waiting = true
    f.tree.awaitingAnswer = async (threadId) => (threadId === f.line ? waiting : asked(threadId))
    f.advance(minute)
    await f.scan()
    assert.deepEqual(f.attempts, [], '异步提问没答')
    waiting = false
    f.advance(minute)
    f.start()
    await until(() => f.attempts.length === 1, '答复后可压')
    await f.finish(20_000)
  } finally {
    await f.env.close()
  }
})

test('读得到的历史里没有提问时不算在等用户', async () => {
  const f = await setup()
  try {
    assert.equal(await f.tree.awaitingAnswer(f.line), false)
  } finally {
    await f.env.close()
  }
})

test('同时最多两条子会话在压缩，其余等下一轮', async () => {
  const f = await setup()
  try {
    const third = await f.child(f.threadId, '第三条 Claude 工作线')
    f.advance(51 * minute)
    f.start()
    await until(() => f.attempts.length === 2, '先压两条')
    await new Promise((resolve) => setTimeout(resolve, 100))
    f.managers.idleCompact.tick()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(f.attempts.length, 2, '名额占满时不再起新的')
    await f.finish(20_000)
    f.start()
    await until(() => f.attempts.length === 3, '名额空出后压第三条')
    assert.deepEqual(new Set(f.attempts), new Set([f.line, f.grandchild, third]))
    await f.finish(20_000)
  } finally {
    await f.env.close()
  }
})
