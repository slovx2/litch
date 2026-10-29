import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { openSessionDatabase, SessionStore } from '../src/session-store.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import { settle } from './helpers.mjs'
import {
  brief,
  got,
  litch,
  parent,
  plain,
  refuseSteer,
  SESSIONS,
  treeRig,
  until,
} from './tree-kit.mjs'

type Env = ReturnType<typeof treeRig>
const METHOD = 'litch/session/report/set'
const EVENT = 'litch/thread/report/changed'

test('REPORT-008：关闭回报和清队列原子提交；写入失败不修改持久化或内存状态', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    const store = env.device.sessionTree.store
    store.addNote(
      threadId,
      { threadId: id, title: '结果', status: 'completed', excerpt: '完成' },
      true,
    )
    const db = openSessionDatabase(env.stateDir)
    try {
      db.exec(
        "CREATE TRIGGER fail_report_delete BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT, 'write failed'); END",
      )
      assert.throws(() => store.setReportParent(id, false), /write failed/)
      assert.equal(store.parentOf(id)?.reportParent, true)
      assert.equal(new SessionStore(db).parentOf(id)?.reportParent, true)
      assert.equal(store.notes(threadId).length, 1)
      db.exec('DROP TRIGGER fail_report_delete')
    } finally {
      db.close()
    }
  } finally {
    await env.close()
  }
})

async function child(env: Env, id: string, wake = true): Promise<string> {
  return resultOf(
    (
      await env.pi.callTool(id, SESSIONS, 'start', {
        title: '子任务',
        ...brief('检查模块'),
        harness: 'claude-code',
        initiation: 'user_asked',
        wake_parent: wake,
      })
    )?.answer,
  ).thread_id
}
const wakes = (env: Env, id: string) =>
  env.pi
    .sent('turn/start')
    .filter((p) => p.threadId === id && parseSessionEvent(p.input[0].text).event?.kind === 'wake')
function question(env: Env, id: string): void {
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
            question: '改哪些目录？',
            isOther: true,
            isSecret: false,
            options: [{ label: 'src', description: '' }],
          },
        ],
      },
    })
}

test('REPORT-001：用户设置持久化，重连补读；只对声明连接通知，模型只读且不能用set_wake改回报', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const old = await plain(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    assert.equal(env.device.sessionTree.lineage(id)?.reportParent, true)
    assert.equal(
      (await old.fails(METHOD, { threadId: id, reportParent: false })).data.litch,
      'extensionRequired',
    )
    assert.deepEqual(await client.call(METHOD, { threadId: id, reportParent: false }), {
      threadId: id,
      reportParent: false,
    })
    await until(() => got(client, EVENT).length === 1, '通知声明连接')
    assert.equal(got(old, EVENT).length, 0)
    assert.equal((await old.call('thread/read', { threadId: id })).thread.litchLineage, undefined)
    const db = openSessionDatabase(env.stateDir)
    try {
      assert.equal(new SessionStore(db).parentOf(id)?.reportParent, false)
    } finally {
      db.close()
    }
    const fresh = await litch(env)
    assert.equal(
      (await fresh.call('thread/read', { threadId: id })).thread.litchLineage.reportParent,
      false,
    )
    const read = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'read', { thread_id: id }))?.answer,
    )
    assert.equal(read.session.report_parent, false)
    assert.equal(read.session.status, 'running')
    const list = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'list', { scope: 'mine' }))?.answer,
    )
    assert.equal(list.sessions.find((s: any) => s.thread_id === id).report_parent, false)
    assert.equal(
      failureOf(
        (await env.pi.callTool(threadId, SESSIONS, 'set_report', { thread_id: id, report: true }))
          ?.answer,
      ),
      'invalid',
    )
    await env.pi.callTool(threadId, SESSIONS, 'set_wake', {
      thread_id: id,
      wake: true,
      report_parent: true,
    })
    assert.equal(env.device.sessionTree.lineage(id)?.reportParent, false)
    await client.fails(METHOD, { threadId, reportParent: false })
    await client.fails(METHOD, { threadId: id, reportParent: 'no' })
    assert.equal(env.device.sessionTree.store.childrenOf(threadId).length, 1)
  } finally {
    await env.close()
  }
})

test('REPORT-002：关闭清理队列，完成/失败/中断都静默；恢复不补历史，只报后续新回合', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    env.claude.end(id, 'completed', '排队结果')
    await until(() => env.device.sessionTree.queuedNotes(threadId).length === 1, '回报排队')
    await client.call(METHOD, { threadId: id, reportParent: false })
    assert.equal(env.device.sessionTree.queuedNotes(threadId).length, 0)
    for (const status of ['completed', 'failed', 'interrupted'] as const) {
      env.claude.selfTurn(id)
      env.claude.end(id, status, '静默结果')
      await settle(20)
      assert.equal(env.device.sessionTree.queuedNotes(threadId).length, 0)
    }
    await client.call(METHOD, { threadId: id, reportParent: true })
    await settle(30)
    assert.equal(env.device.sessionTree.queuedNotes(threadId).length, 0)
    env.claude.selfTurn(id)
    env.claude.end(id, 'completed', '新结果')
    await until(() => env.device.sessionTree.queuedNotes(threadId).length === 1, '只报新结果')
    assert.equal(env.device.sessionTree.queuedNotes(threadId)[0]?.excerpt, '新结果')
  } finally {
    await env.close()
  }
})

