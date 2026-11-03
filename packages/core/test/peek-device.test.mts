// session.peek 经设备：没打开的会话向对面要最近一个回合（带条目）再抽，打开着的从核心自己的视图取，不再问对面
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionPeek } from '../src/model.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { RpcFailure } from './fake-server.mjs'
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

// Codex 完成事件带 summary；Claude 普通回合可只带 notLoaded，其他入口带完整回合。
for (const id of ['codex', 'claude-code', 'pi', 'dsh', 'opencode', 'acp']) {
  test(`${id}：未打开会话保留生命周期正文，不依赖历史读取`, async (t) => {
    const world = deviceWorld([harness(id, { threads: [thread({ id: 's' })] })], {
      extra: {
        'thread/turns/list': () => {
          throw new RpcFailure(-32603, '不应读取慢历史')
        },
      },
    })
    t.after(() => world.core.stop())
    world.core.start()
    await settle()
    const notify = (method: string, params: object) =>
      world.peer.last().notify(method, { threadId: 's', ...params })
    const answer = agentText('answer', `**${id}** 的最后回答`)
    notify('turn/started', { turn: turn('new', [], { status: 'inProgress' }) })
    notify('item/completed', { turnId: 'new', item: agentText('comment', '过程旁白') })
    notify('item/agentMessage/delta', { turnId: 'new', itemId: 'answer', delta: `**${id}** 的` })
    notify('item/agentMessage/delta', { turnId: 'new', itemId: 'answer', delta: '最后回答' })
    const items = id === 'claude-code' ? [] : [answer]
    notify('turn/completed', {
      turn: turn('new', items, {
        itemsView: id === 'codex' ? 'summary' : id === 'claude-code' ? 'notLoaded' : 'full',
      }),
    })
    await settle()
    assert.deepEqual(await world.command('session.peek', { sessionId: 's' }), {
      answer: `**${id}** 的最后回答`,
      error: null,
      pending: null,
    })
    assert.equal(world.sent('thread/turns/list').length, 0)
    // 新回合只用了工具：不能沿用上一回合的正文。
    notify('turn/started', { turn: turn('tools', [], { status: 'inProgress' }) })
    notify('turn/completed', { turn: turn('tools', []) })
    await settle()
    assert.deepEqual(await world.command('session.peek', { sessionId: 's' }), {
      answer: null,
      error: null,
      pending: null,
    })
    notify('turn/started', { turn: turn('failed', [], { status: 'inProgress' }) })
    notify('turn/completed', {
      turn: turn('failed', [], {
        status: 'failed',
        error: {
          message: '模型请求失败',
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
        },
      }),
    })
    await settle()
    assert.deepEqual(await world.command('session.peek', { sessionId: 's' }), {
      answer: null,
      error: '模型请求失败',
      pending: null,
      outcome: 'failed',
    })
  })
}

test('Codex 大历史慢读：idle 先到，稍后的完成摘要立即提供正文，历史超时有日志', async (t) => {
  const large = Array.from({ length: 100 }, (_, i) =>
    turn(`old-${i}`, [agentText(`a-${i}`, '旧正文'.repeat(20_000))]),
  )
  const world = deviceWorld([harness('codex', { threads: [thread({ id: 's', turns: large })] })], {
    extra: { 'thread/turns/list': () => new Promise(() => {}) },
  })
  t.after(() => world.core.stop())
  world.core.start()
  await settle()
  const peer = world.peer.last()
  peer.notify('thread/status/changed', {
    threadId: 's',
    status: { type: 'active', activeFlags: [] },
  })
  peer.notify('thread/status/changed', { threadId: 's', status: { type: 'idle' } })
  await settle()
  let answer: unknown
  const peek = world.command('session.peek', { sessionId: 's' }).then((value) => {
    answer = value
  })
  await settle()
  assert.equal(world.sent('thread/turns/list').length, 1)
  assert.equal(answer, undefined)
  peer.notify('turn/completed', {
    threadId: 's',
    turn: turn('latest', [agentText('final', '本回合完整正文')], { itemsView: 'summary' }),
  })
  await settle()
  assert.deepEqual(answer, { answer: '本回合完整正文', error: null, pending: null })
  await peek
  world.time.advance(3001)
  await settle()
  assert.ok(world.logs.some((line) => line.includes('通知正文失败')))
})

