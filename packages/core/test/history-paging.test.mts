import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../../protocol/src/index.mjs'
import { INITIAL_HISTORY } from '../src/device/history.mjs'
import { RpcFailure } from './fake-server.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { setup, watch, where } from './world.mjs'

function paging() {
  let turns = Array.from({ length: 30 }, (_, i) =>
    turn(`t${i}`, [userText(`u${i}`, `第${i}页历史`), agentText(`a${i}`, `回答${i}`)]),
  )
  let hold: ((page: unknown) => Promise<unknown>) | null = null
  const page = (end: number) => ({
    data: structuredClone(turns.slice(Math.max(0, end - 10), end).reverse()),
    nextCursor: end > 10 ? turns[end - 10]!.id : null,
    backwardsCursor: turns[end - 1]?.id ?? null,
  })
  const app = setup([thread({ id: 'a' })], {
    'thread/resume': () => ({ thread: thread({ id: 'a' }), initialTurnsPage: page(turns.length) }),
    'thread/read': () => ({ thread: thread({ id: 'a' }) }),
    'thread/turns/list': (params) => {
      const cursor = (params as { cursor?: string }).cursor
      const end = cursor ? turns.findIndex((t) => t.id === cursor) : turns.length
      if (end < 0) throw new RpcFailure(-32602, '历史游标无效或已失效')
      const result = page(end)
      return hold ? hold(result) : result
    },
    'thread/revert': (params) => {
      turns = turns.slice(
        0,
        turns.findIndex((t) => t.id === (params as { beforeTurnId: string }).beforeTurnId),
      )
      return { thread: thread({ id: 'a', turns }) }
    },
  })
  return {
    ...app,
    hold: (next: typeof hold) => {
      hold = next
    },
    turns: () => turns,
    replace: (next: Turn[]) => {
      turns = next
    },
  }
}

test('首屏仅十回合；按游标向前、去重合并；重复加载请求共用同一页', async () => {
  const app = paging()
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  assert.deepEqual(app.sent('thread/resume'), [{ threadId: 'a', ...INITIAL_HISTORY }])
  assert.deepEqual(
    session.seen.view?.turns.map((t) => t.id),
    app
      .turns()
      .slice(-10)
      .map((t) => t.id),
  )
  let release!: (page: unknown) => void
  app.hold(
    (page) =>
      new Promise((resolve) => {
        release = () => resolve(page)
      }),
  )
  const a = app.command('session.loadOlder', where)
  const b = app.command('session.loadOlder', where)
  await settle()
  assert.equal(app.sent('thread/turns/list').length, 1)
  release(null)
  await Promise.all([a, b])
  await settle()
  assert.equal(session.seen.view?.turns.length, 20)
  app.hold(null)
  await app.command('session.loadOlder', where)
  await settle()
  assert.equal(session.seen.view?.turns.length, 30)
  assert.equal(session.seen.view?.history?.hasMore, false)
  assert.match(JSON.stringify(session.seen.view?.items), /第0页历史/)
  session.close()
  app.core.stop()
})

test('加载旧页时正在运行的回合继续流；新回合与重叠旧页不能覆盖最新状态', async () => {
  const app = paging()
  app.turns()[29]!.status = 'inProgress'
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  let release!: () => void
  app.hold(
    (value) =>
      new Promise((resolve) => {
        const page = value as { data: Turn[] }
        page.data.unshift(structuredClone(app.turns()[29]!))
        release = () => resolve(page)
      }),
  )
  const request = app.command('session.loadOlder', where)
  await settle()
  app.peer.last().notify('item/agentMessage/delta', {
    threadId: 'a',
    turnId: 't29',
    itemId: 'a29',
    delta: '最新追加',
  })
  app.peer.last().notify('turn/started', {
    threadId: 'a',
    turn: turn('new', [userText('nu', '新消息')], { status: 'inProgress' }),
  })
  await settle()
  release()
  await request
  await settle()
  assert.equal(
    (session.seen.view?.items['t29:a29'] as { text: string } | undefined)?.text,
    '回答29最新追加',
  )
  assert.equal(session.seen.view?.turns.at(-1)?.id, 'new')
  assert.equal(session.seen.view?.turns.filter((t) => t.id === 't29').length, 1)
  session.close()
  app.core.stop()
})

test('回退在旧页返回之前完成：迟到页作废，按回退后的历史重新建立游标', async () => {
  const app = paging()
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  let release!: () => void
  app.hold(
    (page) =>
      new Promise((resolve) => {
        release = () => resolve(page)
      }),
  )
  const pending = app.command('session.loadOlder', where)
  await settle()
  await app.command('session.rollback', { ...where, turnId: 't23' })
  await settle()
  release()
  await pending
  await settle()
  assert.equal(session.seen.view?.turns.at(-1)?.id, 't22')
  assert.equal(session.seen.view?.turns.length, 10)
  assert.ok(!session.seen.view?.items['t29:a29'])
  app.hold(null)
  await app.command('session.loadOlder', where)
  await settle()
  assert.equal(session.seen.view?.turns.length, 20)
  session.close()
  app.core.stop()
})

