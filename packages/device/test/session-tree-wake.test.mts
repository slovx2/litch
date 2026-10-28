// 父会话停着时的唤醒（没客户端连着也唤醒见 SESSION-TREE-007）：父会话、子会话有后台任务在跑的不唤醒，跑完再说（同 Claude）；
// 父会话上一回合被打断、出错的等用户先说话；父会话闲太久不主动唤醒；定时任务回合带上排着的回报；用户点“立即处理”
import assert from 'node:assert/strict'
import test from 'node:test'
import { BACKGROUND_TASKS_NOTIFICATION } from '../../protocol/src/background-tasks.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { resultOf } from './fake-engine.mjs'
import type { FakeUpstream } from './fake-upstream.mjs'
import { settle } from './helpers.mjs'
import { brief, litch, parent, SESSIONS, text, treeRig, until } from './tree-kit.mjs'

const wakesOf = (env: ReturnType<typeof treeRig>, threadId: string) =>
  env.pi
    .sent('turn/start')
    .filter((params) => params.threadId === threadId)
    .map((params) => parseSessionEvent(params.input[0].text).event)
    .filter((event) => event?.kind === 'wake')

async function child(env: ReturnType<typeof treeRig>, threadId: string, title: string) {
  const call = await env.pi.callTool(threadId, SESSIONS, 'start', {
    title,
    ...brief(`${title}。`),
    harness: 'claude-code',
    initiation: 'user_asked',
  })
  return resultOf(call?.answer).thread_id as string
}

function running(engine: FakeUpstream, threadId: string) {
  engine.notify(BACKGROUND_TASKS_NOTIFICATION.changed, {
    threadId,
    tasks: [{ id: 'b1', kind: 'shell', title: 'npm test', status: 'running', startedAt: 1_000 }],
    wakesOnFinish: true,
  })
}

function settled(
  engine: FakeUpstream,
  threadId: string,
  wakesOnFinish: boolean,
  status: 'completed' | 'stopped' = 'completed',
) {
  engine.notify(BACKGROUND_TASKS_NOTIFICATION.changed, {
    threadId,
    tasks: [{ id: 'b1', kind: 'shell', title: 'npm test', status, startedAt: 1_000 }],
    wakesOnFinish,
  })
}

test('SESSION-WAKE-001 父会话有后台任务在跑：子会话做完不唤醒；后台跑完、引擎不接着做时再唤醒', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId, '调研')
    running(env.pi, threadId)
    env.pi.end(threadId, 'completed', '派出去了，后台在跑测试')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    env.claude.end(childId, 'completed', '调研完了')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0, '后台任务还在跑，不唤醒（同 Claude）')
    settled(env.pi, threadId, false)
    await until(() => wakesOf(env, threadId).length === 1, '后台跑完后唤醒父会话')
  } finally {
    await env.close()
  }
})

test('SESSION-WAKE-002 父会话的后台任务跑完、引擎自己接着做：回报插进那一回合，不另开唤醒', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId, '调研')
    running(env.pi, threadId)
    env.pi.end(threadId, 'completed', '派出去了，后台在跑测试')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    env.claude.end(childId, 'completed', '调研完了')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    settled(env.pi, threadId, true)
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0, '等引擎自己接着做')
    env.pi.selfTurn(threadId)
    await until(
      () => env.device.sessionTree.store.notes(threadId).length === 0,
      '回报插进续跑的回合',
    )
    const steered = env.pi.sent('turn/steer').filter((params) => params.threadId === threadId)
    assert.equal(parseSessionEvent(steered.at(-1).input[0].text).event?.kind, 'notes')
    assert.equal(wakesOf(env, threadId).length, 0)
  } finally {
    await env.close()
  }
})

test('SESSION-WAKE-003 子会话回合结束时还有后台任务在跑：算还在干活，跑完补报时再唤醒', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const first = await child(env, threadId, '跑测试')
    const second = await child(env, threadId, '调研')
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    running(env.claude, first)
    env.claude.end(first, 'completed', '测试在后台跑着')
    env.claude.end(second, 'completed', '调研完了')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 2, '两条回报进队列')
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0, '兄弟子会话的后台任务还在跑')
    settled(env.claude, first, false)
    await until(() => wakesOf(env, threadId).length === 1, '后台跑完后唤醒父会话')
  } finally {
    await env.close()
  }
})

test('SESSION-WAKE-008 父会话最后一个回合结束超过时限：不再主动唤醒，立即处理照样交出去', async () => {
  const env = treeRig({ wakeIdleMs: 50 })
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId, '调研')
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    await settle(120)
    env.claude.end(childId, 'completed', '调研完了')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0, '父会话闲了太久，不主动唤醒')
    await client.call('litch/thread/queuedNotes/deliver', { threadId })
    await until(() => wakesOf(env, threadId).length === 1, '立即处理开唤醒回合')
  } finally {
    await env.close()
  }
})

