import assert from 'node:assert/strict'
import test from 'node:test'
import type { SuggestionEntry, SuggestionsSnapshot } from '../../protocol/src/suggestion-inbox.mjs'
import { SUGGESTIONS_CHANGED } from '../../protocol/src/suggestion-inbox.mjs'
import { createSuggestions } from '../src/device/suggestions.mjs'
import {
  connectChannel,
  createMockCore,
  createPortPair,
  createReplica,
  keys,
  serveChannel,
} from '../src/index.mjs'
import {
  filterSuggestions,
  type SuggestionsView,
  type SuggestionView,
} from '../src/model-suggestions.mjs'
import { fakeClock, settle } from './helpers.mjs'

const row = (id: string): SuggestionEntry => ({
  proposal: {
    id,
    threadId: 'source',
    title: id,
    prompt: '检查',
    harness: null,
    model: null,
    cwd: null,
    kind: 'fresh',
    wakeParent: true,
    status: 'pending',
    createdAt: 1,
    expiresAt: 8_640_000_000_000,
    startedThreadId: null,
  },
  source: {
    project: null,
    threadId: 'source',
    title: '来源',
    harness: 'pi',
    cwd: '/work',
    archived: true,
  },
  managerId: 'm1',
})

test('快照在途重放增量，断线保留，重连清除服务端已处理建议', async () => {
  let reply: ((view: SuggestionsSnapshot) => void) | undefined
  let latest: SuggestionsView | undefined
  const client = createSuggestions({
    deviceId: 'one',
    online: () => true,
    supported: () => true,
    request: () =>
      new Promise((resolve) => {
        reply = resolve
      }),
    log() {},
  })
  const off = client.open({
    snapshot: (v) => {
      latest = v as SuggestionsView
    },
    delta: (ops) => {
      latest = (ops[0] as { view: SuggestionsView }).view
    },
    error: () => assert.fail(),
  })
  client.resync()
  client.notification(SUGGESTIONS_CHANGED, { upserts: [row('new')], removed: ['old'] })
  reply?.({ suggestions: [row('old')] })
  await settle()
  assert.deepEqual(
    latest?.suggestions.map((r) => r.proposal.id),
    ['new'],
  )
  assert.equal(latest?.suggestions[0]?.proposal.createdAt, 1000)
  assert.equal(latest?.suggestions[0]?.source.archived, true)
  client.offline()
  assert.equal(latest?.suggestions.length, 1)
  client.resync()
  const stale = reply
  client.offline()
  client.resync()
  reply?.({ suggestions: [] })
  await settle()
  stale?.({ suggestions: [row('stale')] })
  await settle()
  assert.deepEqual(latest?.suggestions, [])
  off()
})

test('经理筛选以设备和经理联合匹配，不混进同名经理或普通会话', () => {
  const rows = [
    { deviceId: 'one', managerId: 'm1' },
    { deviceId: 'two', managerId: 'm1' },
    { deviceId: 'one', managerId: null },
    { deviceId: 'one', managerId: 'm2' },
  ] as SuggestionView[]
  assert.deepEqual(filterSuggestions(rows, { deviceId: 'one', managerId: 'm1' }), [rows[0]])
  assert.equal(filterSuggestions(rows, null), rows)
})

test('副本跨设备合并；模拟归档保留，执行时恢复，删除来源移除', async () => {
  const time = fakeClock()
  const [ui, core] = createPortPair()
  const server = serveChannel(core, createMockCore({ clock: time.clock, chunkMs: 0 }), {
    clock: time.clock,
  })
  const channel = connectChannel(ui)
  const replica = createReplica(channel)
  const stop = replica.start()
  const rows = () => replica.store.get<SuggestionView[]>(keys.suggestions) ?? []
  const advance = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) {
      time.advance(50)
      await settle()
    }
    assert.ok(check())
  }
  try {
    await settle()
    const watchers: (() => void)[] = []
    for (const [deviceId, sessionId] of [
      ['local', 's6'],
      ['build', 'b3'],
    ] as const) {
      watchers.push(
        channel.subscribe({ kind: 'session', deviceId, sessionId }, { snapshot() {}, delta() {} }),
      )
      await settle()
      await channel.command('session.send', { deviceId, sessionId, text: '收尾建议' })
    }
    await advance(() => rows().length === 4)
    assert.deepEqual([...new Set(rows().map((r) => r.deviceId))].sort(), ['build', 'local'])
    // 让回答结束，归档不依赖用户曾打开归档列表。
    for (let i = 0; i < 100; i++) {
      time.advance(50)
      await settle()
    }
    await channel.command('session.archive', { deviceId: 'local', sessionId: 's6' })
    await advance(() =>
      rows()
        .filter((r) => r.deviceId === 'local')
        .every((r) => r.source.archived),
    )
    assert.equal(rows().length, 4)
    const p = rows().find((r) => r.deviceId === 'local')
    assert.ok(p)
    await channel.command('session.proposal.here', {
      deviceId: 'local',
      sessionId: 's6',
      proposalId: p.proposal.id,
    })
    await advance(
      () =>
        rows().length === 3 &&
        rows()
          .filter((r) => r.deviceId === 'local')
          .every((r) => !r.source.archived),
    )
    await channel.command('session.delete', { deviceId: 'build', sessionId: 'b3' })
    await advance(() => rows().length === 1)
    for (const off of watchers) off()
  } finally {
    stop()
    channel.close()
    server()
  }
})
