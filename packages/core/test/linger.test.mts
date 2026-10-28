// 关掉的会话留一阵、这台电脑上存的视图先摆出来（device/live.mts 的 release、open，device/view-store.mts）：
// 切回刚看过的会话不再向对面要一遍；重启后先摆存下的那一份（只读、标 stale），最新的到了整份换掉。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '../../protocol/src/index.mjs'
import type { DeviceStore, SessionView, ViewStore } from '../src/index.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { finished, setup, started, watch } from './world.mjs'

const LINGER_MS = 10 * 60_000

/** 只放在内存里的存储，记下存过的视图 */
function memoryStore(views = new Map<string, SessionView>()) {
  const store: DeviceStore = {
    load: () => ({ localWire: null, remotes: [] }),
    save() {},
    snapshot: () => ({ load: () => null, save() {} }),
    views: (): ViewStore => ({
      load: (id) => views.get(id) ?? null,
      save: (view) => views.set(view.sessionId, structuredClone(view)),
      forget: (id) => views.delete(id),
    }),
    forget() {},
  }
  return { store, views }
}

const answered = (id: string): Thread =>
  thread({ id, turns: [turn('t1', [userText('u', '问'), agentText('m', '答')])] })

test('关掉又切回来：留着的那一份直接给，不再 thread/resume，也不退订', async () => {
  const { core, time, sent } = setup([answered('a')])
  core.start()
  await settle()
  const first = watch(core)
  await settle()
  first.close()
  await settle()
  time.advance(LINGER_MS - 1)
  await settle()
  const again = watch(core)
  await settle()
  assert.equal(again.seen.snapshots, 1)
  assert.deepEqual(again.texts(), [['问', '答']])
  assert.equal(again.seen.view?.live, true)
  assert.equal(sent('thread/resume').length, 1)
  assert.deepEqual(sent('thread/unsubscribe'), [])
  // 又有人看了：原来的计时作废，过了点也不退订
  time.advance(LINGER_MS)
  await settle()
  assert.deepEqual(sent('thread/unsubscribe'), [])
})

test('最多留 6 个：再关一个，最早关掉的那个退订', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const { core, sent } = setup(ids.map(answered))
  core.start()
  await settle()
  for (const id of ids) {
    const session = watch(core, id)
    await settle()
    session.close()
    await settle()
  }
  assert.deepEqual(sent('thread/unsubscribe'), [{ threadId: 'a' }])
})

test('留着的会话不算有人看：别处跑完的回合照样标未读，视图跟着变', async () => {
  const { core, peer, sidebar, sent } = setup([answered('a')])
  core.start()
  await settle()
  const first = watch(core)
  await settle()
  first.close()
  await settle()
  const server = peer.last()
  server.notify('turn/started', { threadId: 'a', turn: started('t2') })
  server.notify('thread/status/changed', {
    threadId: 'a',
    status: { type: 'active', activeFlags: [] },
  })
  server.notify('item/completed', {
    threadId: 'a',
    turnId: 't2',
    item: agentText('m2', '别处的'),
    completedAtMs: 0,
  })
  server.notify('turn/completed', { threadId: 'a', turn: finished('t2') })
  server.notify('thread/status/changed', { threadId: 'a', status: { type: 'idle' } })
  await settle()
  const last = sidebar.ops.findLast((op) => op.op === 'session.upsert' && op.session.id === 'a')
  assert.equal(last?.op === 'session.upsert' && last.session.unread, true)
  const again = watch(core)
  await settle()
  assert.equal(sent('thread/resume').length, 1)
  assert.deepEqual(again.texts().at(-1), ['别处的'])
})

test('存下的视图：重启后先摆出来（只读、标 stale），最新的到了整份换掉', async () => {
  const saved = memoryStore()
  const before = setup([answered('a')], {}, saved.store)
  before.core.start()
  await settle()
  const first = watch(before.core)
  await settle()
  first.close()
  await settle()
  const kept = saved.views.get('a')
  assert.equal(kept?.live, true)
  assert.deepEqual(kept?.requests, [])

  // 重启：对面的 thread/resume 先压着不回
  let reply: (() => void) | null = null
  const fresh = thread({
    id: 'a',
    turns: [
      turn('t1', [userText('u', '问'), agentText('m', '答')]),
      turn('t2', [userText('u2', '又问'), agentText('m2', '又答')]),
    ],
  })
  const after = setup(
    [fresh],
    {
      'thread/resume': () =>
        new Promise((resolve) => {
          reply = () =>
            resolve({ thread: fresh, model: 'gate/small', reasoningEffort: 'low', sandbox: {} })
        }),
    },
    saved.store,
  )
  after.core.start()
  await settle()
  const session = watch(after.core)
  await settle()
  assert.equal(session.seen.view?.stale, true)
  assert.equal(session.seen.view?.live, false)
  assert.deepEqual(session.texts(), [['问', '答']])
  assert.ok(reply, '照样去要最新的')
  ;(reply as () => void)()
  await settle()
  assert.equal(session.seen.view?.stale, undefined)
  assert.equal(session.seen.view?.live, true)
  assert.deepEqual(session.texts(), [
    ['问', '答'],
    ['又问', '又答'],
  ])
})

test('留着时断了线：重连后它算旧的，再打开先摆出来、再重新载入', async () => {
  const { core, peer, time, sent } = setup([answered('a')])
  core.start()
  await settle()
  const first = watch(core)
  await settle()
  first.close()
  await settle()
  peer.last().drop()
  await settle()
  time.advance(500)
  await settle()
  await settle()
  const again = watch(core)
  await settle()
  assert.equal(again.seen.view?.stale, undefined)
  assert.equal(again.seen.view?.live, true)
  assert.equal(again.seen.snapshots, 2)
  assert.equal(sent('thread/resume').length, 1, '新连接上重新载入了一次')
})
