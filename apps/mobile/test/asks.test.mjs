// 模型边干活边问的题（src/detail/asks/AskCell.tsx 用的那几样）：会话存储认得出带题的消息、它在哪个回合，
// 答复直接插进还在跑的回合，答复表跟着更新。接在模拟核心上（话里带“边做边问”）。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { askReplyText, askState } from '@litch/core'
import { SessionStore } from '../src/core/session-store.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
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
  assert.equal(askState(questions, store.getAnswers(), true, meta.live), 'open')

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
  assert.equal(askState(questions, answers, true, true), 'answered')
  // 插进了同一个回合，没有排队，也没有另起一个回合
  const after = store.getMeta()
  assert.equal(after.queued.length, 0)
  assert.equal(after.lastTurn.id, meta.lastTurn.id)
  // 行晚一帧交出来
  await until(
    () =>
      store
        .getSnapshot()
        .rows.some((each) => each.type === 'user' && each.text === askReplyText(reply)),
    { what: '对话里有这条答复' },
  )
})
