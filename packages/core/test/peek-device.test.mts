// session.peek 经设备：没打开的会话向对面要最近一个回合（带条目）再抽，打开着的从核心自己的视图取，不再问对面
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionPeek } from '../src/model.mjs'
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

test('历史回报按 turnId 读取原回答：已打开也不误用最新回答，缺失不替换', async () => {
  const world = peekWorld()
  world.core.start()
  await settle()
  watchSession(world.core, 's')
  await settle()
  assert.equal(
    ((await world.command('session.peek', { sessionId: 's', turnId: 't1' })) as SessionPeek).answer,
    '早先的回答',
  )
  assert.equal(
    ((await world.command('session.peek', { sessionId: 's', turnId: 'missing' })) as SessionPeek)
      .answer,
    null,
  )
  assert.ok(world.sent('thread/turns/list').every((params) => params.itemsView === 'full'))
  world.core.stop()
})

test('历史回报按游标继续翻页，不受最近二十回合限制', async () => {
  const pages: unknown[] = []
  const codex = harness('codex', {
    declaration: { extensions: [], features: features() },
    threads: [thread({ id: 's' })],
  })
  const world = deviceWorld([codex], {
    extra: {
      'thread/turns/list': (params) => {
        const page = params as { cursor?: string | null; itemsView?: string }
        pages.push(page)
        return page.cursor === 'older'
          ? {
              data: [turn('original', [agentText('a', '原回合完整正文')])],
              nextCursor: null,
              backwardsCursor: null,
            }
          : {
              data: [turn('new', [agentText('b', '后续回答')])],
              nextCursor: 'older',
              backwardsCursor: null,
            }
      },
    },
  })
  world.core.start()
  await settle()
  const result = (await world.command('session.peek', {
    sessionId: 's',
    turnId: 'original',
  })) as SessionPeek
  assert.equal(result.answer, '原回合完整正文')
  assert.equal(pages.length, 2)
  world.core.stop()
})
