import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  catalogUnread,
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  keys,
  type ManagerSessionSummary,
  projectSessionCatalog,
  type SessionCatalog,
  type SessionGroups,
  type SidebarProjections,
  serveChannel,
} from '../src/index.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'
import { fakeClock, settle } from './helpers.mjs'

test('全目录按身份分类，缺失父项的工作线和未带标记的后代不丢失，未读逐线程计算', () => {
  const rows = sampleManagers('local', 1_800_000_000, 'zh-CN').sessions
  const manager = rows.find((row) => row.id === 'm1')
  const line = rows.find((row) => row.id === 'manager-k1')
  assert.ok(manager && line?.lineage)
  const { litchManager: _manager, ...plainManager } = manager
  const { litchManager: _line, ...plainLine } = line
  const source: ManagerSessionSummary[] = [
    { ...manager, unread: true },
    { ...line, unread: true },
    {
      ...plainLine,
      id: 'grandchild',
      lineage: { ...line.lineage, parentId: line.id },
      unread: true,
    },
    { ...line, id: 'orphan-line', lineage: null, unread: false },
    {
      ...plainLine,
      id: 'child',
      lineage: { ...line.lineage, parentId: 'ordinary' },
      unread: false,
    },
    { ...plainManager, id: 'ordinary', unread: false },
  ]
  const catalog = projectSessionCatalog(source)
  assert.deepEqual(
    catalog.map((row) => row.kind),
    ['manager', 'line', 'line', 'line', 'child', 'conversation'],
  )
  assert.deepEqual(catalogUnread(catalog), ['grandchild', 'm1', 'manager-k1'])
})

test('副本全目录和徽标包含经理树；普通分组与根聚合不变，已读及归档增量同步', async () => {
  const time = fakeClock()
  const [ui, core] = createPortPair()
  const server = serveChannel(core, createMockCore({ clock: time.clock }), { clock: time.clock })
  const channel = connectChannel(ui)
  const replica = createReplica(channel)
  const stop = replica.start()
  try {
    await settle()
    await settle()
    const { store } = replica
    const catalog = () => {
      const value = store.get<SessionCatalog>(keys.sessionCatalog('local'))
      assert.ok(value)
      return value
    }
    assert.equal(catalog().find((row) => row.id === 'm1')?.kind, 'manager')
    assert.equal(catalog().find((row) => row.id === 'manager-k2')?.kind, 'line')
    assert.equal(catalog().find((row) => row.id === 's3')?.kind, 'conversation')
    assert.equal(new Set(catalog().map((row) => row.id)).size, catalog().length)
    const groups = store.get<SessionGroups>(keys.groups('local'))
    assert.ok(groups)
    assert.ok(
      !Object.values(groups)
        .flat()
        .some((id) => id === 'm1' || id.startsWith('manager-')),
    )
    assert.deepEqual(store.get(keys.unread('local')), ['s3', 's7'])
    assert.deepEqual(store.get(keys.catalogUnread('local')), ['manager-k2', 's3', 's7'])
    const projection = store.get<SidebarProjections>(keys.sidebarProjections('local'))
    assert.ok(projection)
    assert.ok(projection.unread.some((row) => row.sessionId === 'm1'))
    assert.ok(!projection.unread.some((row) => row.sessionId === 'manager-k2'))
    const pending = store.get(keys.managersPending)
    await channel.command('session.markRead', { deviceId: 'local', sessionId: 'manager-k2' })
    time.advance(16)
    await settle()
    assert.deepEqual(store.get(keys.catalogUnread('local')), ['s3', 's7'])
    assert.equal(store.get(keys.managersPending), pending)
    assert.deepEqual(store.get(keys.groups('local')), groups)
    await channel.command('session.archive', { deviceId: 'local', sessionId: 'manager-k2' })
    time.advance(16)
    await settle()
    assert.ok(!catalog().some((row) => row.id === 'manager-k2'))
    await channel.command('session.unarchive', { deviceId: 'local', sessionId: 'manager-k2' })
    time.advance(16)
    await settle()
    assert.equal(catalog().find((row) => row.id === 'manager-k2')?.kind, 'line')
  } finally {
    stop()
    channel.close()
    server()
  }
})
