// 恢复脚本只用隔离的合成状态目录，绝不接触个人库或真实服务。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  applyRecovery,
  backupState,
  planRecovery,
  readInventory,
} from './recover-device-projects.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'litch-recover-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'adapter'),
    codex = join(root, 'codex.sqlite'),
    dsh = join(root, 'dsh')
  fs.mkdirSync(join(home, 'device'), { recursive: true })
  fs.mkdirSync(join(home, 'claude-code'))
  fs.mkdirSync(join(home, 'pi'))
  const file = join(home, 'device/device.sqlite')
  const db = new DatabaseSync(file)
  db.exec(
    fs.readFileSync(
      new URL('../packages/device/test/fixtures/device-v0.27.5.sql', import.meta.url),
      'utf8',
    ),
  )
  db.exec(`PRAGMA user_version=4; DELETE FROM projects; DELETE FROM project_threads;
    CREATE TABLE project_permissions(cwd TEXT PRIMARY KEY, permission TEXT, confirmed TEXT);
    INSERT INTO project_permissions VALUES('/work/a',':read-only','[]');`)
  // 保留分组和置顶，证明恢复过程只补项目，不动其他用户数据。
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('codex-old', 'codex', 100, 0, 0, 100)
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('missing', 'opencode', 100, 0, 0, 100)
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('temporary', 'pi', 100, 0, 1, 100)
  db.close()
  for (const name of ['manager', 'sessions', 'tasks', 'worktrees']) {
    const other = new DatabaseSync(join(home, `device/${name}.sqlite`))
    other.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('keep')")
    other.close()
  }
  fs.writeFileSync(join(home, 'env'), 'TEST_NOT_A_SECRET=value\n')
  fs.writeFileSync(join(home, 'device/settings.json'), '{}')
  const claude = new DatabaseSync(join(home, 'claude-code/state.sqlite'))
  claude.exec(
    "CREATE TABLE threads(id TEXT,cwd TEXT); INSERT INTO threads VALUES('claude-old','/work/a')",
  )
  claude.close()
  const pi = new DatabaseSync(join(home, 'pi/adapter.sqlite'))
  pi.exec(`CREATE TABLE threads(id TEXT,data TEXT);
    INSERT INTO threads VALUES('pi-old','{"cwd":"/work/a"}'),('archived-old','{"cwd":"/work/b"}'),('temporary','{"cwd":"/work/c"}');`)
  pi.close()
  const native = new DatabaseSync(codex)
  native.exec(
    "CREATE TABLE threads(id TEXT,cwd TEXT); INSERT INTO threads VALUES('codex-old','/work/c')",
  )
  native.close()
  return { root, home, file, codex, dsh, read: () => readInventory(home, codex, dsh) }
}

function inspect(file, query) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(query).all()
  } finally {
    db.close()
  }
}

test('默认运行只打印计划，不建备份、不修改库；覆盖跨引擎、归档与缺失 cwd', async (t) => {
  const f = fixture(t),
    before = fs.readFileSync(f.file)
  const raw = execFileSync(
    process.execPath,
    [
      new URL('./recover-device-projects.mjs', import.meta.url).pathname,
      '--home',
      f.home,
      '--codex-db',
      f.codex,
      '--dsh-home',
      f.dsh,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.root, CODEX_HOME: f.root },
    },
  )
  const plan = JSON.parse(raw)
  assert.equal(plan.mode, 'plan')
  assert.equal(plan.recoverable, 4)
  assert.equal(plan.createProjects, 3)
  assert.equal(plan.transient, 1)
  assert.equal(plan.skipped[0].id, 'missing')
  assert.equal(plan.projects.find((p) => p.cwd === '/work/a').threads.length, 2)
  assert.deepEqual(fs.readFileSync(f.file), before)
  assert.equal(fs.existsSync(`${f.home}-backups`), false)
})

