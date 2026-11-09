import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  THREAD_READ_STATE as RPC,
  type ThreadReadState,
} from '../../protocol/src/thread-read-state.mjs'
import { deviceWorld } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { thread } from './fixtures.mjs'
import { settle } from './helpers.mjs'

test('共享核心：设备游标控制未读，迟到旧确认和状态广播不回滚，支持菜单写入', async () => {
  let state: ThreadReadState = {
    threadId: 'a',
    turnId: 'one',
    completedSequence: 1,
    readSequence: 0,
  }
  let finish: ((value: ThreadReadState) => void) | undefined
  const w = deviceWorld([harness('pi', { threads: [thread({ id: 'a', preview: 'hello' })] })], {
    prepare: (device) => device.extensions.push('threadReadState'),
    extra: {
      [RPC.list]: () => ({ states: [state] }),
      [RPC.mark]: () =>
        new Promise<ThreadReadState>((resolve) => {
          finish = resolve
        }),
    },
  })
  try {
    w.core.start()
    await settle()
    assert.equal(w.side.sessions.get('a')?.unread, true)
    await w.command('session.markRead', { sessionId: 'a' })
    assert.equal(w.side.sessions.get('a')?.unread, false)
    assert.deepEqual(w.sent(RPC.mark), [{ threadId: 'a', completedSequence: 1 }])
    state = { threadId: 'a', turnId: 'two', completedSequence: 2, readSequence: 0 }
    w.peer.last().notify(RPC.changed, state)
    await settle()
    assert.equal(w.side.sessions.get('a')?.unread, true)
    assert.ok(finish)
    finish({ threadId: 'a', turnId: 'one', completedSequence: 1, readSequence: 1 })
    await settle()
    assert.equal(w.side.sessions.get('a')?.unread, true)
    w.peer.last().notify(RPC.changed, { ...state, readSequence: 2 })
    w.peer.last().notify('thread/status/changed', {
      threadId: 'a',
      status: { type: 'active', activeFlags: [] },
    })
    w.peer.last().notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
    await settle()
    assert.equal(w.side.sessions.get('a')?.unread, false)
    w.peer.last().notify(RPC.changed, state)
    await settle()
    assert.equal(w.side.sessions.get('a')?.unread, false, '旧通知不能把已读变回未读')
  } finally {
    w.core.stop()
  }
})

test('旧设备不调用扩展，仍用本地运行结束和标已读', async () => {
  const w = deviceWorld([harness('pi', { threads: [thread({ id: 'a', preview: 'hello' })] })])
  try {
    w.core.start()
    await settle()
    w.peer.last().notify('thread/status/changed', {
      threadId: 'a',
      status: { type: 'active', activeFlags: [] },
    })
    w.peer.last().notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
    await settle()
    assert.equal(w.side.sessions.get('a')?.unread, true)
    await w.command('session.markRead', { sessionId: 'a' })
    assert.equal(w.side.sessions.get('a')?.unread, false)
    assert.deepEqual(w.sent(RPC.list), [])
    assert.deepEqual(w.sent(RPC.mark), [])
  } finally {
    w.core.stop()
  }
})

test('重连后采用设备已读游标，旧连接确认不污染新连接', async () => {
  let state: ThreadReadState = {
    threadId: 'a',
    turnId: 'one',
    completedSequence: 1,
    readSequence: 0,
  }
  const w = deviceWorld([harness('pi', { threads: [thread({ id: 'a', preview: 'hello' })] })], {
    prepare: (device) => device.extensions.push('threadReadState'),
    extra: { [RPC.list]: () => ({ states: [state] }) },
  })
  try {
    w.core.start()
    await settle()
    assert.equal(w.side.sessions.get('a')?.unread, true)
    w.peer.last().drop()
    await settle()
    state = { ...state, readSequence: 1 }
    w.time.advance(30_000)
    await settle()
    assert.equal(w.side.sessions.get('a')?.unread, false)
    assert.equal(w.sent(RPC.list).length, 1)
  } finally {
    w.core.stop()
  }
})