test('REPORT-003：needsUser静默但子会话待答状态保留；恢复补一次当前请求，set_wake=false不唤醒', async () => {
  const env = treeRig({ needsUserMs: 20 })
  refuseSteer(env.pi)
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId, false)
    await client.call(METHOD, { threadId: id, reportParent: false })
    env.pi.end(threadId)
    question(env, id)
    await until(() => env.device.sessionTree.pendingRequests(id).length > 0, '子会话仍有待答请求')
    await settle(50)
    assert.equal(env.device.sessionTree.queuedNotes(threadId).length, 0)
    assert.ok(
      (await client.call('thread/read', { threadId: id })).thread.litchPendingRequests.length,
    )
    await client.call(METHOD, { threadId: id, reportParent: true })
    await until(() => env.device.sessionTree.queuedNotes(threadId).length === 1, '恢复补报当前请求')
    assert.equal(env.device.sessionTree.queuedNotes(threadId)[0]?.status, 'needsUser')
    const seq = env.device.sessionTree.store.notes(threadId)[0]?.seq
    await client.call(METHOD, { threadId: id, reportParent: true })
    await settle(40)
    assert.equal(env.device.sessionTree.store.notes(threadId)[0]?.seq, seq)
    assert.equal(wakes(env, threadId).length, 0)
  } finally {
    await env.close()
  }
})

test('REPORT-004：静默的长任务不阻止其他子会话唤醒父会话', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const quiet = await child(env, threadId)
    const other = await child(env, threadId)
    await client.call(METHOD, { threadId: quiet, reportParent: false })
    env.pi.end(threadId)
    env.claude.end(other, 'completed', '其他任务完成')
    await until(() => wakes(env, threadId).length === 1, '父会话被其他结果唤醒')
    assert.ok(env.device.sessionTree.isActive(quiet))
    assert.deepEqual(
      parseSessionEvent(wakes(env, threadId)[0].input[0].text).event?.notes.map((n) => n.threadId),
      [other],
    )
  } finally {
    await env.close()
  }
})

test('REPORT-005：结束后补读历史期间关闭再恢复，不会把迟到结果补回', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  let release = () => {}
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    const link = await env.device.sessionTree.link('claude-code')
    const request = link.request.bind(link)
    let reading = false
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    link.request = async (method, params: any, options) => {
      if (method === 'thread/read' && params.threadId === id && params.includeTurns) {
        reading = true
        await barrier
      }
      return request(method, params, options)
    }
    const turn = env.claude.current(id)
    assert.ok(turn)
    env.device.sessionTree.turnEvent('claude-code', 'turn/completed', {
      threadId: id,
      turn: { id: turn.id, status: 'completed', items: [] },
    })
    await until(() => reading, '结果补读挂起')
    await client.call(METHOD, { threadId: id, reportParent: false })
    await client.call(METHOD, { threadId: id, reportParent: true })
    release()
    await settle(50)
    assert.equal(env.device.sessionTree.queuedNotes(threadId).length, 0)
  } finally {
    release()
    await env.close()
  }
})

test('REPORT-006：后台结束补报在关闭时一起取消，恢复不会补发旧后台结果', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const id = await child(env, threadId)
    const task = {
      id: 'job',
      title: '后台任务',
      status: 'running',
      kind: 'shell',
      startedAt: 1,
    } as any
    env.device.sessionTree.host.backgroundRunning = (t) => (t === id ? 1 : 0)
    env.device.sessionTree.host.backgroundTasks = (t) => (t === id ? [task] : [])
    env.claude.end(id, 'completed', '已开始后台任务')
    await until(() => env.device.sessionTree.queuedNotes(threadId).length === 1, '先正常回报')
    await client.call(METHOD, { threadId: id, reportParent: false })
    env.device.sessionTree.host.backgroundWakes = () => false
    env.device.sessionTree.backgroundSettled(id, [{ ...task, status: 'completed' }])
    await client.call(METHOD, { threadId: id, reportParent: true })
    await settle(30)
    assert.equal(env.device.sessionTree.queuedNotes(threadId).length, 0)
  } finally {
    await env.close()
  }
})

test('REPORT-007：唤醒准备期间关闭其中一个子会话，重新核对后只发送其他回报', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  let release = () => {}
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const first = await child(env, threadId)
    const second = await child(env, threadId)
    env.claude.end(first, 'completed', '不再投递')
    env.claude.end(second, 'completed', '继续投递')
    await until(() => env.device.sessionTree.queuedNotes(threadId).length === 2, '两个结果排队')
    const tree = env.device.sessionTree
    const link = await tree.link('pi')
    const request = link.request.bind(link)
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let reading = false
    link.request = async (method, params: any, options) => {
      if (
        method === 'thread/read' &&
        params.threadId === threadId &&
        params.includeTurns &&
        !reading
      ) {
        reading = true
        await barrier
      }
      return request(method, params, options)
    }
    env.pi.end(threadId)
    await until(() => reading, '唤醒准备挂起')
    await client.call(METHOD, { threadId: first, reportParent: false })
    release()
    await until(() => wakes(env, threadId).length === 1, '其余回报仍可唤醒')
    const delivered = parseSessionEvent(wakes(env, threadId)[0].input[0].text).event?.notes
    assert.deepEqual(
      delivered?.map((n) => n.threadId),
      [second],
    )
  } finally {
    release()
    await env.close()
  }
})
