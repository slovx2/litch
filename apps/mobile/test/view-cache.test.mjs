// 打开会话先摆上次的内容：留视图（src/core/view-cache.ts）、存储先摆旧视图（session-store.ts 的 seed）、
// 存储缓存关掉后再进来先摆出来（store-cache.ts）、顶上那一条状态（detail/sync.ts）。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { files } from 'expo-file-system'
import { SessionStore } from '../src/core/session-store.ts'
import { acquireStore, releaseStore, setViewCache } from '../src/core/store-cache.ts'
import { createViewCache, trimView } from '../src/core/view-cache.ts'
import { syncState } from '../src/detail/sync.ts'
import { jsonFile } from '../src/shell/json-file.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0)) done()
  setViewCache(null)
  files.clear()
})

/** 一份假的会话视图：n 个回合，每个回合一条用户消息、一条回答 */
function fakeView(sessionId, n, deviceId = 'd1') {
  const turns = []
  const items = {}
  for (let i = 0; i < n; i++) {
    items[`u${i}`] = { id: `u${i}`, kind: 'userMessage', text: `问 ${i}` }
    items[`a${i}`] = { id: `a${i}`, kind: 'agentMessage', text: `答 ${i}` }
    turns.push({ id: `t${i}`, status: 'completed', itemIds: [`u${i}`, `a${i}`] })
  }
  return {
    deviceId,
    sessionId,
    turns,
    items,
    requests: [{ id: 'r1' }],
    queued: [{ id: 'q1' }],
  }
}

test('裁视图：只留最近几个回合和它们的条目，请求、排队清空', () => {
  const view = trimView(fakeView('s', 50), 3)
  assert.deepEqual(
    view.turns.map((turn) => turn.id),
    ['t47', 't48', 't49'],
  )
  assert.deepEqual(Object.keys(view.items).sort(), ['a47', 'a48', 'a49', 'u47', 'u48', 'u49'])
  assert.deepEqual(view.requests, [])
  assert.deepEqual(view.queued, [])
})

test('留下的视图：内存里有就用，重开应用（新的一份缓存）从文件读；版本换了当没存过', () => {
  const cache = createViewCache(jsonFile, '1.0.0')
  cache.remember(fakeView('s1', 50))
  const hit = cache.recall('d1', 's1')
  assert.equal(hit.turns.length, 40, '默认留 40 个回合')
  assert.equal(cache.recall('d1', 'other'), null)
  const reopened = createViewCache(jsonFile, '1.0.0')
  assert.equal(reopened.recall('d1', 's1').turns.at(-1).id, 't49')
  assert.equal(createViewCache(jsonFile, '1.0.1').recall('d1', 's1'), null)
})

test('文件最多 24 个：超了删存得最早的；去掉设备时它的都删', (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const cache = createViewCache(jsonFile, '1')
  for (let i = 0; i < 25; i++) {
    cache.remember(fakeView(`s${i}`, 2))
    t.mock.timers.tick(1)
  }
  const viewFiles = () => [...files.keys()].filter((path) => path.includes('/view-'))
  assert.equal(viewFiles().length, 24)
  assert.ok(!viewFiles().some((path) => path.endsWith('-s0.json')), '最早的 s0 删了')
  cache.remember(fakeView('x', 2, 'd2'))
  cache.forgetDevice('d1')
  assert.deepEqual(viewFiles(), ['doc:/view-d2-x.json'])
  const reopened = createViewCache(jsonFile, '1')
  assert.equal(reopened.recall('d1', 's24'), null)
  assert.ok(reopened.recall('d2', 'x'))
})

test('一份太大就砍回合，砍到一个还太大就只留在内存里', () => {
  const cache = createViewCache(jsonFile, '1')
  const view = fakeView('big', 40)
  view.items.a39.text = 'x'.repeat(1_600_000)
  cache.remember(view)
  assert.equal(cache.recall('d1', 'big').turns.length, 1, '内存里留了最后一个回合')
  assert.equal(createViewCache(jsonFile, '1').recall('d1', 'big'), null, '没写文件')
  view.items.a39.text = 'x'.repeat(1_000_000)
  view.items.a10.text = 'y'.repeat(1_000_000)
  cache.remember(view)
  const saved = createViewCache(jsonFile, '1').recall('d1', 'big')
  assert.ok(saved.turns.length < 30 && saved.turns.length >= 1, `砍过：${saved.turns.length}`)
})

async function finishedSession() {
  const mock = mockChannel()
  const { sessionId } = await mock.channel.command('session.create', {
    deviceId: 'local',
    cwd: null,
    text: '你好',
  })
  const store = new SessionStore(mock.channel, 'local', sessionId)
  store.start()
  await until(() => store.getMeta()?.lastTurn?.status === 'completed', { what: '回合结束' })
  cleanup.push(() => mock.close())
  return { mock, store, sessionId }
}

test('存储先摆旧视图：同步建好行、标着旧的、meta 还是 null；核心的快照到了整份换掉', async () => {
  const { mock, store, sessionId } = await finishedSession()
  const view = store.currentView()
  const rows = store.getSnapshot().rows.map((row) => row.type)
  store.stop()
  const seeded = new SessionStore(mock.channel, 'local', sessionId)
  cleanup.push(() => seeded.stop())
  seeded.seed(structuredClone(view))
  assert.equal(seeded.getSnapshot().stale, true)
  assert.deepEqual(
    seeded.getSnapshot().rows.map((row) => row.type),
    rows,
  )
  assert.equal(seeded.getMeta(), null, '旧视图上的请求、设置不交')
  assert.equal(seeded.currentView(), null, '旧视图不再拿去留')
  seeded.start()
  await until(() => seeded.getMeta(), { what: '快照' })
  assert.equal(seeded.getSnapshot().stale, false)
  assert.ok(seeded.currentView())
})

test('存储缓存：离开时留一份，关掉之后再进来第一帧就有内容', async (t) => {
  const { mock, store, sessionId } = await finishedSession()
  const rows = store.getSnapshot().rows.length
  store.stop()
  setViewCache(createViewCache(jsonFile, '1'))
  const opened = acquireStore(mock.channel, 'local', sessionId)
  await until(() => opened.getMeta(), { what: '快照' })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  releaseStore(opened)
  t.mock.timers.tick(60_001)
  t.mock.timers.reset()
  const again = acquireStore(mock.channel, 'local', sessionId)
  assert.notEqual(again, opened, '过了一分钟关掉了')
  assert.equal(again.getSnapshot().stale, true)
  assert.equal(again.getSnapshot().rows.length, rows, '还没收到快照就有行')
  await until(() => again.getMeta(), { what: '快照' })
  assert.equal(again.getSnapshot().stale, false)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  releaseStore(again)
  t.mock.timers.tick(60_001)
})

test('顶上那一条：连着在等快照写加载中，没连上写连接中或未连接，都好了不出', () => {
  assert.equal(syncState('online', false, false), 'loading')
  assert.equal(syncState(undefined, false, false), 'loading')
  assert.equal(syncState('online', true, false), null)
  assert.equal(syncState('online', false, true), null, '报错了另有一行')
  assert.equal(syncState('reconnecting', true, false), 'connecting')
  assert.equal(syncState('connecting', false, false), 'connecting')
  assert.equal(syncState('offline', true, false), 'offline')
  assert.equal(syncState('error', false, false), 'offline')
})