test('写入前强制摘要确认、服务停止；在线备份完成后只补归属，重复执行不重建', async (t) => {
  const f = fixture(t),
    inventory = await f.read(),
    plan = planRecovery(inventory)
  await assert.rejects(applyRecovery(f.home, inventory, plan, 'wrong'), /已审阅计划/)
  fs.writeFileSync(join(f.home, 'device/service.json'), JSON.stringify({ pid: process.pid }))
  await assert.rejects(applyRecovery(f.home, inventory, plan, plan.digest), /仍在运行/)
  fs.unlinkSync(join(f.home, 'device/service.json'))
  const sections = inspect(f.file, 'SELECT * FROM thread_sections')
  const permissions = inspect(f.file, 'SELECT * FROM project_permissions')
  const result = await applyRecovery(f.home, inventory, plan, plan.digest)
  assert.equal(result.projects, 3)
  assert.equal(result.memberships, 4)
  const backup = join(result.backupDirectory, 'device/device.sqlite')
  assert.equal(inspect(backup, 'SELECT count(*) AS n FROM project_threads')[0].n, 0)
  assert.equal(inspect(f.file, 'SELECT count(*) AS n FROM project_threads')[0].n, 4)
  assert.deepEqual(inspect(f.file, 'SELECT * FROM thread_sections'), sections)
  assert.deepEqual(inspect(f.file, 'SELECT * FROM project_permissions'), permissions)
  for (const file of [
    'device/manager.sqlite',
    'device/sessions.sqlite',
    'device/tasks.sqlite',
    'device/worktrees.sqlite',
    'claude-code/state.sqlite',
    'pi/adapter.sqlite',
    'env',
    'device/settings.json',
  ])
    assert.equal(fs.existsSync(join(result.backupDirectory, file)), true)
  const next = await f.read(),
    second = planRecovery(next)
  assert.equal(second.recoverable, 0)
  assert.equal(second.alreadyAssigned, 4)
  assert.equal((await applyRecovery(f.home, next, second, second.digest)).projects, 0)
})

test('保留已有项目和手工归属，不擅自选多根目录冲突', async (t) => {
  const f = fixture(t),
    inventory = await f.read()
  inventory.projects = [
    { id: 'kept', name: '原名', roots_json: '[{"path":"/work/a"},{"path":"/work/other"}]' },
  ]
  inventory.memberships = [{ thread_id: 'claude-old', project_id: 'kept' }]
  const plan = planRecovery(inventory)
  assert.equal(plan.alreadyAssigned, 1)
  assert.equal(plan.projects.find((p) => p.cwd === '/work/a').projectId, 'kept')
  inventory.projects.push({ id: 'conflict', name: '另一个', roots_json: '[{"path":"/work/a"}]' })
  assert.ok(planRecovery(inventory).skipped.some((t) => t.id === 'pi-old'))
})

test('备份失败不写库，事务中失败回滚已建项目和归属', async (t) => {
  const f = fixture(t),
    inventory = await f.read(),
    plan = planRecovery(inventory)
  fs.writeFileSync(`${f.home}-backups`, 'block')
  await assert.rejects(applyRecovery(f.home, inventory, plan, plan.digest))
  assert.equal(inspect(f.file, 'SELECT count(*) AS n FROM projects')[0].n, 0)
  fs.unlinkSync(`${f.home}-backups`)
  const db = new DatabaseSync(f.file)
  db.exec(
    "CREATE TRIGGER fail_recovery BEFORE INSERT ON project_threads WHEN NEW.thread_id='pi-old' BEGIN SELECT RAISE(ABORT,'test failure'); END",
  )
  db.close()
  await assert.rejects(applyRecovery(f.home, inventory, plan, plan.digest), /test failure/)
  assert.equal(inspect(f.file, 'SELECT count(*) AS n FROM projects')[0].n, 0)
  assert.equal(inspect(f.file, 'SELECT count(*) AS n FROM project_threads')[0].n, 0)
})

test('仅保留本工具四份完整备份，不删除其他备份', async (t) => {
  const f = fixture(t)
  fs.mkdirSync(join(`${f.home}-backups`, 'manual-backup'), { recursive: true })
  for (let i = 0; i < 5; i++) await backupState(f.home)
  const entries = fs.readdirSync(`${f.home}-backups`)
  assert.equal(entries.filter((x) => x.startsWith('project-recovery-')).length, 4)
  assert.ok(entries.includes('manual-backup'))
})

test('--only 可重复选择精确目录，预览和写入使用同一范围，不包括子目录', async (t) => {
  const f = fixture(t),
    inventory = await f.read()
  const plan = planRecovery(inventory, { only: ['/work/a', '/work/b', '/work/a'] })
  assert.equal(plan.recoverable, 3)
  assert.equal(plan.excluded, 1)
  assert.deepEqual(plan.selection, ['/work/a', '/work/b'])
  assert.equal(planRecovery(inventory, { only: ['/work'] }).recoverable, 0)
  assert.throws(() => planRecovery(inventory, { only: ['relative'] }), /绝对目录/)
  const raw = execFileSync(
    process.execPath,
    [
      new URL('./recover-device-projects.mjs', import.meta.url).pathname,
      '--home',
      f.home,
      '--codex-db',
      f.codex,
      '--dsh-home',
      f.dsh,
      '--only',
      '/work/a',
      '--only',
      '/work/b',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.root, CODEX_HOME: f.root },
    },
  )
  assert.equal(JSON.parse(raw).digest, plan.digest)
  const result = await applyRecovery(f.home, inventory, plan, plan.digest)
  assert.equal(result.projects, 2)
  assert.equal(result.memberships, 3)
  assert.equal(
    inspect(f.file, "SELECT * FROM project_threads WHERE thread_id='codex-old'").length,
    0,
  )
})
