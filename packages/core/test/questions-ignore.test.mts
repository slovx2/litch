import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import { asyncQuestion } from '../../protocol/test/pending-fixtures.mjs'
import { questionsOfView } from '../src/projection/pending-asks.mjs'
import { deviceWorld } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { thread, turn } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

test('忽略命令和其他客户端的通知都更新打开的会话，后来订阅的快照保留忽略状态', async () => {
  const source = thread({ id: 'p', turns: [turn('t', [asyncQuestion() as ThreadItem])] })
  const world = deviceWorld([harness('pi', { threads: [source] })], {
    prepare: (d) => {
      d.extensions.push('sessionTree', 'sessionQuestionIgnore')
    },
    extra: {
      'litch/session/questions/ignore': (p) => ({
        ignoredQuestions: (p as { sourceIds: string[] }).sourceIds,
      }),
    },
  })
  world.core.start()
  await settle()
  const a = watchSession(world.core, 'p')
  await settle()
  assert.ok(a.seen.view)
  const [q] = questionsOfView(a.seen.view)
  assert.ok(q)
  await world.command('session.questions.ignore', { sessionId: 'p', sourceIds: q.sourceIds })
  await settle()
  assert.ok(questionsOfView(a.seen.view).every((q) => q.ignored))
  const b = watchSession(world.core, 'p')
  await settle()
  assert.deepEqual(b.seen.view?.ignoredQuestions, q.sourceIds)
  world.peer
    .last()
    .notify('litch/thread/questions/changed', { threadId: 'p', ignoredQuestions: [] })
  await settle()
  assert.ok(questionsOfView(a.seen.view).every((q) => !q.ignored))
  assert.deepEqual(b.seen.view?.ignoredQuestions, [])
  assert.equal(world.sent('turn/start').length, 0)
  assert.equal(world.sent('turn/steer').length, 0)
  world.core.stop()
})

test('忽略能力单独声明：旧设备虽有会话树也不展示该能力，命令不会发送', async () => {
  for (const supported of [false, true]) {
    const world = deviceWorld([harness('pi')], {
      prepare: (d) => {
        d.extensions.push('sessionTree')
        if (supported) d.extensions.push('sessionQuestionIgnore')
      },
    })
    world.core.start()
    await settle()
    assert.equal(world.device()?.ignoreQuestions, supported)
    if (!supported) {
      await assert.rejects(
        world.command('session.questions.ignore', { sessionId: 'p', sourceIds: [] }),
        /不支持忽略问题/,
      )
      assert.equal(world.sent('litch/session/questions/ignore').length, 0)
    }
    world.core.stop()
  }
})
