// 会话树里子会话“怎么停下的”：回合失败、被打断时回报带上错误原文，只进队列不唤醒（同 Claude 桌面端），
// 模型自己用 litch_sessions 打断的也一样，只是不算用户停的；用户亲手停掉、归档的子会话只记回报不唤醒父会话，注明怎么停的；
// 删会话时它带的动态工具一并删掉，之前留下的在启动时清掉。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  formatSessionEvent,
  parseSessionEvent,
  SESSION_TREE_LIMITS,
} from '../../protocol/src/session-tree.mjs'
import { resultOf } from './fake-engine.mjs'
import { settle } from './helpers.mjs'
import {
  brief,
  ECHO_SPEC,
  litch,
  parent,
  refuseSteer,
  SESSIONS,
  text,
  treeRig,
  until,
} from './tree-kit.mjs'

const wakesOf = (env: ReturnType<typeof treeRig>, threadId: string) =>
  env.pi
    .sent('turn/start')
    .filter((params) => params.threadId === threadId)
    .map((params) => parseSessionEvent(params.input[0].text).event)
    .filter((event) => event?.kind === 'wake')

/** pi 上的父会话（用户回合里）让模型派一个 claude-code 的子会话，派的回合还在跑 */
async function family(env: ReturnType<typeof treeRig>) {
  const client = await litch(env)
  const { threadId } = await parent(client)
  const childId = resultOf(
    (
      await env.pi.callTool(threadId, SESSIONS, 'start', {
        title: '子任务',
        ...brief('做点事。'),
        harness: 'claude-code',
        initiation: 'user_asked',
      })
    )?.answer,
  ).thread_id as string
  return { client, threadId, childId }
}

const notesOf = (env: ReturnType<typeof treeRig>, threadId: string) =>
  env.device.sessionTree.store.notes(threadId)

test('SESSION-STOP-001：子会话的回合失败、被打断：回报带上回合的错误原文，长的截到回报长度以内，给模型的那一行也写上；不唤醒，下一回合带上', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const { client, threadId, childId } = await family(env)
    env.claude.end(
      childId,
      'failed',
      '做了一半',
      'Subagent timed out: no subagent activity for 1800 seconds.',
    )
    await until(() => notesOf(env, threadId).length === 1, '失败的回报进队列')
    const [failed] = notesOf(env, threadId)
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.excerpt, '做了一半')
    assert.equal(failed?.error, 'Subagent timed out: no subagent activity for 1800 seconds.')
    assert.equal(failed?.wake, false, '出错的回合不算该唤醒的（同 Claude 桌面端）')
    env.pi.end(threadId)
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 0, '失败的不唤醒')
    await client.call('turn/start', { threadId, input: text('那个怎么样了') })
    const sent = env.pi.sent('turn/start').at(-1).input[0].text as string
    assert.equal(parseSessionEvent(sent).event?.notes[0]?.error, failed?.error)
    assert.match(sent, /failed: 做了一半 \(error: Subagent timed out: no subagent activity/)

    // 打断的、错误很长的：截到 noteChars 以内；回合结束的通知里没带错误时，读一遍会话补上
    env.pi.end(threadId)
    const turn = env.claude.selfTurn(childId)
    const long = `E${'x'.repeat(2000)}`
    turn.error = { message: long }
    turn.status = 'interrupted'
    env.claude.notify('turn/completed', {
      threadId: childId,
      turn: { ...turn, items: [], error: null },
    })
    await until(() => notesOf(env, threadId).length === 1, '打断的回报进队列')
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 0, '打断的也不唤醒')
    const [interrupted] = notesOf(env, threadId)
    assert.equal(interrupted?.status, 'interrupted')
    assert.equal(interrupted?.error?.length, SESSION_TREE_LIMITS.noteChars)
    assert.ok(interrupted?.error?.startsWith('Exxx'))
  } finally {
    await env.close()
  }
})

test('SESSION-STOP-002：用户在子会话里点停止（客户端的 turn/interrupt）：只记回报、注明是用户停的，不唤醒；父会话下一回合看得到', async () => {
  const env = treeRig()
  try {
    const { client, threadId, childId } = await family(env)
    env.pi.end(threadId)
    const turnId = env.claude.current(childId)?.id
    await client.call('turn/interrupt', { threadId: childId, turnId })
    await until(() => notesOf(env, threadId).length === 1, '回报照进队列')
    const [note] = notesOf(env, threadId)
    assert.equal(note?.status, 'interrupted')
    assert.equal(note?.userStopped, 'interrupted')
    assert.equal(note?.wake, false)
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0, '用户停掉的不唤醒父会话')
    await client.call('turn/start', { threadId, input: text('子任务怎么样了') })
    const sent = env.pi.sent('turn/start').at(-1).input[0].text as string
    const event = parseSessionEvent(sent).event
    assert.equal(event?.kind, 'notes')
    assert.equal(event?.notes[0]?.userStopped, 'interrupted')
    assert.match(sent, /interrupted \(stopped by the user\)/)
  } finally {
    await env.close()
  }
})

