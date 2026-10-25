// 父会话有回合在跑时子会话的回报当场插进那个回合（turn/steer，同 Claude 桌面端）：插成了出队列、不再唤醒，
// 出错、被打断的也插；插不进（回合在收尾、引擎不会插话）的留在队列里照旧等下一回合或唤醒
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { resultOf } from './fake-engine.mjs'
import { RpcFailure } from './fake-upstream.mjs'
import { settle } from './helpers.mjs'
import { brief, got, litch, parent, SESSIONS, text, treeRig, until } from './tree-kit.mjs'

const QUEUED = 'litch/thread/queuedNotes/updated'

type Env = ReturnType<typeof treeRig>

/** 设备进程往父会话插的回报：插话的参数和认出来的回报 */
const steersOf = (env: Env, threadId: string) =>
  env.pi
    .sent('turn/steer')
    .filter((params) => params.threadId === threadId)
    .map((params) => ({ params, event: parseSessionEvent(params.input[0].text) }))

const wakesOf = (env: Env, threadId: string) =>
  env.pi
    .sent('turn/start')
    .filter((params) => params.threadId === threadId)
    .map((params) => parseSessionEvent(params.input[0].text).event)
    .filter((event) => event?.kind === 'wake')

/** 模型在父会话的用户回合里派一个 claude-code 的子会话（要唤醒父会话） */
async function child(env: Env, threadId: string, title: string) {
  const call = await env.pi.callTool(threadId, SESSIONS, 'start', {
    title,
    ...brief(`${title}。`),
    harness: 'claude-code',
    initiation: 'user_asked',
  })
  return resultOf(call?.answer).thread_id as string
}

test('SESSION-TREE-020：父会话在跑，子会话做完：回报当场插进这个回合、出队列；父会话停下不再唤醒，用户下一句话也不再带', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId, turnId } = await parent(client)
    const childId = await child(env, threadId, '三号客户端')
    env.claude.end(childId, 'completed', '常驻无头客户端上线了')
    await until(() => steersOf(env, threadId).length === 1, '插进父会话的回合')
    const [{ params, event }] = steersOf(env, threadId) as [ReturnType<typeof steersOf>[number]]
    assert.equal(params.expectedTurnId, turnId)
    assert.match(params.clientUserMessageId, /^litch-sessions-[a-z0-9]+-\d+$/)
    assert.equal(event.event?.kind, 'notes')
    assert.equal(event.rest, '', '只有回报，没有用户的话')
    assert.match(params.input[0].text, /from Litch, not typed by the user/)
    assert.deepEqual(
      event.event?.notes.map((note) => [note.threadId, note.status, note.excerpt]),
      [[childId, 'completed', '常驻无头客户端上线了']],
    )
    // 引擎那边这一回合里多了这条用户消息
    const items = env.pi.turns.get(threadId)?.at(-1)?.items ?? []
    assert.equal(items.filter((item) => item.type === 'userMessage').length, 2)
    await until(() => env.device.sessionTree.store.notes(threadId).length === 0, '出队列')
    await until(() => got(client, QUEUED).length === 2, '进队列、出队列各通知一次')
    assert.deepEqual(got(client, QUEUED)[1], { threadId, notes: [] })
    // 父会话停下：子会话都停了，但回报已经交出去了，不唤醒
    env.pi.end(threadId, 'completed', '好的')
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0)
    await client.call('turn/start', { threadId, input: text('接着来') })
    const next = parseSessionEvent(env.pi.sent('turn/start').at(-1).input[0].text)
    assert.equal(next.event, null, '下一句话不再带这条回报')
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-021：出错、被打断的子回合在父会话跑着时也插进去（不开回合，没有唤醒的代价），错误原文带上', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const broken = await child(env, threadId, '攻略整理')
    const cut = await child(env, threadId, '断了的')
    env.claude.end(broken, 'failed', undefined, 'There’s an issue with the selected model')
    await until(() => steersOf(env, threadId).length === 1, '出错的插进去')
    env.claude.end(cut, 'interrupted', '做到一半')
    await until(() => steersOf(env, threadId).length === 2, '被打断的插进去')
    const notes = steersOf(env, threadId).flatMap(({ event }) => event.event?.notes ?? [])
    assert.deepEqual(
      notes.map((note) => [note.threadId, note.status, note.error ?? null]),
      [
        [broken, 'failed', 'There’s an issue with the selected model'],
        [cut, 'interrupted', null],
      ],
    )
    const ids = steersOf(env, threadId).map(({ params }) => params.clientUserMessageId)
    assert.notEqual(ids[0], ids[1], '每次插话一个消息号')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 0, '都出队列')
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-022：插不进（回合正在收尾）的留在队列里，父会话停下后照旧唤醒；引擎不认识插话的不再去插', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const first = await child(env, threadId, '一号')
    const second = await child(env, threadId, '二号')
    let refuse = -32600
    env.pi.handlers['turn/steer'] = () => {
      throw new RpcFailure(refuse, refuse === -32601 ? 'method not found' : '回合已终结')
    }
    env.claude.end(first, 'completed', '一号做完了')
    await until(() => steersOf(env, threadId).length === 1, '试着插了一次')
    await settle(40)
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 1, '没插进的留着')
    assert.equal(got(client, QUEUED).at(-1).notes.length, 1, '界面上照旧排着')
    // 引擎说不认识 turn/steer：这一次留着，之后这个 harness 不再去插
    refuse = -32601
    env.claude.end(second, 'completed', '二号做完了')
    await until(() => steersOf(env, threadId).length === 2, '又试了一次')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 2, '两条都排着')
    const third = await child(env, threadId, '三号')
    env.claude.end(third, 'completed', '三号做完了')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 3, '三条都排着')
    await settle(40)
    assert.equal(steersOf(env, threadId).length, 2, '不认识插话的不再去插')
    // 父会话停下：子会话都停了，照旧唤醒，三条一起交出去
    env.pi.end(threadId)
    await until(() => wakesOf(env, threadId).length === 1, '唤醒')
    assert.deepEqual(
      wakesOf(env, threadId)[0]?.notes.map((note) => note.threadId),
      [first, second, third],
    )
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-023：几个子会话差不多同时做完：每条回报只插一次，不重复、不漏，也不再唤醒', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const children = [
      await child(env, threadId, '甲'),
      await child(env, threadId, '乙'),
      await child(env, threadId, '丙'),
    ]
    for (const [index, id] of children.entries()) env.claude.end(id, 'completed', `第${index}个`)
    await until(() => env.device.sessionTree.store.notes(threadId).length === 0, '都出队列')
    await settle(40)
    const steers = steersOf(env, threadId)
    const delivered = steers.flatMap(({ event }) => event.event?.notes ?? []).map((n) => n.threadId)
    assert.deepEqual([...delivered].sort(), [...children].sort(), '每条都交了、只交一次')
    assert.ok(steers.length <= 3)
    env.pi.end(threadId)
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0)
  } finally {
    await env.close()
  }
})
