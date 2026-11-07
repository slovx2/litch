// 项目从 v2 起就是持久数据；升级、拒绝打开和失败回滚都只在隔离目录验证。
import assert from 'node:assert/strict'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PROJECT_PERMISSION } from '../../protocol/src/harness-project-permissions.mjs'
import { initializeStoreFormat } from '../../shared/src/store-format.mjs'
import { ProjectPermissions } from '../src/project-permissions.mjs'
import { openDeviceStore } from '../src/store.mjs'
import { ThreadIndex } from '../src/thread-index.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { type Rig, rig, tempDir } from './helpers.mjs'

const fixture = readFileSync(
  new URL('../../../test/fixtures/device-v0.27.5.sql', import.meta.url),
  'utf8',
)
const preservedTables = [
  'threads',
  'projects',
  'project_threads',
  'sections',
  'thread_sections',
  'imports',
]
const snapshot = (db: DatabaseSync) =>
  Object.fromEntries(
    preservedTables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]),
  )

test('v5 恢复票迁移保留未发送资格，并给后台摘要空默认值', () => {
  const dir = tempDir()
  try {
    let db = openDeviceStore(dir)
    db.exec(`ALTER TABLE restart_turns DROP COLUMN background;
      INSERT INTO restart_turns(thread_id,harness,token,turn_id,state,service,prepared_at)
      VALUES('held','codex','ticket','turn','ready','old-service',123);
      PRAGMA user_version=5`)
    db.close()
    db = openDeviceStore(dir)
    const row = db.prepare('SELECT * FROM restart_turns').get()
    assert.equal(row?.state, 'ready')
    assert.equal(row?.token, 'ticket')
    assert.equal(row?.prepared_at, 123)
    assert.equal(row?.background, '[]')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧 v4 实库升级只清空跨 harness 权限：防止整库重建丢失项目、归属、分组与置顶', async () => {
  const stateDir = tempDir()
  const path = join(stateDir, 'device.sqlite')
  const other = join(stateDir, 'other.sqlite')
  let env: Rig | undefined
  try {
    const old = new DatabaseSync(path)
    // 真实 0.27.5 数据导出，加上 0.29.0 的两张表，形成独立于当前建库代码的旧 v4 实库。
    old.exec(fixture)
    old.exec(`CREATE TABLE project_permissions(cwd TEXT PRIMARY KEY, permission TEXT NOT NULL, confirmed TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE restart_turns(thread_id TEXT PRIMARY KEY,harness TEXT NOT NULL,token TEXT NOT NULL,turn_id TEXT,state TEXT NOT NULL,service TEXT NOT NULL DEFAULT '',prepared_at INTEGER,resume_turn_id TEXT) WITHOUT ROWID;
      CREATE TABLE unrelated_payload(id TEXT PRIMARY KEY, content BLOB NOT NULL);
      INSERT INTO unrelated_payload VALUES('keep', X'0001FF'); PRAGMA user_version=4`)
    old
      .prepare('INSERT INTO project_permissions VALUES(?,?,?)')
      .run(stateDir, ':danger-full-access', '[":danger-full-access"]')
    const tables = old
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name!='project_permissions' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name))
    const allRows = (db: DatabaseSync) =>
      Object.fromEntries(
        tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all()]),
      )
    const before = allRows(old)
    old.close()
    const inode = statSync(path).ino
    const unrelated = new DatabaseSync(other)
    unrelated.exec("CREATE TABLE records(value TEXT NOT NULL); INSERT INTO records VALUES('keep')")
    unrelated.close()
    const otherBefore = readFileSync(other)
    // 直接验证升级事务，再让新服务打开同一个文件，不能换库或改其他表。
    const upgraded = openDeviceStore(stateDir)
    assert.equal(statSync(path).ino, inode)
    assert.deepEqual(allRows(upgraded), before)
    assert.equal(upgraded.prepare('SELECT count(*) AS n FROM project_permissions').get()?.n, 0)
    upgraded.close()
    env = rig({ pi: new FakeEngine('pi') }, {}, { stateDir })
    const client = env.connect()
    await client.initialize(['harness', 'deviceWorkspaces', 'harnessProjectPermissions'])
    assert.equal(
      (await client.call(PROJECT_PERMISSION.read, { cwd: stateDir, harness: 'pi' })).permission,
      null,
    )
    await client.call(PROJECT_PERMISSION.set, {
      cwd: stateDir,
      harness: 'pi',
      permission: ':read-only',
      confirmed: false,
    })
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 6)
      assert.deepEqual(allRows(check), before)
      assert.equal(check.prepare('SELECT harness FROM project_permissions').get()?.harness, 'pi')
      assert.deepEqual(readFileSync(other), otherBefore)
    } finally {
      check.close()
    }
  } finally {
    if (env) await env.close()
    else rmSync(stateDir, { recursive: true, force: true })
  }
})

