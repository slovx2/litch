import assert from 'node:assert/strict'
import test from 'node:test'
import {
  askReplyText,
  connectChannel,
  createPortPair,
  createReplica,
  keys,
  serveChannel,
} from '@litch/core'
import { deviceWorld } from '../../../packages/core/test/device-world.mts'
import { harness } from '../../../packages/core/test/fake-device.mts'
import { thread, turn, userText } from '../../../packages/core/test/fixtures.mts'
import { asyncQuestion, wrapQuestion } from '../../../packages/protocol/test/pending-fixtures.mts'
import { translate } from '../../../packages/ui/src/i18n/index.ts'
import {
  historyQuestions,
  questionHistorySummary,
} from '../../../packages/ui/src/transcript/ask-history.ts'
import { SessionStore } from '../src/core/session-store.ts'
import { until } from './helpers.mjs'

test('正式通知同步手机与桌面：两类待答消失，原题留记录，用户答复覆盖摘要', async () => {
  const original = thread({ id: 'p', turns: [turn('t', [asyncQuestion(), wrapQuestion()])] })
  const env = deviceWorld([harness('pi', { threads: [original] })], {
    prepare: (device) => device.extensions.push('sessionTree'),
  })
  const clock = {
    now: Date.now,
    setTimer(callback, delay) {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
  }
  const [ui, server] = createPortPair()
  const unserve = serveChannel(server, env.core, { clock })
  const channel = connectChannel(ui)
  const store = new SessionStore(channel, 'local', 'p')
  const replica = createReplica(channel)
  const stopReplica = replica.start()
  const stopSession = replica.openSession('local', 'p')
  env.core.start()
  store.start()
  try {
    const desktop = () => replica.store.get(keys.pendingQuestions('local', 'p')) ?? []
    await until(() => store.getMeta()?.pendingQuestions.length === 2 && desktop().length === 2)
    const pending = store.getMeta().pendingQuestions
    const records = pending.map((q, index) => ({
      id: String(index),
      questionId: q.sourceIds[0],
      threadId: 'p',
      title: q.title,
      sourceIds: q.sourceIds,
      replyIds: q.replyIds,
      action: index === 0 ? 'answer' : 'withdraw',
      text: index === 0 ? '只改 src' : '任务已取消',
      sourceThreadId: 'm',
      sourceTitle: '经理',
      at: 1,
    }))
    env.peer.last().notify('litch/thread/questionSettlements/changed', {
      threadId: 'p',
      questionSettlements: records,
    })
    await until(() => store.getMeta()?.pendingQuestions.length === 0 && desktop().length === 0)
    assert.deepEqual(store.getMeta().questionSettlements, records)
    assert.deepEqual(replica.store.get(keys.questionSettlements('local', 'p')), records)
    const questions = pending.map((q) => ({ id: q.replyIds[0], title: q.title, options: [] }))
    const history = historyQuestions(questions, store.getMeta().pendingQuestions)
    const label = (action) => translate('zh-CN', `ask.manager.${action}`)
    assert.equal(
      questionHistorySummary(
        history,
        store.getAnswers(),
        store.getMeta().questionSettlements,
        label,
      ),
      '经理已代答: 只改 src · 经理已撤回: 任务已取消',
    )
    const user = userText(
      'override',
      askReplyText(
        records[0].replyIds.map((questionItemId) => ({
          questionItemId,
          question: records[0].title,
          answer: '用户要求全部修改',
        })),
      ),
    )
    env.peer.last().notify('turn/started', {
      threadId: 'p',
      turn: turn('user-turn', [], { status: 'inProgress' }),
    })
    env.peer.last().notify('item/completed', { threadId: 'p', turnId: 'user-turn', item: user })
    await until(() => store.getAnswers()[records[0].replyIds[0]] === '用户要求全部修改')
    assert.equal(
      questionHistorySummary(
        history,
        store.getAnswers(),
        store.getMeta().questionSettlements,
        label,
      ),
      '用户要求全部修改 · 经理已撤回: 任务已取消',
    )
    assert.deepEqual(store.getMeta().questionSettlements, records, '覆盖不删除历史记录')
  } finally {
    store.stop()
    stopSession()
    stopReplica()
    channel.close()
    unserve()
    env.core.stop()
  }
})
