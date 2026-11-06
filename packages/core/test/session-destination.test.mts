import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  KeyedStore,
  keys,
  openSessionWhenKnown,
  sessionDestination,
  subscribeSessionDestination,
} from '../src/index.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'

const sample = sampleManagers('local', 1_800_000_000, 'zh-CN')
const manager = sample.managers[0]
assert.ok(manager)
const summary = sample.sessions.find((session) => session.id === manager.threadId)
assert.ok(summary)
const { litchManager: _mark, ...plain } = summary
const catalog = (store: KeyedStore) => {
  store.batch(() => {
    store.set(keys.managerIds('local'), [manager.id])
    store.set(keys.manager('local', manager.id), manager)
    store.set(keys.managersAvailable('local'), true)
  })
}

test('建议工作线身份确认后再离开，旧导航清理不能撤掉侧栏的运行状态订阅', () => {
  const store = new KeyedStore()
  catalog(store)
  const key = keys.summary('local', 'proposal-child')
  store.set(key, {
    ...plain,
    id: 'proposal-child',
    status: 'idle',
    litchManager: { managerId: manager.id, role: 'line' },
  })
  let opened = 0
  const leave = openSessionWhenKnown(store, 'local', 'proposal-child', () => opened++)
  assert.equal(opened, 1)
  // 身份确认已自动退订；随后挂载侧栏行，再切到另一条会话。
  const seen: string[] = []
  const stopRow = store.subscribe(key, () => {
    const current = store.get<{ status: string }>(key)
    assert.ok(current)
    seen.push(current.status)
  })
  leave()
  for (const status of ['running', 'waiting', 'idle']) store.set(key, { ...plain, status })
  assert.deepEqual(seen, ['running', 'waiting', 'idle'])
  stopRow()
})

test('会话标记先到即可确认经理；目录先到且摘要未到也可确认', () => {
  const store = new KeyedStore()
  assert.equal(sessionDestination(store, 'local', manager.threadId), undefined)
  store.set(keys.summary('local', manager.threadId), summary)
  assert.equal(sessionDestination(store, 'local', manager.threadId), manager.id)
  store.delete(keys.summary('local', manager.threadId))
  catalog(store)
  assert.equal(sessionDestination(store, 'local', manager.threadId), manager.id)
  assert.equal(sessionDestination(store, 'other-device', manager.threadId), undefined)
})

test('未带标记的摘要早于目录，不能先打开普通对话；目录到后只打开一次', () => {
  const store = new KeyedStore()
  const opened: (string | null)[] = []
  store.set(keys.summary('local', manager.threadId), plain)
  store.set(keys.managersAvailable('local'), null)
  const stop = openSessionWhenKnown(store, 'local', manager.threadId, (value) => opened.push(value))
  assert.equal(opened.length, 0)
  catalog(store)
  assert.deepEqual(opened, [manager.id])
  store.set(keys.manager('local', manager.id), { ...manager, name: '新名字' })
  assert.deepEqual(opened, [manager.id])
  stop()
})

test('新建应答先于摘要及目录增量时等待；离开后迟到结果不能抢回导航', () => {
  const store = new KeyedStore()
  store.set(keys.managerIds('local'), [])
  store.set(keys.managersAvailable('local'), true)
  const opened: (string | null)[] = []
  const cancel = openSessionWhenKnown(store, 'local', manager.threadId, (value) =>
    opened.push(value),
  )
  assert.equal(opened.length, 0)
  cancel()
  catalog(store)
  assert.equal(opened.length, 0)
  openSessionWhenKnown(store, 'local', manager.threadId, (value) => opened.push(value))
  assert.deepEqual(opened, [manager.id])
})

test('经理创建应答已确认身份时不依赖目录；未标记的早期摘要不能改变目的页', () => {
  const store = new KeyedStore()
  store.set(keys.managerIds('local'), [])
  store.set(keys.managersAvailable('local'), true)
  store.set(keys.summary('local', manager.threadId), plain)
  const opened: (string | null)[] = []
  openSessionWhenKnown(store, 'local', manager.threadId, (value) => opened.push(value), manager.id)
  assert.deepEqual(opened, [manager.id])
})

test('普通对话、普通子会话、工作线仍是普通详情；不支持经理的设备照常打开', () => {
  const store = new KeyedStore()
  catalog(store)
  for (const session of [
    { ...plain, id: 'ordinary' },
    { ...plain, id: 'child', lineage: { parentId: 'ordinary' } },
    { ...plain, id: 'line', litchManager: { role: 'line', managerId: manager.id } },
  ]) {
    store.set(keys.summary('local', session.id), session)
    assert.equal(sessionDestination(store, 'local', session.id), null)
  }
  store.set(keys.summary('native', 'ordinary'), plain)
  store.set(keys.managersAvailable('native'), false)
  assert.equal(sessionDestination(store, 'native', 'ordinary'), null)
})

test('经理重置不改变目录 ID 时仍更新路由；历史会话不误开新经理', () => {
  const store = new KeyedStore()
  catalog(store)
  store.set(keys.summary('local', manager.threadId), summary)
  const destinations: (string | null | undefined)[] = []
  const stop = subscribeSessionDestination(store, 'local', manager.threadId, () =>
    destinations.push(sessionDestination(store, 'local', manager.threadId)),
  )
  store.set(keys.manager('local', manager.id), {
    ...manager,
    threadId: 'replacement',
    historyThreadIds: [manager.threadId],
  })
  assert.deepEqual(destinations, [null])
  assert.equal(sessionDestination(store, 'local', 'replacement'), manager.id)
  stop()
  store.set(keys.manager('local', manager.id), manager)
  assert.deepEqual(destinations, [null])
})

test('离线缓存的普通对话可直接打开；缓存经理仍按会话标记进入工作台', () => {
  const store = new KeyedStore()
  store.set(keys.device('local'), { stale: true, connection: 'offline' })
  store.set(keys.summary('local', 'ordinary'), plain)
  store.set(keys.summary('local', manager.threadId), summary)
  assert.equal(sessionDestination(store, 'local', 'ordinary'), null)
  assert.equal(sessionDestination(store, 'local', manager.threadId), manager.id)
})
