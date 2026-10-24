// 回合菜单对的是哪条用户消息（src/detail/turn-target.ts）：从插进来的话上长按，回退切在它之前、
// 分叉带到下一条插的话之前；harness 不会切在回合中间的，插进来的话上不出这两项，不退整个回合。
// 接在模拟核心上，回退照菜单给的参数真的发一次。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { SessionStore } from '../src/core/session-store.ts'
import { turnTarget } from '../src/detail/turn-target.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
})

/** 在 harness 上开一个回答流得慢的回合，回合里插两句话，等回合结束 */
async function steered(harness) {
  const mock = mockChannel({ chunkMs: 40 })
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    harness,
    cwd: null,
    text: '长回答',
  })
  const store = new SessionStore(mock.channel, 'local', sessionId)
  cleanup.push(() => {
    store.stop()
    mock.close()
  })
  store.start()
  await until(() => store.getMeta()?.running, { what: '回合在跑' })
  for (const text of ['插一句', '再插一句']) {
    await mock.channel.command('session.send', {
      deviceId: 'local',
      sessionId,
      text,
      images: [],
      extras: [],
      now: true,
    })
  }
  await until(() => store.getMeta()?.running === false && store.getMeta()?.lastTurn, {
    timeoutMs: 20000,
    what: '回合结束',
  })
  const users = store
    .getSnapshot()
    .rows.filter((row) => row.type === 'user')
    .toReversed()
  assert.deepEqual(
    users.map((row) => row.text),
    ['长回答', '插一句', '再插一句'],
  )
  const turnId = users[0].turnId
  const answer = store
    .getSnapshot()
    .rows.find((row) => row.type === 'md' && row.turnId === turnId)?.itemId
  return { store, channel: mock.channel, sessionId, turnId, users, answer }
}

test('会切在回合中间：插进来的话上回退切在它之前，分叉带到下一条插的话之前', async () => {
  const { store, channel, sessionId, turnId, users, answer } = await steered('claude')
  const can = store.getMeta().can
  const [opening, first, second] = users.map((row) => row.key)
  const at = (pressed) => turnTarget(store, can, turnId, pressed)

  // 回合开头那条、回答、状态行的“⋯”：对整个回合
  for (const pressed of [opening, answer, null]) {
    const target = at(pressed)
    assert.equal(target.user?.text, '长回答')
    assert.deepEqual([target.fork, target.rollback], [{}, {}])
  }
  assert.equal(at(first).user?.text, '插一句')
  assert.deepEqual(at(first).rollback, { itemId: first })
  assert.deepEqual(at(first).fork, { itemId: second })
  assert.equal(at(second).user?.text, '再插一句')
  assert.deepEqual(at(second).rollback, { itemId: second })
  assert.deepEqual(at(second).fork, {}, '后面没有插的话：整个回合')

  // 照菜单给的参数回退：回合前面的都留着，插的第二句和它后面的拿掉
  await channel.command('session.rollback', {
    deviceId: 'local',
    sessionId,
    turnId,
    ...at(second).rollback,
  })
  await until(
    () =>
      store
        .getSnapshot()
        .rows.filter((row) => row.type === 'user')
        .map((row) => row.text)
        .toReversed()
        .join('|') === '长回答|插一句',
    { what: '回退之后的对话' },
  )
  assert.equal(store.getSnapshot().rows.filter((row) => row.type === 'status').length, 1)
})

test('不会切在回合中间：插进来的话上不出分叉、回退，回合开头那条照旧', async () => {
  const { store, turnId, users } = await steered('pi')
  const can = store.getMeta().can
  assert.equal(can.cutInTurn, false)
  const steer = turnTarget(store, can, turnId, users[1].key)
  assert.equal(steer.user?.text, '插一句', '复制的还是这条')
  assert.deepEqual([steer.fork, steer.rollback], [null, null])
  const opening = turnTarget(store, can, turnId, users[0].key)
  assert.deepEqual([opening.fork, opening.rollback], [{}, {}])
})

test('会切在回合中间，但这条话是别的会话发来的、或者对面还没收下：不出分叉、回退', () => {
  const can = { declared: true, fork: true, rollback: true, cutInTurn: true }
  const steer = (fields) => ({
    userMessage: () => ({ id: 'u', kind: 'userMessage', text: '开头', attachments: [] }),
    steeredMessage: () => ({
      id: 's',
      kind: 'userMessage',
      text: '插话',
      attachments: [],
      ...fields,
    }),
    nextSteer: () => null,
  })
  for (const fields of [{ unconfirmed: true }, { peer: { name: 'A', session: null } }]) {
    const target = turnTarget(steer(fields), can, 't', 's')
    assert.equal(target.user?.text, '插话')
    assert.deepEqual([target.fork, target.rollback], [null, null], JSON.stringify(fields))
  }
  assert.deepEqual(turnTarget(steer({}), can, 't', 's').rollback, { itemId: 's' })
})