test('SESSION-WAKE-004 用户刚打断父会话：不唤醒，回报等用户下一句话带上', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId, '调研')
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    // 用户又说了一句，回合跑着；子会话做完时插不进去的话排着（假引擎默认收插话，这里让子会话在用户打断之后才做完）
    const turn = await client.call('turn/start', { threadId, input: text('再看看别的') })
    await client.call('turn/interrupt', { threadId, turnId: turn.turn.id })
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话被打断停下')
    env.claude.end(childId, 'completed', '调研完了')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0, '上一回合被用户打断，等用户先说话')
    await client.call('turn/start', { threadId, input: text('好了继续') })
    const parsed = parseSessionEvent(env.pi.sent('turn/start').at(-1).input[0].text)
    assert.equal(parsed.event?.kind, 'notes')
    assert.equal(parsed.rest, '好了继续')
  } finally {
    await env.close()
  }
})

/** 父会话上的定时任务（暂停着，用 runNow 跑一次） */
async function parentTask(env: ReturnType<typeof treeRig>, threadId: string) {
  const tasks = env.connect()
  await tasks.initialize(['harness', 'deviceTasks'])
  const { task } = await tasks.call('litch/task/create', {
    name: '每半小时推进',
    prompt: '按计划推进。',
    schedule: { type: 'interval', minutes: 30 },
    timezone: 'Asia/Shanghai',
    status: 'paused',
    target: { kind: 'thread', harness: 'pi', threadId },
  })
  await tasks.call('litch/task/runNow', { id: task.id })
}

test('SESSION-WAKE-005 父会话上的定时任务回合带上排着的回报（兄弟子会话还在跑、没唤醒的那几条）', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const first = await child(env, threadId, '调研忠犬')
    await child(env, threadId, '调研伊甸')
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    env.claude.end(first, 'completed', '忠犬能保护队友')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 0, '兄弟还在跑，不唤醒')
    await parentTask(env, threadId)
    await until(() => env.pi.running(threadId), '任务回合在父会话里跑')
    const parsed = parseSessionEvent(env.pi.sent('turn/start').at(-1).input[0].text)
    assert.equal(parsed.event?.kind, 'notes')
    assert.equal(parsed.event?.notes[0]?.excerpt, '忠犬能保护队友')
    assert.match(parsed.rest, /^\[Scheduled task run\]/)
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0, '交出去了')
  } finally {
    await env.close()
  }
})

test('SESSION-WAKE-006 定时任务回合在父会话里跑着时子会话做完：回报插进这个回合', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId, '调研')
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    // 只开着任务的连接：客户端那条不订阅父会话，会话树从任务那边得知回合开始
    client.close()
    await parentTask(env, threadId)
    await until(() => env.pi.running(threadId), '任务回合在父会话里跑')
    const taskTurn = env.pi.current(threadId)?.id
    env.claude.end(childId, 'completed', '调研完了')
    await until(
      () =>
        env.pi
          .sent('turn/steer')
          .some((params) => params.threadId === threadId && params.expectedTurnId === taskTurn),
      '插进任务回合',
    )
    assert.equal(wakesOf(env, threadId).length, 0)
  } finally {
    await env.close()
  }
})

test('SESSION-WAKE-007 立即处理：父会话停着、兄弟还在跑也开唤醒回合，写明几个还在跑，计数清零；在跑时插进去', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const first = await child(env, threadId, '调研忠犬')
    await child(env, threadId, '调研伊甸')
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    env.claude.end(first, 'completed', '忠犬能保护队友')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    env.device.sessionTree.store.setWakes(threadId, 10)
    const woken = await client.call('litch/thread/queuedNotes/deliver', { threadId })
    assert.deepEqual(woken, { delivered: 'woken' })
    const [event] = wakesOf(env, threadId)
    assert.equal(event?.working, 1, '写明还有一个在跑')
    assert.equal(env.device.sessionTree.store.wakes(threadId), 0, '算用户的动作，计数清零')
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0)
    // 唤醒回合在跑，又有一条回报；插话被拒（引擎在收尾）就留着，再点一次照样插
    const steer = env.pi.handlers['turn/steer']
    assert.ok(steer)
    env.pi.handlers['turn/steer'] = () => {
      throw new Error('turn is finishing')
    }
    env.claude.selfTurn(first)
    env.claude.end(first, 'completed', '补充：要先学技能')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '第二条进队列')
    env.pi.handlers['turn/steer'] = steer
    const steered = await client.call('litch/thread/queuedNotes/deliver', { threadId })
    assert.deepEqual(steered, { delivered: 'steered' })
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0)
    const empty = await client.call('litch/thread/queuedNotes/deliver', { threadId })
    assert.deepEqual(empty, { delivered: 'none' })
  } finally {
    await env.close()
  }
})
