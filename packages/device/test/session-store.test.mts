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
