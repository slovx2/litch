// v3 是可重建缓存与持久授权数据的边界；只在隔离状态目录里验证升级和降级行为。
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

for (const version of [1, 2]) {
  test(`设备库 v${version}：重建旧结构后设备服务可握手、创建会话`, async () => {
    const stateDir = tempDir()
    let env: Rig | undefined
    try {
      const old = new DatabaseSync(join(stateDir, 'device.sqlite'))
      try {
        initializeStoreFormat(old)
        // 故意保留不兼容的 threads 结构，防止只是改了版本号却没有重建。
        old.exec(`PRAGMA user_version=${version};
          CREATE TABLE threads(old_id TEXT);
          INSERT INTO threads VALUES('old-thread');
          CREATE TABLE old_cache(value TEXT);`)
      } finally {
        old.close()
      }
      env = rig({ pi: new FakeEngine('pi') }, {}, { stateDir })
      const client = env.connect()
      await client.initialize(['harness', 'projectPermissions'])
      const created = await client.call('thread/start', { harness: 'pi', cwd: stateDir })
      assert.equal(typeof created.thread.id, 'string')
      assert.equal((await client.call(PROJECT_PERMISSION.read, { cwd: stateDir })).permission, null)
      const db = new DatabaseSync(join(stateDir, 'device.sqlite'), { readOnly: true })
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3)
        assert.equal(
          db.prepare("SELECT name FROM sqlite_master WHERE name='old_cache'").get(),
          undefined,
        )
        assert.equal(
          db.prepare('SELECT id FROM threads WHERE id=?').get(created.thread.id)?.id,
          created.thread.id,
        )
      } finally {
        db.close()
      }
    } finally {
      if (env) await env.close()
      else rmSync(stateDir, { recursive: true, force: true })
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
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3)
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
    } finally {
      db.close()
    }
    env = rig({ pi: new FakeEngine('pi') }, {}, { stateDir })
    const client = env.connect()
    await client.initialize(['harness', 'projectPermissions'])
    assert.deepEqual(await client.call(PROJECT_PERMISSION.read, { cwd: stateDir }), remembered)
    const check = new DatabaseSync(join(stateDir, 'device.sqlite'), { readOnly: true })
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 3)
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

test('设备库高于 v3：拒绝降级打开，文件与权限数据不变', () => {
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
      db.exec('PRAGMA user_version=4')
    } finally {
      db.close()
    }
    const before = readFileSync(path)
    assert.throws(() => openDeviceStore(stateDir), /更新的版本（4）建的.*支持到 3.*拒绝降级/)
    assert.deepEqual(readFileSync(path), before)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 4)
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
