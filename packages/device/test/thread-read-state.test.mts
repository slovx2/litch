import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import {
  THREAD_READ_STATE as RPC,
  type ThreadReadState,
} from '../../protocol/src/thread-read-state.mjs'
import { openDeviceStore } from '../src/store.mjs'
import { ThreadIndex } from '../src/thread-index.mjs'
import { ThreadReadStates } from '../src/thread-read-state.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { rig, tempDir } from './helpers.mjs'

const completion = (threadId: string, id: string) => ({
  threadId,
  turn: { id, status: 'completed', items: [] },
})

test('已读持久化、重复完成去重、旧确认不吞新回合；归档和删除清理', (t) => {
  const directory = tempDir()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let db = openDeviceStore(directory)
  let index = new ThreadIndex(db)
  const notices: ThreadReadState[] = []
  let states = new ThreadReadStates(db, index, (state) => notices.push(state))
  states.observe('pi', 'turn/completed', completion('a', 'one'))
  const one = states.get('a')
  states.observe('pi', 'turn/completed', completion('a', 'one'))
  assert.equal(notices.length, 1)
  states.mark({ threadId: 'a', completedSequence: one.completedSequence })
  states.observe('pi', 'turn/completed', completion('a', 'two'))
  const two = states.get('a')
  assert.ok(two.completedSequence > two.readSequence)
  states.mark({ threadId: 'a', completedSequence: one.completedSequence })
  assert.deepEqual(states.get('a'), two)
  states.observe('pi', 'turn/completed', completion('b', 'three'))
  for (const sequence of [
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    two.completedSequence + 100,
    states.get('b').completedSequence,
  ])
    assert.throws(() => states.mark({ threadId: 'a', completedSequence: sequence }))
  assert.throws(() => states.list({ threadIds: Array(501).fill('a') }))
  assert.deepEqual(states.list({ threadIds: ['a', 'a'] }).states, [two])
  db.close()
  db = openDeviceStore(directory)
  index = new ThreadIndex(db)
  states = new ThreadReadStates(db, index, (state) => notices.push(state))
  assert.deepEqual(states.get('a'), two)
  // 重启后旧回合重放不能变成最新回合。
  states.observe('pi', 'turn/completed', completion('a', 'one'))
  assert.deepEqual(states.get('a'), two)
  index.setArchived('a', true)
  assert.equal(states.get('a').readSequence, two.completedSequence)
  states.observe('pi', 'turn/completed', completion('a', 'archived-turn'))
  assert.equal(states.get('a').readSequence, states.get('a').completedSequence)
  index.setArchived('a', false)
  states.observe('pi', 'turn/completed', completion('a', 'restored-turn'))
  assert.ok(states.get('a').completedSequence > states.get('a').readSequence)
  index.forget('a')
  assert.equal(states.get('a').completedSequence, 0)
  assert.equal(states.get('a').readSequence, 0)
  index.see({ id: 'ephemeral', ephemeral: true }, 'pi')
  states.observe('pi', 'turn/completed', completion('ephemeral', 'temp'))
  assert.equal(states.get('ephemeral').completedSequence, 0)
  db.close()
})

test('只有状态广播时补读完成回合；旧查询不能覆盖随后收到的完成事件', async (t) => {
  const directory = tempDir()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const db = openDeviceStore(directory)
  const index = new ThreadIndex(db)
  index.see({ id: 'a' }, 'pi')
  const states = new ThreadReadStates(db, index, () => {})
  let finish: (result: unknown) => void = () => {}
  const queried = new Promise<void>((resolve) => {
    states.latest = async () =>
      new Promise((done) => {
        finish = done
        resolve()
      })
  })
  states.observe('pi', 'thread/status/changed', { threadId: 'a', status: { type: 'active' } })
  states.observe('pi', 'thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
  await queried
  states.observe('pi', 'turn/completed', completion('a', 'new'))
  finish({ data: [{ id: 'old', status: 'completed' }] })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(states.get('a').turnId, 'new')
  states.latest = async () => ({ data: [{ id: 'latest', status: 'completed' }] })
  states.observe('pi', 'thread/status/changed', { threadId: 'a', status: { type: 'active' } })
  states.observe('pi', 'thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(states.get('a').turnId, 'latest')
  states.close()
  db.close()
})

test('桌面和手机协议冒烟：能力隔离、同步、新回合、重新连接', async () => {
  const upstream = new FakeUpstream('pi')
  const env = rig({ pi: upstream })
  try {
    const desktop = env.connect()
    const phone = env.connect()
    const legacy = env.connect()
    await desktop.initialize(['harness', 'threadReadState'])
    await phone.initialize(['harness', 'threadReadState'])
    await legacy.initialize(['harness'])
    assert.equal((await legacy.fails(RPC.list, { threadIds: ['a'] })).code, -32601)
    const info = await desktop.call('runtime/info', {})
    assert.ok(info.device.extensions.includes('threadReadState'))
    const link = await env.device.openEngineLink('pi')
    const source = upstream.live.at(-1)
    assert.ok(source)
    source.send({ method: 'turn/completed', params: completion('a', 'one') })
    const notice = await desktop.waitFor((n) => n.method === RPC.changed)
    const one = notice.params as ThreadReadState
    await phone.waitFor((n) => n.method === RPC.changed)
    await desktop.call(RPC.mark, { threadId: 'a', completedSequence: one.completedSequence })
    await phone.waitFor(
      (n) =>
        n.method === RPC.changed &&
        (n.params as ThreadReadState).readSequence === one.completedSequence,
    )
    source.send({ method: 'turn/completed', params: completion('a', 'two') })
    const later = await phone.waitFor(
      (n) => n.method === RPC.changed && (n.params as ThreadReadState).turnId === 'two',
    )
    const two = later.params as ThreadReadState
    assert.ok(two.completedSequence > two.readSequence)
    await phone.call(RPC.mark, { threadId: 'a', completedSequence: one.completedSequence })
    const reconnect = env.connect()
    await reconnect.initialize(['harness', 'threadReadState'])
    assert.deepEqual((await reconnect.call(RPC.list, { threadIds: ['a'] })).states, [two])
    assert.equal(
      legacy.notifications.some((n) => n.method === RPC.changed),
      false,
    )
    link.close()
  } finally {
    await env.close()
  }
})
