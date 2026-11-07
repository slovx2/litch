import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../../protocol/src/index.mjs'
import { INITIAL_HISTORY } from '../src/device/history.mjs'
import type { ItemView } from '../src/model.mjs'
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

test('推断的 commentary 在首屏与加载旧回合后均按正文保留', async () => {
  const app = paging()
  app.replace(
    Array.from({ length: 30 }, (_, i) =>
      turn(`t${i}`, [agentText(`a${i}`, '重要结论', 'commentary')]),
    ),
  )
  app.core.start()
  try {
    await settle()
    const session = watch(app.core)
    await settle()
    assert.equal(session.seen.view?.harness, 'pi')
    const phase = (id: string) => {
      const item = session.seen.view?.items[id]
      return item?.kind === 'agentMessage' ? item.phase : undefined
    }
    assert.equal(phase('t29:a29'), 'unknown')
    await app.command('session.loadOlder', where)
    await settle()
    assert.equal(phase('t10:a10'), 'unknown')
    session.close()
  } finally {
    app.core.stop()
  }
})

test('分页长会话：旧后台命令迟到后停止当前回合，只读回合头即可恢复待发', async () => {
  const turns = Array.from({ length: 250 }, (_, index) => turn(`old-${index}`, []))
  const current = turn('current', [], { status: 'inProgress' })
  turns.push(current)
  const app = setup([thread({ id: 'a' })], {
    'thread/resume': () => ({
      thread: thread({ id: 'a', turns: [] }),
      initialTurnsPage: {
        data: structuredClone(turns.slice(0, -1).slice(-10).reverse()),
        nextCursor: '240',
        backwardsCursor: null,
      },
    }),
    'thread/read': (params) => {
      assert.equal(
        (params as { includeTurns: boolean }).includeTurns,
        false,
        '只核对状态，禁止读取长会话的整份正文',
      )
      return { thread: thread({ id: 'a', status: { type: 'idle' }, turns: [] }) }
    },
    'thread/turns/list': (params) => {
      const { cursor, limit, itemsView } = params as {
        cursor: string | null
        limit: number
        itemsView: string
      }
      assert.equal(itemsView, 'notLoaded')
      const end = cursor === null ? turns.length : Number(cursor)
      const start = Math.max(0, end - limit)
      return {
        data: structuredClone(turns.slice(start, end).reverse()),
        nextCursor: start ? String(start) : null,
        backwardsCursor: null,
      }
    },
    'turn/steer': (params) => {
      assert.equal((params as { expectedTurnId: string }).expectedTurnId, current.id)
      return { turnId: current.id }
    },
    'turn/interrupt': () => ({}),
  })
  app.core.start()
  try {
    await settle()
    const session = watch(app.core)
    await settle()
    // 旧回合已经不在首屏，背景任务才结束；条目通知没有携带回合终态。
    app.peer.last().notify('item/completed', {
      threadId: 'a',
      turnId: 'old-0',
      item: {
        type: 'commandExecution',
        id: 'background',
        command: 'sleep 1',
        cwd: '/tmp',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: '',
        exitCode: 0,
        durationMs: 1000,
      },
    })
    app.peer.last().notify('turn/started', { threadId: 'a', turn: current })
    await settle()
    await app.command('session.send', { ...where, text: '停止后重新发送的插话', now: true })
    await app.command('session.interrupt', where)
    current.status = 'interrupted'
    app.peer.last().notify('turn/completed', { threadId: 'a', turn: current })
    app.peer.last().notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
    for (let step = 0; step < 10; step++) await settle()
    assert.equal(app.sent('turn/start').length, 0, '停止后不自动续发')
    await app.command('session.resumeQueue', where)
    for (let step = 0; step < 10; step++) await settle()
    assert.equal(session.seen.view?.turns.find((turn) => turn.id === 'old-0')?.status, 'completed')
    assert.equal(app.sent('turn/start').length, 1)
    assert.equal(session.seen.view?.queued.length, 0)
    assert.ok(app.sent('thread/turns/list').length >= 3, '跨页找到旧回合')
  } finally {
    app.core.stop()
  }
})

