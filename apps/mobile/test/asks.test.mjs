// 模型边干活边问的题（src/detail/asks/AskCell.tsx 用的那几样）：会话存储认得出带题的消息、它在哪个回合，
// 答复直接插进还在跑的回合，答复表跟着更新。接在模拟核心上（话里带“边做边问”）。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { askReplyText, askState, createReplica, keys, pendingReplyText } from '@litch/core'
import { SessionStore } from '../src/core/session-store.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
})

test('桌面副本和手机存储：收尾提问后子会话回报开新回合，问题仍可答，答复只收起对应题', async () => {
  const mock = mockChannel({ chunkMs: 10 })
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '收尾后回报',
  })
  const where = { deviceId: 'local', sessionId }
  const store = new SessionStore(mock.channel, 'local', sessionId)
  const replica = createReplica(mock.channel)
  const stopReplica = replica.start()
  const stopSession = replica.openSession('local', sessionId)
  store.start()
  cleanup.push(() => {
    store.stop()
    stopSession()
    stopReplica()
    mock.close()
  })
  const pending = () => store.getMeta()?.pendingQuestions ?? []
  const desktop = () => replica.store.get(keys.pendingQuestions('local', sessionId)) ?? []
  await until(() => pending().length === 1 && desktop().length === 1, { what: '两端收尾问题' })
  const firstTurn = store.getMeta().lastTurn.id
  const original = pending()[0]
  // 派子会话的用户回合之后，两个子会话结束会自动唤醒父会话。
  await until(
    () => {
      const ids = replica.store.get(keys.turnIds('local', sessionId)) ?? []
      const last = replica.store.get(keys.turn('local', sessionId, ids.at(-1) ?? ''))
      const first = replica.store.get(keys.item('local', sessionId, last?.itemIds[0] ?? ''))
      return (
        first?.event?.kind === 'wake' &&
        store.getMeta()?.lastTurn.id === last.id &&
        !store.getMeta()?.running
      )
    },
    { timeoutMs: 15000, what: '子会话回报唤醒父会话' },
  )
  assert.notEqual(store.getMeta().lastTurn.id, firstTurn)
  await until(() => pending().length === 3 && desktop().length === 3, { what: '新旧问题并存' })
  assert.equal(pending()[0].id, original.id)
  assert.equal(pending()[0].replyIds.length, 2, '自动回合重复提问只画一份')
  assert.deepEqual(pending(), desktop())
  await mock.channel.command('session.send', {
    ...where,
    text: pendingReplyText(pending()[0], '请继续修复'),
    now: true,
  })
  await until(() => pending().length === 2 && desktop().length === 2, {
    what: '只收起已回答的问题',
  })
  assert.ok(pending().every((q) => q.id !== original.id))
  await mock.channel.command('session.send', {
    ...where,
    text: '我自己输入回答：运行测试，保存在当前目录',
    now: true,
  })
  await until(() => pending().length === 0 && desktop().length === 0, {
    what: '真实用户发话收起此前的题',
  })
})

test('边做边问：卡片要的题目、回合、答复表都对，答复插进还在跑的回合', async () => {
  const mock = mockChannel()
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '边做边问：跑一下测试',
  })
  const store = new SessionStore(mock.channel, 'local', sessionId)
  cleanup.push(() => {
    store.stop()
    mock.close()
  })
  store.start()
  // 带题的消息照常切成 Markdown 块，第一块的条目上有题
  const row = await until(
    () =>
      store
        .getSnapshot()
        .rows.find((each) => each.type === 'md' && each.first && store.questionsOf(each.itemId)),
    { what: '带题的消息' },
  )
  const questions = store.questionsOf(row.itemId)
  assert.equal(questions.length, 2)
  assert.deepEqual(questions[0].options.length, 2)
  assert.deepEqual(questions[1].options, [])
  const meta = store.getMeta()
  assert.equal(meta.running, true)
  assert.equal(store.turnOf(row.itemId), meta.lastTurn.id)
  assert.equal(askState(questions, store.getAnswers(), meta.live), 'open')

  const reply = [
    { questionItemId: questions[0].id, question: questions[0].title, answer: '照常全跑' },
  ]
  await mock.channel.command('session.send', {
    deviceId: 'local',
    sessionId,
    text: askReplyText(reply),
    now: true,
  })
  const answers = await until(
    () => (store.getAnswers()[questions[0].id] ? store.getAnswers() : null),
    { what: '答复表更新' },
  )
  assert.equal(answers[questions[0].id], '照常全跑')
  assert.equal(answers[questions[1].id], undefined)
  assert.equal(askState(questions, answers, true), 'open')
  // 插进了同一个回合，没有排队，也没有另起一个回合
  const after = store.getMeta()
  assert.equal(after.queued.length, 0)
  assert.equal(after.lastTurn.id, meta.lastTurn.id)
  // 答案并进问题卡：问题那一条还在会话里，答复不另画用户气泡。行晚一帧交出来，等答复所在的回合重算完再看
  await until(() => store.getSnapshot().rows.some((each) => each.key === row.key), {
    what: '问题卡还在',
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(
    store
      .getSnapshot()
      .rows.some((each) => each.type === 'user' && each.text === askReplyText(reply)),
    false,
  )
})
