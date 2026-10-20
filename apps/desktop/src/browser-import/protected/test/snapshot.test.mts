import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { readerForPlatform } from '../reader.mjs'
import { ReadFault } from '../result.mjs'
import { Snapshot } from '../snapshot.mjs'
import { addCookie, chromeCookies, fixture, secrets } from './fixtures.mjs'

test('复制主库和 WAL/SHM 后能读到未 checkpoint 的提交，来源字节不变', async () => {
  const f = await fixture()
  const db = chromeCookies(f.input)
  let snapshot: Snapshot | undefined
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
    addCookie(db)
    const source = join(f.input.profileDir, 'Cookies')
    const paths = ['', '-wal', '-shm'].map((suffix) => source + suffix)
    const digest = async () =>
      Promise.all(
        paths.map(async (path) =>
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        ),
      )
    const before = await digest()
    snapshot = await Snapshot.create(f.input.signal)
    const copy = await snapshot.database(source, f.input.signal)
    try {
      assert.equal(copy?.prepare('SELECT count(*) AS n FROM cookies').get()?.n, 1)
    } finally {
      copy?.close()
    }
    assert.deepEqual(await digest(), before)
    const files = await readdir(snapshot.directory)
    assert.ok(files.includes('0-wal'))
    assert.ok(files.includes('0-shm'))
    if (process.platform !== 'win32') {
      assert.equal((await stat(snapshot.directory)).mode & 0o777, 0o700)
      for (const file of files)
        assert.equal((await stat(join(snapshot.directory, file))).mode & 0o077, 0)
    }
    const dir = snapshot.directory
    await snapshot.dispose()
    snapshot = undefined
    await assert.rejects(lstat(dir), { code: 'ENOENT' })
  } finally {
    await snapshot?.dispose()
    db.close()
    await f.dispose()
  }
})

test('journal 旁路文件也要复制，副本是只读连接', async () => {
  const f = await fixture()
  let snapshot: Snapshot | undefined
  try {
    const db = chromeCookies(f.input)
    addCookie(db)
    db.close()
    const source = join(f.input.profileDir, 'Cookies')
    await writeFile(`${source}-journal`, Buffer.alloc(512))
    snapshot = await Snapshot.create(f.input.signal)
    const copied = await snapshot.file(source, f.input.signal, true)
    assert.deepEqual(await readFile(`${copied}-journal`), Buffer.alloc(512))
    const copy = await snapshot.database(source, f.input.signal)
    try {
      assert.throws(() => copy?.exec('DELETE FROM cookies'))
    } finally {
      copy?.close()
    }
  } finally {
    await snapshot?.dispose()
    await f.dispose()
  }
})

test('拒绝文件、旁路文件、父目录上的符号链接', async () => {
  if (process.platform === 'win32') return // 普通 Windows 账号可能无创建链接权限；Windows 专项验收另做。
  for (const kind of ['database', 'wal', 'parent']) {
    const f = await fixture()
    try {
      const db = chromeCookies(f.input)
      addCookie(db)
      db.close()
      const source = join(f.input.profileDir, 'Cookies')
      if (kind === 'database') {
        await rename(source, `${source}.real`)
        await symlink(`${source}.real`, source)
      } else if (kind === 'wal') {
        const target = join(f.input.root, 'elsewhere')
        await writeFile(target, 'fixture')
        await symlink(target, `${source}-wal`)
      } else {
        await rename(f.input.profileDir, `${f.input.profileDir}.real`)
        await symlink(`${f.input.profileDir}.real`, f.input.profileDir)
      }
      const result = await readerForPlatform('darwin', secrets).read(f.input)
      assert.equal(result.cookies?.status, 'failed')
      assert.deepEqual(result.cookies?.items, [])
    } finally {
      await f.dispose()
    }
  }
})

test('缺文件是 missing；非普通文件和来源/家族不一致是 failed', async () => {
  const f = await fixture()
  try {
    const reader = readerForPlatform('darwin', secrets)
    const missing = await reader.read(f.input)
    assert.equal(missing.cookies?.status, 'missing')
    assert.equal(missing.passwords?.status, 'missing')
    assert.deepEqual(await reader.read({ ...f.input, kinds: [] }), {})
    await mkdir(join(f.input.profileDir, 'Cookies'))
    assert.equal((await reader.read(f.input)).cookies?.status, 'failed')
    assert.equal((await reader.read({ ...f.input, family: 'firefox' })).cookies?.status, 'failed')
  } finally {
    await f.dispose()
  }
})

test('复制过程中修改来源，不能把撕裂的快照当作成功', async () => {
  const f = await fixture()
  let snapshot: Snapshot | undefined
  try {
    const source = join(f.input.profileDir, 'large sample')
    await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 7))
    snapshot = await Snapshot.create(f.input.signal)
    const copying = snapshot.file(source, f.input.signal)
    const rejected = assert.rejects(
      copying,
      (error) => error instanceof ReadFault && error.status === 'locked',
    )
    // 等第一块副本出现再改变来源；避免凭固定 sleep 猜竞态。
    for (let i = 0; i < 10_000; i++) {
      const files = await readdir(snapshot.directory)
      if (files.length) break
      if (i === 9999) assert.fail('复制未启动')
    }
    await writeFile(source, Buffer.from('changed'))
    await rejected
  } finally {
    await snapshot?.dispose()
    await f.dispose()
  }
})

test('复制中取消可以清理全部半成品', async () => {
  const f = await fixture()
  let snapshot: Snapshot | undefined
  try {
    const source = join(f.input.profileDir, 'large sample')
    await writeFile(source, Buffer.alloc(16 * 1024 * 1024))
    const controller = new AbortController()
    snapshot = await Snapshot.create(controller.signal)
    const copying = snapshot.file(source, controller.signal)
    controller.abort()
    await assert.rejects(
      copying,
      (error) => error instanceof ReadFault && error.status === 'cancelled',
    )
    const dir = snapshot.directory
    await snapshot.dispose()
    snapshot = undefined
    await assert.rejects(lstat(dir), { code: 'ENOENT' })
  } finally {
    await snapshot?.dispose()
    await f.dispose()
  }
})
