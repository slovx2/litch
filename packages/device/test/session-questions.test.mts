// 忽略走设备持久化与通知；自动唤醒只按历史注入，不向执行中的回合重复送题。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TOOLS } from '../../protocol/src/client-tools-sessions.mjs'
import { questionsOfHistory } from '../../protocol/src/pending-history.mjs'
import { parseSessionEvent } from '../../protocol/src/session-tree.mjs'
import { asyncQuestion } from '../../protocol/test/pending-fixtures.mjs'
import { openSessionDatabase, SessionStore } from '../src/session-store.mjs'
import { resultOf } from './fake-engine.mjs'
import { brief, got, litch, parent, plain, SESSIONS, text, treeRig, until } from './tree-kit.mjs'

const events = (env: ReturnType<typeof treeRig>, id: string) =>
  env.pi
    .sent('turn/start')
    .filter((p) => p.threadId === id)
    .map((p) => parseSessionEvent(p.input[0].text).event)
    .filter(Boolean)

test('SESSION-QUESTIONS-001：同题忽略同步、持久化与重连，新来源可再次出现，不发送消息', async () => {
  const env = treeRig()
  try {
    const a = await litch(env)
    const b = await litch(env)
    const old = await plain(env)
    const { threadId } = await parent(a)
    env.pi.current(threadId)?.items.push(asyncQuestion('a'), asyncQuestion('b'))
    const history = await env.device.sessionTree.read(threadId, true)
    const [question] = questionsOfHistory(history.thread)
    assert.ok(question)
    assert.equal(question.sourceIds.length, 2)
    const before = env.pi.sent('turn/start').length + env.pi.sent('turn/steer').length
    const params = { threadId, sourceIds: question.sourceIds }
    const first = await a.call('litch/session/questions/ignore', params)
    assert.equal(first.ignoredQuestions.length, 2)
    assert.deepEqual(await b.call('litch/session/questions/ignore', params), first)
    assert.equal(env.pi.sent('turn/start').length + env.pi.sent('turn/steer').length, before)
    await until(() => got(b, 'litch/thread/questions/changed').length > 0, '跨端通知')
    assert.equal(got(b, 'litch/thread/questions/changed').at(-1).ignoredQuestions.length, 2)
    assert.equal(got(old, 'litch/thread/questions/changed').length, 0)
    await old.fails('litch/session/questions/ignore', params)
    assert.equal(
      (await old.call('thread/read', { threadId })).thread.litchIgnoredQuestions,
      undefined,
    )
    const reconnected = await litch(env)
    assert.deepEqual(
      (await reconnected.call('thread/read', { threadId })).thread.litchIgnoredQuestions,
      first.ignoredQuestions,
    )
    const db = openSessionDatabase(env.stateDir)
    try {
      assert.deepEqual(new SessionStore(db).ignoredQuestions(threadId), first.ignoredQuestions)
    } finally {
      db.close()
    }
    env.pi.current(threadId)?.items.push(asyncQuestion('new'))
    const next = await env.device.sessionTree.read(threadId, true)
    assert.equal(questionsOfHistory(next.thread, first.ignoredQuestions)[0]?.ignored, false)
  } finally {
    await env.close()
  }
})

test('SESSION-QUESTIONS-002：wake 含忽略标记和原文，steerNotes 不读历史、不附题', async () => {
  const env = treeRig()
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    const childId = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'start', {
          title: '子任务',
          ...brief('检查'),
          initiation: 'user_asked',
          harness: 'claude-code',
        })
      )?.answer,
    ).thread_id
    env.pi.current(threadId)?.items.push(asyncQuestion())
    const history = await env.device.sessionTree.read(threadId, true)
    await client.call('litch/session/questions/ignore', {
      threadId,
      sourceIds: questionsOfHistory(history.thread)[0]?.sourceIds,
    })
    const reads = env.pi
      .sent('thread/read')
      .filter((p) => p.threadId === threadId && p.includeTurns).length
    env.claude.end(childId, 'completed', '第一次完成')
    await until(() => env.pi.sent('turn/steer').length > 0, '插入回报')
    assert.equal(
      env.pi.sent('thread/read').filter((p) => p.threadId === threadId && p.includeTurns).length,
      reads,
    )
    assert.equal(
      parseSessionEvent(env.pi.sent('turn/steer').at(-1).input[0].text).event?.pendingQuestions,
      undefined,
    )
    env.pi.end(threadId, 'completed', '暂时结束')
    await until(() => !env.device.sessionTree.isActive(threadId), '父回合结束')
    env.claude.selfTurn(childId)
    env.claude.end(childId, 'completed', '第二次完成')
    await until(() => events(env, threadId).some((e) => e?.kind === 'wake'), '唤醒')
    const event = events(env, threadId).find((e) => e?.kind === 'wake')
    assert.deepEqual(event?.pendingQuestions, [
      {
        title: '范围？',
        options: [
          { label: '只改 src', answer: '只改 src' },
          { label: '全部', answer: '全部' },
        ],
        ignored: true,
      },
    ])
    const input = env.pi.sent('turn/start').at(-1).input[0].text
    assert.match(input, /用户已忽略/)
    assert.equal(parseSessionEvent(input).rest, '', '注入不是用户正文')
  } finally {
    await env.close()
  }
})

test('SESSION-QUESTIONS-003：remind 附未答题，失败读取照常提醒并记诊断', async () => {
  for (const failing of [false, true]) {
    const logs: string[] = []
    const env = treeRig({}, { log: (line) => logs.push(line) })
    try {
      const client = await litch(env)
      const { thread } = await client.call('thread/start', {
        harness: 'pi',
        cwd: '/work',
        dynamicTools: [SESSION_TOOLS],
      })
      await client.call('turn/start', { threadId: thread.id, input: text('做事') })
      env.pi.current(thread.id)?.items.push(asyncQuestion())
      if (failing) {
        const read = env.pi.handlers['thread/read']
        assert.ok(read)
        env.pi.handlers['thread/read'] = (p, c) => {
          if (p.includeTurns) throw new Error('history unavailable')
          return read(p, c)
        }
      }
      env.pi.end(thread.id, 'completed', '结束，漏收尾')
      await until(() => events(env, thread.id).some((e) => e?.kind === 'remind'), '提醒')
      const event = events(env, thread.id).find((e) => e?.kind === 'remind')
      if (failing) {
        assert.equal(event?.pendingQuestions, undefined)
        assert.ok(logs.some((s) => s.includes('跳过注入')))
      } else assert.equal(event?.pendingQuestions?.[0]?.title, '范围？')
    } finally {
      await env.close()
    }
  }
})
