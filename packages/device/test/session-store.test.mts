// 会话树的库（sessions.sqlite）：旧版本的库按迁移升上来，已有的数据不丢。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { initializeStoreFormat } from '../../shared/src/store-format.mjs'
import {
  openSessionDatabase,
  SESSION_MIGRATIONS,
  SESSION_SCHEMA_VERSION,
  SessionStore,
} from '../src/session-store.mjs'
import { tempDir } from './helpers.mjs'

test('SESSION-STORE-001：第 1 版的库升上来：从提案开始过的子会话补上 proposalId，提案多出 widerSandbox 一列', () => {
  const dir = tempDir()
  try {
    const old = new DatabaseSync(join(dir, 'sessions.sqlite'))
    initializeStoreFormat(old)
    old.exec(SESSION_MIGRATIONS[0] as string)
    old.exec('PRAGMA user_version=1')
    old.exec(`INSERT INTO lineage(thread_id, parent_thread_id, harness, kind, origin, title, prompt, wake_parent, created_at)
      VALUES('c1', 'p1', 'pi', 'fresh', 'proposal', '提案起的', '做事', 1, 10),
            ('c2', 'p1', 'pi', 'fresh', 'model', '直接起的', '做事', 1, 11)`)
    old.exec(`INSERT INTO proposals(id, thread_id, title, prompt, kind, wake_parent, status, created_at, expires_at, started_thread_id)
      VALUES('pr1', 'p1', '提案起的', '做事', 'fresh', 1, 'started', 5, 99, 'c1'),
            ('pr2', 'p1', '还挂着', '做事', 'fresh', 1, 'pending', 6, 99, NULL)`)
    old.close()
    const db = openSessionDatabase(dir)
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SESSION_SCHEMA_VERSION)
    const store = new SessionStore(db)
    assert.equal(store.parentOf('c1')?.proposalId, 'pr1')
    assert.equal(store.parentOf('c2')?.proposalId, undefined)
    const pending = store.pending('p1')
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.widerSandbox, undefined)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SESSION-STORE-002：第 2 版的库升上来：提案多出了结时间、回合、调用三列，过期的旧提案按到期时间补上了结时间', () => {
  const dir = tempDir()
  try {
    const old = new DatabaseSync(join(dir, 'sessions.sqlite'))
    initializeStoreFormat(old)
    old.exec(SESSION_MIGRATIONS[0] as string)
    old.exec(SESSION_MIGRATIONS[1] as string)
    old.exec('PRAGMA user_version=2')
    old.exec(`INSERT INTO proposals(id, thread_id, title, prompt, kind, wake_parent, status, created_at, expires_at, started_thread_id)
      VALUES('pr1', 'p1', '开始了', '做事', 'fresh', 1, 'started', 5, 99, 'c1'),
            ('pr2', 'p1', '过期了', '做事', 'fresh', 1, 'expired', 6, 77, NULL),
            ('pr3', 'p1', '还挂着', '做事', 'fresh', 1, 'pending', 7, 4000000000, NULL)`)
    old.close()
    const db = openSessionDatabase(dir)
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SESSION_SCHEMA_VERSION)
    const store = new SessionStore(db)
    const of = (id: string) => {
      const one = store.proposal(id)
      return [one?.status, one?.settledAt, one?.turnId, one?.callId]
    }
    assert.deepEqual(of('pr1'), ['started', null, null, null])
    assert.deepEqual(of('pr2'), ['expired', 77, null, null])
    assert.deepEqual(of('pr3'), ['pending', null, null, null])
    // 新提的带回合、调用；撤回入库、记了结时间；同一回合数得出来
    store.addProposal({
      id: 'pr4',
      threadId: 'p1',
      title: '新的',
      prompt: '做事',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      createdAt: 8,
      expiresAt: 4000000000,
      turnId: 't1',
      callId: 'call-1',
    })
    assert.equal(store.countInTurn('p1', 't1'), 1)
    assert.ok(store.settleProposal('pr4', 'withdrawn', null))
    assert.equal(store.settleProposal('pr4', 'dismissed', null), false, '了结过的不再改')
    const withdrawn = store.proposal('pr4')
    assert.deepEqual(
      [withdrawn?.status, withdrawn?.turnId, withdrawn?.callId],
      ['withdrawn', 't1', 'call-1'],
    )
    assert.ok((withdrawn?.settledAt ?? 0) > 1_000_000_000)
    assert.deepEqual(
      store.recent('p1', 2).map((one) => one.id),
      ['pr4', 'pr3'],
    )
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SESSION-STORE-003：第 5 版的库升上来：提案多出背景一列，旧提案是空串；新提的背景存得进、读得回，重开库还在', () => {
  const dir = tempDir()
  try {
    const old = new DatabaseSync(join(dir, 'sessions.sqlite'))
    initializeStoreFormat(old)
    for (const step of SESSION_MIGRATIONS.slice(0, 5)) old.exec(step)
    old.exec('PRAGMA user_version=5')
    old.exec(`INSERT INTO proposals(id, thread_id, title, prompt, kind, wake_parent, status, created_at, expires_at, started_thread_id)
      VALUES('pr1', 'p1', '旧的', '做事', 'fresh', 1, 'pending', 5, 4000000000, NULL)`)
    old.close()
    const db = openSessionDatabase(dir)
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SESSION_SCHEMA_VERSION)
    const store = new SessionStore(db)
    assert.equal(store.proposal('pr1')?.background, '')
    const added = store.addProposal({
      id: 'pr2',
      threadId: 'p1',
      title: '新的',
      prompt: '补集成测试。',
      background: '这一轮在给订单服务补测试，单测已经齐了。',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      createdAt: 8,
      expiresAt: 4000000000,
    })
    assert.equal(added.background, '这一轮在给订单服务补测试，单测已经齐了。')
    db.close()
    const again = new SessionStore(openSessionDatabase(dir))
    const back = again.proposal('pr2')
    assert.deepEqual(
      [back?.prompt, back?.background],
      ['补集成测试。', '这一轮在给订单服务补测试，单测已经齐了。'],
    )
    assert.deepEqual(
      again.pending('p1').map((one) => [one.id, one.background]),
      [
        ['pr1', ''],
        ['pr2', '这一轮在给订单服务补测试，单测已经齐了。'],
      ],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SESSION-STORE-004：上一版的库升上来：提案多出 effort 一列，旧提案是 null；新提的存得进、读得回', () => {
  const dir = tempDir()
  try {
    const old = new DatabaseSync(join(dir, 'sessions.sqlite'))
    initializeStoreFormat(old)
    const previous = SESSION_SCHEMA_VERSION - 1
    for (const step of SESSION_MIGRATIONS.slice(0, previous)) old.exec(step)
    old.exec(`PRAGMA user_version=${previous}`)
    old.exec(`INSERT INTO proposals(id, thread_id, title, prompt, kind, wake_parent, status, created_at, expires_at, started_thread_id)
      VALUES('pr1', 'p1', '旧的', '做事', 'fresh', 1, 'pending', 5, 4000000000, NULL)`)
    old.close()
    const store = new SessionStore(openSessionDatabase(dir))
    assert.equal(store.proposal('pr1')?.effort, null)
    const added = store.addProposal({
      id: 'pr2',
      threadId: 'p1',
      title: '新的',
      prompt: '补集成测试。',
      harness: null,
      model: null,
      effort: 'high',
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      createdAt: 8,
      expiresAt: 4000000000,
    })
    assert.equal(added.effort, 'high')
    assert.equal(store.proposal('pr2')?.effort, 'high')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
