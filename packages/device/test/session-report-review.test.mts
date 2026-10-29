import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { openSessionDatabase, SessionStore } from '../src/session-store.mjs'
import { resultOf } from './fake-engine.mjs'
import { rig, settle } from './helpers.mjs'
import { brief, litch, parent, refuseSteer, SESSIONS, TREE, treeRig, until } from './tree-kit.mjs'

const METHOD = 'litch/session/report/set'
type Env = ReturnType<typeof treeRig>
async function child(env: Env, parentId: string, wake = false): Promise<string> {
  return resultOf(
    (
      await env.pi.callTool(parentId, SESSIONS, 'start', {
        title: '复审子任务',
        ...brief('检查回报'),
        harness: 'claude-code',
        initiation: 'user_asked',
        wake_parent: wake,
      })
    )?.answer,
  ).thread_id
}
function gate() {
  let release = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}

test('REPORT-009：关闭前已报告有后台任务，恢复之后才结束的任务照常回报', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    const tree = env.device.sessionTree
    const task = {
      id: 'job',
      title: '后台任务',
      status: 'running',
      kind: 'shell',
      startedAt: 1,
    } as const
    tree.host.backgroundRunning = (t) => (t === id ? 1 : 0)
    tree.host.backgroundTasks = (t) => (t === id ? [task] : [])
    tree.host.backgroundWakes = () => false
    env.claude.end(id, 'completed', '已开始后台任务')
    await until(() => tree.queuedNotes(threadId).length === 1, '先报告仍有后台任务')
    await client.call(METHOD, { threadId: id, reportParent: false })
    await client.call(METHOD, { threadId: id, reportParent: true })
    tree.host.backgroundRunning = () => 0
    tree.backgroundSettled(id, [{ ...task, status: 'completed' }])
    assert.match(tree.queuedNotes(threadId)[0]?.excerpt ?? '', /Background tasks finished/)
  } finally {
    await env.close()
  }
})

test('REPORT-010：立即处理读历史期间切换孩子开关，仍投递最新队列并回 woken', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  const barrier = gate()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const first = await child(env, threadId)
    const second = await child(env, threadId)
    env.claude.end(first, 'completed', '取消')
    env.claude.end(second, 'completed', '保留')
    const tree = env.device.sessionTree
    await until(() => tree.queuedNotes(threadId).length === 2, '两个结果排队')
    env.pi.end(threadId, 'interrupted')
    await until(() => !tree.isActive(threadId), '父会话停下')
    const link = await tree.link('pi')
    const request = link.request.bind(link)
    let reading = false
    link.request = async (method, params: any, options) => {
      if (method === 'thread/read' && params.threadId === threadId && params.includeTurns) {
        reading = true
        await barrier.waiting
      }
      return request(method, params, options)
    }
    const delivery = tree.deliver(threadId)
    await until(() => reading, '手动投递读历史挂起')
    await client.call(METHOD, { threadId: first, reportParent: false })
    await client.call(METHOD, { threadId: first, reportParent: true })
    barrier.release()
    assert.equal(await delivery, 'woken')
    const sent = env.pi.sent('turn/start').at(-1)
    assert.deepEqual(
      parseSessionEvent(sent.input[0].text).event?.notes.map((n) => n.threadId),
      [second],
    )
  } finally {
    barrier.release()
    await env.close()
  }
})

test('REPORT-011：恢复未满等待门槛的请求，原定时器到期才补报；再次关开可再报一次', async () => {
  const env = treeRig({ needsUserMs: 250 })
  refuseSteer(env.pi)
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    await client.call(METHOD, { threadId: id, reportParent: false })
    for (const connection of env.claude.live)
      connection.send({
        id: 'question',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: id,
          turnId: env.claude.current(id)?.id,
          itemId: 'q',
          questions: [
            {
              id: 'scope',
              header: '范围',
              question: '哪些目录？',
              isOther: true,
              isSecret: false,
              options: [],
            },
          ],
        },
      })
    const tree = env.device.sessionTree
    await until(() => tree.pendingRequests(id).length > 0, '待答请求')
    assert.equal(tree.waitingOnUser(id), false)
    await client.call(METHOD, { threadId: id, reportParent: true })
    assert.equal(tree.queuedNotes(threadId).length, 0)
    await until(() => tree.queuedNotes(threadId).length === 1, '等待门槛后补报')
    assert.equal(tree.waitingOnUser(id), true)
    const seq = tree.store.notes(threadId)[0]?.seq
    assert.ok(seq !== undefined)
    await client.call(METHOD, { threadId: id, reportParent: false })
    await client.call(METHOD, { threadId: id, reportParent: true })
    assert.equal(tree.queuedNotes(threadId).length, 1)
    assert.ok((tree.store.notes(threadId)[0]?.seq ?? 0) > seq)
  } finally {
    await env.close()
  }
})

