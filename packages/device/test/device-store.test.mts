// 项目从 v2 起就是持久数据；升级、拒绝打开和失败回滚都只在隔离目录验证。
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PROJECT_PERMISSION } from '../../protocol/src/project-permissions.mjs'
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
      await client.initialize(['harness', 'deviceWorkspaces', 'projectPermissions'])
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
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4)
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

test('设备库 v3：服务启动保留项目默认、确认记录和已有索引', async () => {
  const stateDir = tempDir()
  let env: Rig | undefined
  try {
    const db = openDeviceStore(stateDir)
    let remembered: ReturnType<ProjectPermissions['read']>
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4)
      const permissions = new ProjectPermissions(db, () => {})
      permissions.call(PROJECT_PERMISSION.set, {
        cwd: stateDir,
        permission: ':danger-full-access',
        confirmed: true,
      })
      remembered = permissions.call(PROJECT_PERMISSION.set, {
        cwd: stateDir,
        permission: ':read-only',
        confirmed: false,
      })
      new ThreadIndex(db).see({ id: 'preserved', updatedAt: 1 }, 'pi')
      db.exec('DROP TABLE restart_turns; PRAGMA user_version=3')
    } finally {
      db.close()
    }
    env = rig({ pi: new FakeEngine('pi') }, {}, { stateDir })
    const client = env.connect()
    await client.initialize(['harness', 'projectPermissions'])
    assert.deepEqual(await client.call(PROJECT_PERMISSION.read, { cwd: stateDir }), remembered)
    const check = new DatabaseSync(join(stateDir, 'device.sqlite'), { readOnly: true })
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 4)
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

test('设备库高于 v4：拒绝降级打开，文件与权限数据不变', () => {
  const stateDir = tempDir()
  const path = join(stateDir, 'device.sqlite')
  try {
    const db = openDeviceStore(stateDir)
    try {
      new ProjectPermissions(db, () => {}).call(PROJECT_PERMISSION.set, {
        cwd: stateDir,
        permission: ':danger-full-access',
        confirmed: true,
      })
      db.exec('PRAGMA user_version=5')
    } finally {
      db.close()
    }
    const before = readFileSync(path)
    assert.throws(() => openDeviceStore(stateDir), /更新的版本（5）建的.*支持到 4.*拒绝降级/)
    assert.deepEqual(readFileSync(path), before)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 5)
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
