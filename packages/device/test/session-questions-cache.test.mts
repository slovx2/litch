import assert from 'node:assert/strict'
import test from 'node:test'
import {
  asyncQuestion,
  message,
  reportText,
  turn,
  wrapQuestion,
} from '../../protocol/test/pending-fixtures.mjs'
import { SessionQuestions } from '../src/session-questions.mjs'

const tid = 'parent'
const itemEvent = (cache: SessionQuestions, item: unknown) =>
  cache.event('item/completed', { threadId: tid, item })

test('QUESTION-CACHE-001：已知无题的五十轮普通输出只整读一次，新题通知后才重读', async () => {
  const cache = new SessionQuestions()
  let reads = 0
  let history = { turns: [turn('t0', [])] }
  const load = async () => {
    reads++
    return history
  }
  assert.deepEqual(await cache.read(tid, load), [])
  for (let i = 0; i < 50; i++) {
    itemEvent(cache, { type: 'agentMessage', text: '继续工作', id: `plain-${i}` })
    itemEvent(cache, message(reportText))
    cache.event('turn/completed', { threadId: tid, turn: turn(`t${i}`, [message('普通消息')]) })
    assert.deepEqual(await cache.read(tid, load), [])
  }
  assert.equal(reads, 1)
  history = { turns: [turn('t1', [asyncQuestion()])] }
  itemEvent(cache, asyncQuestion())
  assert.equal((await cache.read(tid, load))[0]?.title, '范围？')
  assert.equal(reads, 2)
  for (let i = 0; i < 50; i++) {
    itemEvent(cache, message(reportText))
    itemEvent(cache, { ...message('同伴说话'), litchPeer: { name: '同伴' } })
    itemEvent(cache, wrapQuestion('empty', { ask: '' }))
    assert.equal((await cache.read(tid, load)).length, 1)
  }
  assert.equal(reads, 2, '非答复、非提问的回报和收尾不重读')
})

test('QUESTION-CACHE-002：用户回复、撤回和回退使缓存失效，读失败不缓存空集合', async () => {
  const cache = new SessionQuestions()
  let reads = 0
  let history = { turns: [turn('t1', [asyncQuestion()])] }
  const load = async () => {
    reads++
    return history
  }
  await cache.read(tid, load)
  itemEvent(cache, message('用户改变方向'))
  history = { turns: [...history.turns, turn('t2', [message('用户改变方向')])] }
  assert.deepEqual(await cache.read(tid, load), [])
  assert.equal(reads, 2)
  cache.event('thread/reverted', { threadId: tid })
  history = { turns: [turn('t1', [asyncQuestion()])] }
  assert.equal((await cache.read(tid, load)).length, 1)
  itemEvent(cache, wrapQuestion('withdraw', { ask: '', withdraw_questions: ['范围？'] }))
  await assert.rejects(
    cache.read(tid, async () => {
      throw new Error('offline')
    }),
    /offline/,
  )
  history.turns.push(
    turn('t2', [wrapQuestion('withdraw', { ask: '', withdraw_questions: ['范围？'] })]),
  )
  assert.deepEqual(await cache.read(tid, load), [])
  assert.equal(reads, 4)
  cache.clear(tid)
  await assert.rejects(
    cache.read(tid, async () => ({})),
    /includeTurns/,
  )
  await cache.read(tid, load)
  assert.equal(reads, 5)
})

test('QUESTION-CACHE-003：读取中用户插话、断连或回退，旧结果不成为缓存', async () => {
  for (const invalidate of [
    (c: SessionQuestions) => itemEvent(c, message('改问')),
    (c: SessionQuestions) => c.clear(),
    (c: SessionQuestions) => c.event('thread/reverted', { threadId: tid }),
  ]) {
    const cache = new SessionQuestions()
    let finish: (thread: Record<string, unknown>) => void = () => {}
    const pending = cache.read(
      tid,
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    invalidate(cache)
    finish({ turns: [turn('old', [asyncQuestion()])] })
    assert.deepEqual(await pending, [])
    assert.deepEqual(await cache.read(tid, async () => ({ turns: [] })), [])
  }
})

test('QUESTION-CACHE-004：自动回合中途的用户插话同样使旧问题失效', async () => {
  const cache = new SessionQuestions()
  let reads = 0
  const load = async () => {
    reads++
    return { turns: [turn('t0', [asyncQuestion()])] }
  }
  await cache.read(tid, load)
  cache.event('turn/completed', {
    threadId: tid,
    turn: turn('background', [message('自动继续'), message('用户插话', 'u2')], {
      litchOrigin: 'backgroundTask',
    }),
  })
  await cache.read(tid, load)
  assert.equal(reads, 2)
})

test('QUESTION-CACHE-005：回合中缓存过已完成的收尾条目，回合结束后重新读入问题', async () => {
  for (const warm of [true, false]) {
    const cache = new SessionQuestions()
    let reads = 0
    let history = { turns: [turn('t1', [])] }
    const load = async () => {
      reads++
      return history
    }
    if (warm) await cache.read(tid, load)
    const item = wrapQuestion()
    cache.event('item/completed', { threadId: tid, turnId: 't1', item })
    history = { turns: [turn('t1', [item], { status: 'inProgress' })] }
    assert.deepEqual(await cache.read(tid, load), [])
    const before = reads
    // 其他回合结束不能提前消费标记；完成通知不保证携带条目。
    cache.event('turn/completed', { threadId: tid, turn: { id: 'other' } })
    assert.deepEqual(await cache.read(tid, load), [])
    assert.equal(reads, before)
    history = { turns: [turn('t1', [item])] }
    cache.event('turn/completed', { threadId: tid, turn: { id: 't1' } })
    assert.equal((await cache.read(tid, load))[0]?.title, '继续？')
    assert.equal(reads, before + 1)
    cache.event('turn/completed', { threadId: tid, turn: { id: 't2' } })
    assert.equal((await cache.read(tid, load))[0]?.title, '继续？')
    assert.equal(reads, before + 1, '标记消费后普通回合不重读')
  }
})

test('QUESTION-CACHE-006：冷读途中回合结束，运行中快照不能缓存为最终结果', async () => {
  const cache = new SessionQuestions()
  let finish: (thread: Record<string, unknown>) => void = () => {}
  const pending = cache.read(
    tid,
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  cache.event('turn/completed', { threadId: tid, turn: { id: 't1' } })
  finish({ turns: [turn('t1', [wrapQuestion()], { status: 'inProgress' })] })
  assert.deepEqual(await pending, [])
  const questions = await cache.read(tid, async () => ({
    turns: [turn('t1', [wrapQuestion()])],
  }))
  assert.equal(questions[0]?.title, '继续？')
})