test('已打开的 Codex：完成摘要补齐已有回合，缺失的 final 不再丢弃或重复', async (t) => {
  const world = peekWorld()
  t.after(() => world.core.stop())
  world.core.start()
  await settle()
  const watched = watchSession(world.core, 's')
  await settle()
  const peer = world.peer.last()
  peer.notify('turn/started', { threadId: 's', turn: turn('new', [], { status: 'inProgress' }) })
  const completed = {
    threadId: 's',
    turn: turn('new', [agentText('final', '只在完成摘要出现的回答')], { itemsView: 'summary' }),
  }
  peer.notify('turn/completed', completed)
  peer.notify('turn/completed', completed)
  await settle()
  const view = watched.seen.view
  assert.ok(view)
  const last = view.turns.at(-1)
  assert.ok(last)
  assert.equal(last.itemIds.length, 1)
  const itemId = last.itemIds[0]
  assert.ok(itemId)
  assert.equal((view.items[itemId] as { text: string }).text, '只在完成摘要出现的回答')
})

test('没有生命周期正文且历史读取失败：显式失败并记录诊断', async (t) => {
  const world = deviceWorld([harness('codex', { threads: [thread({ id: 's' })] })], {
    extra: {
      'thread/turns/list': () => {
        throw new RpcFailure(-32603, 'history unavailable')
      },
    },
  })
  t.after(() => world.core.stop())
  world.core.start()
  await settle()
  await assert.rejects(world.command('session.peek', { sessionId: 's' }))
  assert.ok(
    world.logs.some(
      (line) => line.includes('通知正文失败') && line.includes('history unavailable'),
    ),
  )
})

test('未订阅工作线只有设备摘要：按回合去重，慢历史期间到达也能取到正文', async (t) => {
  const world = deviceWorld([harness('codex', { threads: [thread({ id: 's' })] })], {
    prepare: (device) => device.extensions.push('turnNotices'),
    extra: { 'thread/turns/list': () => new Promise(() => {}) },
  })
  t.after(() => world.core.stop())
  world.core.start()
  await settle()
  const initialize = world.sent('initialize')[0]
  assert.ok(initialize)
  assert.ok(
    (initialize.capabilities as { litchExtensions: string[] }).litchExtensions.includes(
      'turnNotices',
    ),
  )
  let result: unknown
  const read = world.command('session.peek', { sessionId: 's' }).then((value) => {
    result = value
  })
  await settle()
  const notice = {
    threadId: 's',
    turnId: 't',
    outcome: 'completed',
    body: '设备编排连接收到的正文',
  }
  world.peer.last().notify('litch/thread/turn/notice', notice)
  world.peer
    .last()
    .notify('litch/thread/turn/notice', { ...notice, body: '重复事件不能覆盖原摘要' })
  await settle()
  assert.deepEqual(result, { answer: notice.body, error: null, pending: null })
  await read
  assert.equal(world.sent('thread/turns/list').length, 0, '新设备优先等摘要，不先发起完整历史读取')
  assert.deepEqual(await world.command('session.peek', { sessionId: 's' }), result)
})

test('设备声明摘要但没有收到：宽限结束仍能读历史，不永久等待', async (t) => {
  const world = deviceWorld(
    [
      harness('codex', {
        threads: [thread({ id: 's', turns: [turn('t', [agentText('a', '历史正文')])] })],
      }),
    ],
    {
      prepare: (device) => device.extensions.push('turnNotices'),
    },
  )
  t.after(() => world.core.stop())
  world.core.start()
  await settle()
  const reading = world.command('session.peek', { sessionId: 's' })
  await settle()
  assert.equal(world.sent('thread/turns/list').length, 0)
  world.time.advance(200)
  assert.deepEqual(await reading, { answer: '历史正文', error: null, pending: null })
})
