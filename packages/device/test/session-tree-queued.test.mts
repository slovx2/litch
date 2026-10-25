// 会话树的回报队列（父会话停着时）：出错、被打断的子会话回合只进队列不唤醒（同 Claude 桌面端），
// 队列一变就通知声明了 sessionTree 的连接、会话对象上挂着排着的回报（父会话的对话区当场画出来）
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { resultOf } from './fake-engine.mjs'
import { settle } from './helpers.mjs'
import { brief, got, litch, parent, plain, SESSIONS, text, treeRig, until } from './tree-kit.mjs'

const QUEUED = 'litch/thread/queuedNotes/updated'

const wakesOf = (env: ReturnType<typeof treeRig>, threadId: string) =>
  env.pi
    .sent('turn/start')
    .filter((params) => params.threadId === threadId)
    .map((params) => parseSessionEvent(params.input[0].text).event)
    .filter((event) => event?.kind === 'wake')

/** 模型在父会话的用户回合里派一个 claude-code 的子会话（要唤醒父会话） */
async function child(env: ReturnType<typeof treeRig>, threadId: string, title: string) {
  const call = await env.pi.callTool(threadId, SESSIONS, 'start', {
    title,
    ...brief(`${title}。`),
    harness: 'claude-code',
    initiation: 'user_asked',
  })
  return resultOf(call?.answer).thread_id as string
}

test('SESSION-TREE-017：子会话第一回合就出错（模型不对）：回报带错误进队列、不唤醒；用户下一句话时带上', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await child(env, threadId, '攻略整理')
    // 父会话先停下（在跑的话回报当场插进去，见 session-tree-steer.test.mts）
    env.pi.end(threadId, 'completed', '派出去了')
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    env.claude.end(childId, 'failed', undefined, 'There’s an issue with the selected model')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 1, '回报进队列')
    const [queued] = env.device.sessionTree.store.notes(threadId)
    assert.equal(queued?.status, 'failed')
    assert.equal(queued?.error, 'There’s an issue with the selected model')
    assert.equal(queued?.wake, false, '出错的回合不算该唤醒的')
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0, '子会话都停了、父会话也闲着，照样不唤醒')
    await client.call('turn/start', { threadId, input: text('那个怎么样了') })
    const parsed = parseSessionEvent(env.pi.sent('turn/start').at(-1).input[0].text)
    assert.equal(parsed.event?.kind, 'notes')
    assert.equal(parsed.event?.notes[0]?.status, 'failed')
    assert.equal(parsed.event?.notes[0]?.error, 'There’s an issue with the selected model')
    assert.equal(parsed.rest, '那个怎么样了')
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-018：出错的回报不唤醒，另一个子会话做完的回报唤醒父会话时一起交出去；被打断的同出错', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const broken = await child(env, threadId, '出错的')
    const cut = await child(env, threadId, '断了的')
    const good = await child(env, threadId, '做完的')
    env.pi.end(threadId)
    env.claude.end(broken, 'failed', undefined, '模型不对')
    env.claude.end(cut, 'interrupted', '做到一半')
    await until(() => env.device.sessionTree.store.notes(threadId).length === 2, '两条进队列')
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0, '还有子会话在跑，出错、被打断的也不算该唤醒的')
    env.claude.end(good, 'completed', '做完了')
    await until(() => wakesOf(env, threadId).length === 1, '做完的那条唤醒父会话')
    const [wake] = wakesOf(env, threadId)
    assert.deepEqual(
      wake?.notes.map((note) => [note.threadId, note.status]),
      [
        [broken, 'failed'],
        [cut, 'interrupted'],
        [good, 'completed'],
      ],
    )
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 0)
  } finally {
    await env.close()
  }
})

test('SESSION-TREE-019：回报一进队列就通知，会话对象上挂着；交给模型后通知空的；没声明的连接收不到', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const other = await plain(env)
    const { threadId } = await parent(client)
    const done = await child(env, threadId, '三号客户端')
    await child(env, threadId, '外挂分析')
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话停下')
    env.claude.end(done, 'completed', '常驻无头客户端上线了')
    await until(() => got(client, QUEUED).length === 1, '进队列就通知')
    const [first] = got(client, QUEUED)
    assert.equal(first.threadId, threadId)
    assert.equal(first.notes.length, 1)
    assert.equal(first.notes[0].threadId, done)
    assert.equal(first.notes[0].excerpt, '常驻无头客户端上线了')
    assert.equal(typeof first.notes[0].at, 'number')
    assert.equal('wake' in first.notes[0], false, '库里才有的字段不往外发')
    // 会话对象上挂着排着的回报：重新打开父会话（thread/read、thread/resume）时画得出来
    const read = await client.call('thread/read', { threadId, includeTurns: false })
    assert.deepEqual(read.thread.litchQueuedNotes, first.notes)
    const bare = await other.call('thread/read', { threadId, includeTurns: false })
    assert.equal(bare.thread.litchQueuedNotes, undefined, '没声明的连接上没有')
    // 父会话停着，另一个子会话还在跑：不唤醒，回报留在队列里
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0)
    assert.equal(env.device.sessionTree.store.notes(threadId).length, 1)
    // 用户说了话：回报跟着交出去，队列空了也通知
    await client.call('turn/start', { threadId, input: text('接着来') })
    await until(() => got(client, QUEUED).length === 2, '交出去也通知')
    assert.deepEqual(got(client, QUEUED)[1], { threadId, notes: [] })
    const after = await client.call('thread/read', { threadId, includeTurns: false })
    assert.equal(after.thread.litchQueuedNotes, undefined)
    assert.equal(got(other, QUEUED).length, 0, '没声明 sessionTree 的连接收不到')
  } finally {
    await env.close()
  }
})