test('SESSION-STOP-003：用户归档在跑的子会话：回合被打断的回报不唤醒、注明已归档；已经排着的回报也不再唤醒', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const { client, threadId, childId } = await family(env)
    env.pi.end(threadId)
    await client.call('thread/archive', { threadId: childId })
    await until(() => notesOf(env, threadId).length === 1, '回报照进队列')
    const [note] = notesOf(env, threadId)
    assert.equal(note?.userStopped, 'archived')
    assert.equal(note?.wake, false)
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0)
    assert.match(
      formatSessionEvent({ kind: 'notes', notes: [note as never] }),
      /\(archived by the user\)/,
    )

    // 子会话先自己做完（回报要唤醒）、父会话还在跑，用户随后归档了它：排着的那条不再唤醒
    await client.call('turn/start', { threadId, input: text('再派一个') })
    const second = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '第二个',
          ...brief('做点别的。'),
          harness: 'claude-code',
          initiation: 'user_asked',
        })
      )?.answer,
    ).thread_id as string
    env.claude.end(second, 'completed', '做完了')
    // 用户那句话把第一条回报带走了，队列里只有第二个的
    await until(() => notesOf(env, threadId).length === 1, '第二个的回报进队列')
    assert.equal(notesOf(env, threadId).at(-1)?.wake, true)
    await client.call('thread/archive', { threadId: second })
    await until(() => notesOf(env, threadId).at(-1)?.wake === false, '排着的回报不再唤醒')
    assert.equal(notesOf(env, threadId).at(-1)?.userStopped, 'archived')
    env.pi.end(threadId)
    await settle(80)
    assert.equal(wakesOf(env, threadId).length, 0)
  } finally {
    await env.close()
  }
})

test('SESSION-STOP-004：模型自己用 litch_sessions 打断子会话：回报不算用户停的；被打断的回合同出错的，不唤醒', async () => {
  const env = treeRig()
  refuseSteer(env.pi)
  try {
    const { threadId, childId } = await family(env)
    const answer = await env.pi.callTool(threadId, SESSIONS, 'interrupt', { thread_id: childId })
    assert.equal(resultOf(answer?.answer).note, 'Interrupted its running turn.')
    await until(() => notesOf(env, threadId).length === 1, '回报进队列')
    const [note] = notesOf(env, threadId)
    assert.equal(note?.status, 'interrupted')
    assert.equal(note?.userStopped, undefined)
    assert.equal(note?.wake, false)
    env.pi.end(threadId)
    await settle(60)
    assert.equal(wakesOf(env, threadId).length, 0, '模型打断的也不唤醒')
  } finally {
    await env.close()
  }
})

test('SESSION-STOP-005：删会话时它带的动态工具一并删掉；之前留下的、设备不认识的会话的那一行在启动时清掉', async () => {
  const env = treeRig()
  const reopened: ReturnType<typeof treeRig>[] = []
  try {
    const client = await litch(env)
    const { threadId: kept } = await parent(client, false)
    const { threadId: gone } = await parent(client, false)
    const store = env.device.sessionTree.store
    const echo = (tools: unknown[] | null) =>
      tools?.some((tool) => (tool as { name?: string }).name === ECHO_SPEC.name) === true
    assert.ok(echo(store.tools(kept)))
    assert.ok(echo(store.tools(gone)))
    await client.call('thread/delete', { threadId: gone })
    assert.equal(store.tools(gone), null, '删会话时一并删掉')
    assert.ok(echo(store.tools(kept)))

    // 修之前删掉的会话留下的行：设备进程重启时清掉，认识的会话不动
    await env.device.close()
    const db = new DatabaseSync(join(env.stateDir, 'sessions.sqlite'))
    db.prepare('INSERT INTO thread_tools(thread_id, tools) VALUES(?, ?)').run('left-over', '[]')
    db.close()
    const again = treeRig({}, { stateDir: env.stateDir })
    reopened.push(again)
    assert.equal(again.device.sessionTree.store.tools('left-over'), null, '残留的行启动时清掉')
    assert.ok(echo(again.device.sessionTree.store.tools(kept)), '认识的会话不动')
  } finally {
    for (const one of reopened) await one.device.close()
    await env.close()
  }
})