test('分页核实仍待确认的插话：补读所在页的交付回执，明确取消后才允许重发', async () => {
  const current = turn('current', [], { status: 'inProgress' })
  const app = setup([thread({ id: 'a' })], {
    'thread/resume': () => ({
      thread: thread({ id: 'a', turns: [] }),
      initialTurnsPage: {
        data: [structuredClone(current)],
        nextCursor: null,
        backwardsCursor: null,
      },
    }),
    'thread/read': () => ({ thread: thread({ id: 'a', status: { type: 'idle' }, turns: [] }) }),
    'thread/turns/list': (params) => ({
      data: [
        {
          ...structuredClone(current),
          items: (params as { itemsView: string }).itemsView === 'full' ? current.items : [],
        },
      ],
      nextCursor: null,
      backwardsCursor: null,
    }),
    'turn/steer': () => ({ turnId: current.id }),
    'turn/interrupt': () => ({}),
  })
  app.core.start()
  try {
    await settle()
    const session = watch(app.core)
    await settle()
    await app.command('session.send', { ...where, text: '保留插话', now: true })
    const { clientUserMessageId } = app.sent('turn/steer')[0] as { clientUserMessageId: string }
    const input = {
      ...userText('queued-input', '保留插话'),
      clientId: clientUserMessageId,
      litchInputDelivery: 'queued',
    }
    app.peer.last().notify('item/completed', { threadId: 'a', turnId: current.id, item: input })
    await settle()
    await app.command('session.interrupt', where)
    current.status = 'interrupted'
    const held = { ...input, litchInputDelivery: 'held' }
    current.items = [held]
    // 终态条目与 turn/completed 均丢失，只剩 idle 通知；不能凭 idle 猜输入是否已送达。
    app.peer.last().notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
    for (let step = 0; step < 10; step++) await settle()
    assert.ok(
      app
        .sent('thread/turns/list')
        .some((params) => (params as { itemsView: string }).itemsView === 'full'),
    )
    assert.equal(session.seen.view?.queued[0]?.delivery, 'held')
    assert.equal(app.sent('turn/start').length, 0)
    await app.command('session.resumeQueue', where)
    await settle()
    assert.equal(app.sent('turn/start').length, 1)
  } finally {
    app.core.stop()
  }
})

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

test('窗口探针的二十四回合：分页加载和重新打开均保留每条消息、顺序与标识', async () => {
  const app = paging()
  app.replace(app.turns().slice(0, 24))
  const expected = app.turns().map((entry) => entry.id)
  app.core.start()
  try {
    await settle()
    for (let visit = 0; visit < 2; visit++) {
      const session = watch(app.core)
      try {
        await settle()
        // 重开可以复用已读页；首开只取尾页，完整性不依赖 DOM 同时挂载多少回合。
        for (let page = 0; page < 3 && session.seen.view?.history?.hasMore; page++) {
          await app.command('session.loadOlder', where)
          await settle()
        }
        const view = session.seen.view
        assert.ok(view)
        assert.equal(view.history?.hasMore, false)
        assert.deepEqual(
          view.turns.map((entry) => entry.id),
          expected,
        )
        assert.equal(new Set(view.turns.map((entry) => entry.id)).size, 24)
        for (let index = 0; index < 24; index++) {
          const user: ItemView | undefined = view.items[`t${index}:u${index}`]
          const answer: ItemView | undefined = view.items[`t${index}:a${index}`]
          assert.equal(user?.kind === 'userMessage' && user.text, `第${index}页历史`)
          assert.equal(answer?.kind === 'agentMessage' && answer.text, `回答${index}`)
        }
      } finally {
        session.close()
      }
      await settle()
    }
  } finally {
    app.core.stop()
  }
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

test('回退在旧页返回之前完成：迟到页作废，保留未删除的回合与原分页游标', async () => {
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
  assert.equal(session.seen.view?.turns.length, 3)
  assert.ok(!session.seen.view?.items['t29:a29'])
  app.hold(null)
  await app.command('session.loadOlder', where)
  await settle()
  assert.equal(session.seen.view?.turns.length, 13)
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

test('重连先取十回合，再向前翻页可还原全部历史及顺序', async () => {
  const app = paging()
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  await app.command('session.loadOlder', where)
  await app.command('session.loadOlder', where)
  await settle()
  const original = structuredClone(session.seen.view?.turns)
  app.peer.last().drop()
  await settle()
  app.time.advance(1000)
  await settle()
  assert.equal(session.seen.view?.turns.length, 10)
  assert.equal(session.seen.view?.history?.hasMore, true)
  await app.command('session.loadOlder', where)
  await app.command('session.loadOlder', where)
  await settle()
  assert.deepEqual(session.seen.view?.turns, original)
  assert.equal(session.seen.view?.history?.hasMore, false)
  session.close()
  app.core.stop()
})

test('编辑首屏之外的早期消息：翻到目标页后按服务端 ID 回退，只保留目标之前的历史', async () => {
  const app = paging()
  app.core.start()
  await settle()
  const session = watch(app.core)
  await settle()
  assert.ok(!session.seen.view?.turns.some((turn) => turn.id === 't12'))
  await app.command('session.loadOlder', where)
  await settle()
  assert.equal(session.seen.view?.turns[0]?.id, 't10')
  await app.command('session.edit', { ...where, turnId: 't12', text: '替换第十二条' })
  await settle()
  assert.deepEqual(app.sent('thread/revert'), [{ threadId: 'a', beforeTurnId: 't12' }])
  assert.equal(app.turns().at(-1)?.id, 't11')
  assert.equal(app.sent('turn/start').length, 1)
  assert.match(JSON.stringify(app.sent('turn/start')), /替换第十二条/)
  // 回退重新取首屏；继续向前翻到头，不能少掉此前未显示的 t0、t1。
  await app.command('session.loadOlder', where)
  await settle()
  assert.deepEqual(
    session.seen.view?.turns.filter((turn) => !turn.id.startsWith('local:')).map((turn) => turn.id),
    app.turns().map((turn) => turn.id),
  )
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
