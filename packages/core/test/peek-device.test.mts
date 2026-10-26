// session.peek 经设备：没打开的会话向对面要最近一个回合（带条目）再抽，打开着的从核心自己的视图取，不再问对面
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

function peekWorld() {
  const codex = harness('codex', {
    declaration: { extensions: [], features: features() },
    threads: [
      thread({
        id: 's',
        updatedAt: 1_700_000_300,
        turns: [
          turn('t1', [userText('u1', '早先的'), agentText('a1', '早先的回答')]),
          turn('t2', [userText('u2', '看看'), agentText('a2', '看完了，**一切正常**。')]),
        ],
      }),
    ],
  })
  return deviceWorld([codex])
}

test('设备：没打开的会话问对面最近一个回合（带条目），打开着的从核心的视图取', async () => {
  const world = peekWorld()
  world.core.start()
  await settle()
  const closed = await world.command('session.peek', { sessionId: 's' })
  assert.deepEqual(closed, { answer: '看完了，**一切正常**。', error: null, pending: null })
  assert.deepEqual(
    world.sent('thread/turns/list').map((params) => [params.limit, params.itemsView]),
    [[1, 'full']],
  )
  watchSession(world.core, 's')
  await settle()
  const open = await world.command('session.peek', { sessionId: 's' })
  assert.deepEqual(open, closed)
  assert.equal(world.sent('thread/turns/list').length, 1, '开着的不再问对面')
})