test('外部回退通知让待回页作废；不会复活已撤销历史', async () => {
  const app = paging()
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  let release!: () => void
  app.hold(
    (page) =>
      new Promise((resolve) => {
        release = () => resolve(page)
      }),
  )
  const pending = app.command('session.loadOlder', where)
  await settle()
  app.replace(app.turns().slice(0, 5))
  app.peer.last().notify('thread/reverted', { threadId: 'a' })
  await settle()
  release()
  await pending
  await settle()
  assert.equal(session.seen.view?.turns.length, 5)
  assert.equal(session.seen.view?.history?.hasMore, false)
  session.close()
  app.core.stop()
})

test('断线重连不沿用旧页请求；重连后的快照不会被迟到页覆盖', async () => {
  const app = paging()
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  let release!: () => void
  app.hold(
    (page) =>
      new Promise((resolve) => {
        release = () => resolve(page)
      }),
  )
  const pending = app.command('session.loadOlder', where)
  await settle()
  app.peer.last().drop()
  await settle()
  app.replace(app.turns().slice(0, 5))
  app.time.advance(1000)
  await settle()
  release()
  await pending
  await settle()
  assert.equal(session.seen.view?.turns.length, 5)
  assert.equal(session.seen.view?.history?.hasMore, false)
  session.close()
  app.core.stop()
})

test('旧端拒绝分页参数：重试标准 resume，仍显示完整历史', async () => {
  const full = thread({ id: 'a', turns: [turn('old', [userText('u', '完整历史')])] })
  const app = setup([full], {
    'thread/resume': (params) => {
      if ((params as { excludeTurns?: boolean }).excludeTurns)
        throw new RpcFailure(-32602, 'unknown field excludeTurns')
      return { thread: full }
    },
  })
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  assert.equal(session.seen.view?.turns[0]?.id, 'old')
  assert.equal(session.seen.view?.history, undefined)
  assert.equal(app.sent('thread/resume').length, 2)
  session.close()
  app.core.stop()
})

test('旧游标被外部回退删除但通知尚未到达：重建首屏边界', async () => {
  const app = paging()
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  app.replace(app.turns().slice(0, 5))
  await app.command('session.loadOlder', where)
  await settle()
  assert.deepEqual(
    session.seen.view?.turns.map((turn) => turn.id),
    ['t0', 't1', 't2', 't3', 't4'],
  )
  assert.equal(session.seen.view?.history?.hasMore, false)
  session.close()
  app.core.stop()
})

test('旧页网络错误保留已读内容和游标，可单独重试，不全量恢复', async () => {
  const app = paging()
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  app.hold(async () => {
    throw new RpcFailure(-32000, '暂时读取失败')
  })
  await assert.rejects(app.command('session.loadOlder', where))
  await settle()
  assert.equal(session.seen.view?.turns.length, 10)
  assert.equal(session.seen.view?.history?.loading, false)
  assert.ok(session.seen.view?.history?.error)
  app.hold(null)
  await app.command('session.loadOlder', where)
  await settle()
  assert.equal(session.seen.view?.turns.length, 20)
  assert.equal(session.seen.view?.history?.error, null)
  assert.equal(app.sent('thread/resume').length, 1)
  session.close()
  app.core.stop()
})

test('初始页仍在路上时开始的新回合，在首屏快照之后重放', async () => {
  let release!: () => void
  const app = setup([thread({ id: 'a' })], {
    'thread/resume': () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            thread: thread({ id: 'a' }),
            initialTurnsPage: {
              data: [turn('old', [userText('u', '旧问题')])],
              nextCursor: 'older',
              backwardsCursor: 'old',
            },
          })
      }),
  })
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  app.peer
    .last()
    .notify('turn/started', { threadId: 'a', turn: turn('new', [], { status: 'inProgress' }) })
  app.peer
    .last()
    .notify('item/started', { threadId: 'a', turnId: 'new', item: agentText('answer', '新回答') })
  await settle()
  release()
  await settle()
  assert.deepEqual(
    session.seen.view?.turns.map((turn) => turn.id),
    ['old', 'new'],
  )
  assert.equal(session.seen.view?.turns.at(-1)?.status, 'running')
  assert.ok(session.seen.view?.items['new:answer'])
  session.close()
  app.core.stop()
})

test('支持 excludeTurns 但不支持初始页时另取首屏；不支持 turns/list 时重新完整恢复', async () => {
  const full = thread({ id: 'a', turns: [turn('old', [userText('u', '完整历史')])] })
  for (const supports of [true, false]) {
    const app = setup([full], {
      'thread/resume': (params) => ({
        thread: (params as { excludeTurns?: boolean }).excludeTurns ? { ...full, turns: [] } : full,
      }),
      'thread/turns/list': () => {
        if (!supports) throw new RpcFailure(-32601, 'Method not found')
        return { data: full.turns, nextCursor: null, backwardsCursor: 'old' }
      },
    })
    app.core.start()
    await settle()
    const session = watch(app.core)
    await settle()
    assert.equal(session.seen.view?.turns[0]?.id, 'old')
    assert.equal(app.sent('thread/resume').length, supports ? 1 : 2)
    session.close()
    app.core.stop()
  }
})
