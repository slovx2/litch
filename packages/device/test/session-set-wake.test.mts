import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { openSessionDatabase, SessionStore } from '../src/session-store.mjs'
import { failureOf, resultOf } from './fake-engine.mjs'
import { settle } from './helpers.mjs'
import { brief, got, litch, parent, plain, SESSIONS, treeRig, until } from './tree-kit.mjs'

type Env = ReturnType<typeof treeRig>
async function start(env: Env, parentId: string, wake?: boolean) {
  return resultOf(
    (
      await env.pi.callTool(parentId, SESSIONS, 'start', {
        title: '调研',
        ...brief('调研'),
        harness: 'claude-code',
        initiation: 'user_asked',
        ...(wake === undefined ? {} : { wake_parent: wake }),
      })
    )?.answer,
  ).thread_id as string
}
async function setWake(env: Env, parentId: string, childId: string, wake: boolean) {
  return resultOf(
    (
      await env.pi.callTool(parentId, SESSIONS, 'set_wake', {
        thread_id: childId,
        wake,
      })
    )?.answer,
  )
}
const wakes = (env: Env, id: string) =>
  env.pi
    .sent('turn/start')
    .filter((p) => p.threadId === id && parseSessionEvent(p.input[0].text).event?.kind === 'wake')

test('SET-WAKE-001：直接子会话可开关，持久化、list/read、按声明通知；其他目标 forbidden', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const old = await plain(env)
    const { threadId } = await parent(client)
    const childId = await start(env, threadId)
    assert.equal(env.device.sessionTree.lineage(childId)?.wakeParent, true)
    const count = got(old, 'litch/thread/lineage/updated').length
    assert.deepEqual(await setWake(env, threadId, childId, false), {
      thread_id: childId,
      wake_parent: false,
    })
    await until(
      () =>
        got(client, 'litch/thread/lineage/updated').some(
          (p) => p.threadId === childId && !p.lineage.wakeParent,
        ),
      '关闭通知',
    )
    assert.equal(got(old, 'litch/thread/lineage/updated').length, count)
    const db = openSessionDatabase(env.stateDir)
    try {
      assert.equal(new SessionStore(db).parentOf(childId)?.wakeParent, false)
    } finally {
      db.close()
    }
    const listed = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'list', { scope: 'mine' }))?.answer,
    )
    assert.equal(listed.sessions.find((s: any) => s.thread_id === childId).wake_parent, false)
    const read = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'read', { thread_id: childId }))?.answer,
    )
    assert.equal(read.session.wake_parent, false)
    const fresh = await litch(env)
    assert.equal(
      (await fresh.call('thread/read', { threadId: childId })).thread.litchLineage.wakeParent,
      false,
    )
    const unrelated = (await parent(client)).threadId
    const lineage = env.device.sessionTree.store.parentOf(childId)
    assert.ok(lineage)
    env.device.sessionTree.store.addLineage({
      ...lineage,
      threadId: 'grandchild',
      parentThreadId: childId,
    })
    for (const target of [threadId, unrelated, 'grandchild', 'missing']) {
      const answer = (
        await env.pi.callTool(threadId, SESSIONS, 'set_wake', { thread_id: target, wake: true })
      )?.answer
      assert.equal(answer.result.success, false)
      assert.equal(JSON.parse(answer.result.contentItems[0].text).error.code, 'forbidden')
    }
    assert.equal(
      failureOf(
        (await env.pi.callTool(threadId, SESSIONS, 'set_wake', { thread_id: childId, wake: 'no' }))
          ?.answer,
      ),
      'invalid',
    )
    assert.equal(
      failureOf(
        (
          await env.pi.callTool(threadId, SESSIONS, 'start', {
            title: '错误',
            ...brief('测试'),
            wake_parent: 'no',
          })
        )?.answer,
      ),
      'invalid',
    )
    await setWake(env, threadId, childId, true)
    assert.equal(env.device.sessionTree.lineage(childId)?.wakeParent, true)
  } finally {
    await env.close()
  }
})