test('REPORT-012：脱离再派出的 epoch 单调增加，旧关系补读不能回填', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  const barrier = gate()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    const tree = env.device.sessionTree
    const row = tree.store.parentOf(id)
    assert.ok(row)
    const link = await tree.link('claude-code')
    const request = link.request.bind(link)
    let reading = false
    link.request = async (method, params: any, options) => {
      if (method === 'thread/read' && params.threadId === id && params.includeTurns) {
        reading = true
        await barrier.waiting
      }
      return request(method, params, options)
    }
    env.claude.end(id, 'completed', '旧关系结果')
    await until(() => reading, '旧关系补读挂起')
    tree.detach(id)
    const {
      reportEpoch,
      reportParent: _report,
      reportedTurn: _turn,
      detachedAt: _detached,
      ...fields
    } = row
    tree.store.addLineage(fields)
    assert.equal(tree.store.parentOf(id)?.reportEpoch, reportEpoch + 1)
    const db = openSessionDatabase(env.stateDir)
    try {
      assert.equal(new SessionStore(db).parentOf(id)?.reportEpoch, reportEpoch + 1)
    } finally {
      db.close()
    }
    barrier.release()
    await settle(50)
    assert.equal(tree.queuedNotes(threadId).length, 0)
  } finally {
    barrier.release()
    await env.close()
  }
})

test('REPORT-013：steer 已送出但应答在途时关开，不撤回旧消息、不重复投递，不误删新回报', async () => {
  const env = treeRig()
  const barrier = gate()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    const tree = env.device.sessionTree
    const link = await tree.link('pi')
    const request = link.request.bind(link)
    let steered = false
    link.request = async (method, params, options) => {
      const result = await request(method, params, options)
      if (method === 'turn/steer' && !steered) {
        steered = true
        await barrier.waiting
      }
      return result
    }
    env.claude.end(id, 'completed', '已送出的旧结果')
    await until(() => steered, '旧回报已经插入，应答仍在途')
    await client.call(METHOD, { threadId: id, reportParent: false })
    await client.call(METHOD, { threadId: id, reportParent: true })
    env.claude.selfTurn(id)
    env.claude.end(id, 'completed', '恢复后的新结果')
    await until(() => tree.queuedNotes(threadId)[0]?.excerpt === '恢复后的新结果', '新结果排队')
    barrier.release()
    await until(
      () => env.pi.sent('turn/steer').length === 2 && tree.queuedNotes(threadId).length === 0,
      '新旧各投递一次',
    )
    const notes = env.pi
      .sent('turn/steer')
      .flatMap((p) => parseSessionEvent(p.input[0].text).event?.notes ?? [])
    assert.deepEqual(
      notes.map((n) => n.excerpt),
      ['已送出的旧结果', '恢复后的新结果'],
    )
  } finally {
    barrier.release()
    await env.close()
  }
})

test('REPORT-014：设备在同一进程重建并 recover，已静默的回合在恢复开关后也不补发', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  let restarted: ReturnType<typeof rig> | undefined
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    await client.call(METHOD, { threadId: id, reportParent: false })
    const turn = env.claude.end(id, 'completed', '静默结果')
    assert.ok(turn)
    await until(
      () => env.device.sessionTree.store.parentOf(id)?.reportedTurn === turn.id,
      '静默回合已记账',
    )
    await env.device.close()
    const reads = env.claude.sent('thread/read').filter((p) => p.includeTurns).length
    restarted = rig({ pi: env.pi, 'claude-code': env.claude }, {}, { stateDir: env.stateDir })
    const next = restarted.connect()
    await next.initialize(TREE)
    await until(
      () => env.claude.sent('thread/read').filter((p) => p.includeTurns).length > reads,
      'recover 完整读取子会话',
    )
    assert.equal(restarted.device.sessionTree.lineage(id)?.reportParent, false)
    await next.call(METHOD, { threadId: id, reportParent: true })
    await settle(60)
    assert.equal(restarted.device.sessionTree.store.parentOf(id)?.reportedTurn, turn.id)
    assert.equal(restarted.device.sessionTree.queuedNotes(threadId).length, 0)
    assert.equal(env.pi.sent('turn/steer').length, 0)
  } finally {
    if (restarted) await restarted.close()
    else await env.close()
  }
})