for (const wal of [false, true]) {
  test(`真实 0.27.5 v2 库升级：项目、多根、归属、分组、置顶、排序和导入记录原样保留（WAL=${wal}）`, async () => {
    const stateDir = tempDir()
    let old: DatabaseSync | undefined = new DatabaseSync(join(stateDir, 'device.sqlite'))
    let env: Rig | undefined
    try {
      if (wal) old.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
      old.exec(fixture)
      const before = snapshot(old)
      if (!wal) {
        old.close()
        old = undefined
      }
      env = rig({ pi: new FakeEngine('pi') }, {}, { stateDir })
      const client = env.connect()
      await client.initialize(['harness', 'deviceWorkspaces', 'harnessProjectPermissions'])
      const projects = (await client.call('project/list')).data
      assert.deepEqual(
        projects.map((p: any) => p.name),
        ['第二项目', '多根项目'],
      )
      assert.deepEqual(projects[1].roots, [{ path: '/work/甲' }, { path: '/work/乙' }])
      assert.equal(
        (await client.call('threadSection/list')).data.some((s: any) => s.id === 'custom'),
        true,
      )
      const db = new DatabaseSync(join(stateDir, 'device.sqlite'), { readOnly: true })
      try {
        assert.deepEqual(snapshot(db), before)
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 6)
        assert.equal(db.prepare('SELECT count(*) AS n FROM project_permissions').get()?.n, 0)
        assert.equal(db.prepare('SELECT count(*) AS n FROM restart_turns').get()?.n, 0)
      } finally {
        db.close()
      }
      // 再打开必须幂等，不能再次清空或重排。
      const reopened = openDeviceStore(stateDir)
      try {
        assert.deepEqual(snapshot(reopened), before)
      } finally {
        reopened.close()
      }
    } finally {
      old?.close()
      if (env) await env.close()
      else rmSync(stateDir, { recursive: true, force: true })
    }
  })
}

for (const version of [0, 1, 2]) {
  test(`未知或损坏的 v${version} 结构拒绝打开，原文件不变`, () => {
    const stateDir = tempDir()
    const path = join(stateDir, 'device.sqlite')
    try {
      const old = new DatabaseSync(path)
      initializeStoreFormat(old)
      old.exec(
        `PRAGMA user_version=${version}; CREATE TABLE threads(old_id TEXT); INSERT INTO threads VALUES('preserve-me')`,
      )
      old.close()
      const before = readFileSync(path)
      assert.throws(
        () => openDeviceStore(stateDir),
        version < 2 ? /没有可用迁移/ : /no such column/,
      )
      assert.deepEqual(readFileSync(path), before)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
}

test('设备库 v3：只作废跨 harness 权限，保留已有索引', async () => {
  const stateDir = tempDir()
  let env: Rig | undefined
  try {
    const db = openDeviceStore(stateDir)
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 6)
      const permissions = new ProjectPermissions(db, () => {})
      permissions.call(PROJECT_PERMISSION.set, {
        harness: 'pi',
        cwd: stateDir,
        permission: ':danger-full-access',
        confirmed: true,
      })
      permissions.call(PROJECT_PERMISSION.set, {
        harness: 'pi',
        cwd: stateDir,
        permission: ':read-only',
        confirmed: false,
      })
      new ThreadIndex(db).see({ id: 'preserved', updatedAt: 1 }, 'pi')
      db.exec(`DROP TABLE restart_turns; DROP TABLE project_permissions;
        CREATE TABLE project_permissions(cwd TEXT PRIMARY KEY, permission TEXT NOT NULL, confirmed TEXT NOT NULL) WITHOUT ROWID;
        INSERT INTO project_permissions VALUES('/old', ':danger-full-access', '[":danger-full-access"]');
        PRAGMA user_version=3`)
    } finally {
      db.close()
    }
    env = rig({ pi: new FakeEngine('pi') }, {}, { stateDir })
    const client = env.connect()
    await client.initialize(['harness', 'harnessProjectPermissions'])
    assert.equal(
      (await client.call(PROJECT_PERMISSION.read, { harness: 'pi', cwd: stateDir })).permission,
      null,
    )
    const check = new DatabaseSync(join(stateDir, 'device.sqlite'), { readOnly: true })
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 6)
      assert.equal(
        check.prepare("SELECT harness FROM threads WHERE id='preserved'").get()?.harness,
        'pi',
      )
    } finally {
      check.close()
    }
  } finally {
    if (env) await env.close()
    else rmSync(stateDir, { recursive: true, force: true })
  }
})

test('设备库高于 v6：拒绝降级打开，文件与权限数据不变', () => {
  const stateDir = tempDir()
  const path = join(stateDir, 'device.sqlite')
  try {
    const db = openDeviceStore(stateDir)
    try {
      new ProjectPermissions(db, () => {}).call(PROJECT_PERMISSION.set, {
        harness: 'pi',
        cwd: stateDir,
        permission: ':danger-full-access',
        confirmed: true,
      })
      db.exec('PRAGMA user_version=7')
    } finally {
      db.close()
    }
    const before = readFileSync(path)
    assert.throws(() => openDeviceStore(stateDir), /更新的版本（7）建的.*支持到 6.*拒绝降级/)
    assert.deepEqual(readFileSync(path), before)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 7)
      assert.equal(
        check.prepare('SELECT permission FROM project_permissions').get()?.permission,
        ':danger-full-access',
      )
    } finally {
      check.close()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