test('SET-WAKE-002：关闭期间回报保留，重新开启检查排队回报并按正常条件唤醒', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await start(env, threadId, false)
    env.pi.end(threadId)
    await until(() => !env.device.sessionTree.isActive(threadId), '父会话结束')
    env.claude.end(childId, 'completed', '调研结果')
    await until(() => env.device.sessionTree.queuedNotes(threadId).length === 1, '仍入队')
    await settle(50)
    assert.equal(wakes(env, threadId).length, 0)
    assert.equal(env.device.sessionTree.queuedNotes(threadId)[0]?.excerpt, '调研结果')
    // 上限仍生效；开关不重置计数。
    env.device.sessionTree.store.setWakes(threadId, 50)
    await setWake(env, threadId, childId, true)
    await settle(50)
    assert.equal(wakes(env, threadId).length, 0)
    env.device.sessionTree.store.setWakes(threadId, 0)
    await setWake(env, threadId, childId, true)
    await until(() => wakes(env, threadId).length === 1, '恢复后唤醒')
    assert.equal(env.device.sessionTree.queuedNotes(threadId).length, 0)
  } finally {
    await env.close()
  }
})

test('SET-WAKE-003：排队后关闭立即生效，关闭期间仍可插入父会话在跑的回合', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = await start(env, threadId)
    const steer = env.pi.handlers['turn/steer']
    env.pi.handlers['turn/steer'] = () => {
      throw new Error('回合正在收尾')
    }
    env.claude.end(childId, 'completed', '结果')
    await until(() => env.device.sessionTree.queuedNotes(threadId).length === 1, '在跑时排队')
    await setWake(env, threadId, childId, false)
    env.pi.end(threadId)
    await settle(80)
    assert.equal(wakes(env, threadId).length, 0)
    assert.ok(steer)
    env.pi.handlers['turn/steer'] = steer
    env.pi.selfTurn(threadId)
    await until(() => env.device.sessionTree.queuedNotes(threadId).length === 0, '关闭仍插话交付')
  } finally {
    await env.close()
  }
})

test('SET-WAKE-004：重新开启不会将失败、用户停止、用户发起或定时回报升级为可唤醒', async () => {
  for (const reason of ['failed', 'stopped', 'user', 'schedule'] as const) {
    const env = treeRig()
    try {
      const client = await litch(env)
      const { threadId } = await parent(client)
      const childId = await start(env, threadId, false)
      env.pi.end(threadId)
      await until(() => !env.device.sessionTree.isActive(threadId), '父会话结束')
      if (reason === 'user' || reason === 'schedule') {
        env.claude.end(childId)
        await until(() => env.device.sessionTree.queuedNotes(threadId).length === 1, '初始回合回报')
        const notes = env.device.sessionTree.store.notes(threadId)
        env.device.sessionTree.store.dropNotes(threadId, Math.max(...notes.map((note) => note.seq)))
        if (reason === 'user') {
          await client.call('turn/start', {
            threadId: childId,
            input: [{ type: 'text', text: '用户直接要求', text_elements: [] }],
          })
        } else {
          const tasks = env.connect()
          await tasks.initialize(['harness', 'deviceTasks'])
          const { task } = await tasks.call('litch/task/create', {
            name: '定时检查',
            prompt: '检查',
            schedule: { type: 'interval', minutes: 30 },
            timezone: 'Asia/Shanghai',
            status: 'paused',
            target: { kind: 'thread', harness: 'claude-code', threadId: childId },
          })
          await tasks.call('litch/task/runNow', { id: task.id })
          await until(() => !!env.claude.current(childId), '定时回合开始')
        }
        env.claude.end(childId, 'completed', reason)
      } else if (reason === 'stopped') {
        await client.call('turn/interrupt', {
          threadId: childId,
          turnId: env.claude.current(childId)?.id,
        })
      } else env.claude.end(childId, 'failed', '失败')
      await until(() => env.device.sessionTree.queuedNotes(threadId).length === 1, '不可唤醒回报')
      await setWake(env, threadId, childId, true)
      await settle(60)
      assert.equal(wakes(env, threadId).length, 0, reason)
      assert.equal(env.device.sessionTree.queuedNotes(threadId).length, 1)
    } finally {
      await env.close()
    }
  }
})
