import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import { questionsOfHistory } from '../../protocol/src/pending-history.mjs'
import type { SessionQuestionSettlement } from '../../protocol/src/session-pending.mjs'
import { asyncQuestion, wrapQuestion } from '../../protocol/test/pending-fixtures.mjs'
import { questionsOfView } from '../src/projection/pending-asks.mjs'
import { projectThread } from '../src/projection/session.mjs'
import { deviceWorld } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { thread, turn } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const source = () =>
  thread({ id: 'p', turns: [turn('t', [asyncQuestion(), wrapQuestion()] as ThreadItem[])] })
const recordsOf = (): SessionQuestionSettlement[] =>
  questionsOfHistory(source()).map((q, index) => ({
    id: String(index),
    questionId: q.sourceIds[0]!,
    threadId: 'p',
    sourceIds: q.sourceIds,
    replyIds: q.replyIds,
    title: q.title,
    action: index === 0 ? 'answer' : 'withdraw',
    text: index === 0 ? '只改 src' : '已取消',
    sourceThreadId: 'manager',
    sourceTitle: '经理',
    at: 1,
  }))

test('代答与撤回按来源派生，两端快照与设备历史一致；之后同题仍可提出', () => {
  const records = recordsOf()
  const raw = { ...source(), litchQuestionSettlements: records }
  const view = projectThread(raw, { deviceId: 'local', harness: 'pi' })
  assert.equal(questionsOfView(view).length, 0)
  assert.deepEqual(questionsOfHistory(raw, [], [], records), questionsOfView(view))
  raw.turns.push(turn('next', [asyncQuestion('next')] as ThreadItem[]))
  assert.equal(questionsOfView(projectThread(raw, { deviceId: 'local', harness: 'pi' })).length, 1)
  assert.equal(questionsOfHistory(raw, [], [], records).length, 1)
})

test('处理通知立即更新现有订阅和后来订阅的快照，不需要启动新回合', async () => {
  const world = deviceWorld([harness('pi', { threads: [source()] })], {
    prepare: (d) => {
      d.extensions.push('sessionTree')
    },
  })
  world.core.start()
  try {
    await settle()
    const a = watchSession(world.core, 'p')
    await settle()
    assert.ok(a.seen.view)
    assert.equal(questionsOfView(a.seen.view).length, 2)
    const records = recordsOf()
    world.peer.last().notify('litch/thread/questionSettlements/changed', {
      threadId: 'p',
      questionSettlements: records,
    })
    await settle()
    assert.equal(questionsOfView(a.seen.view).length, 0)
    assert.deepEqual(a.seen.view.questionSettlements, records)
    const b = watchSession(world.core, 'p')
    await settle()
    assert.deepEqual(b.seen.view?.questionSettlements, records)
    assert.equal(world.sent('turn/start').length, 0)
  } finally {
    world.core.stop()
  }
})
