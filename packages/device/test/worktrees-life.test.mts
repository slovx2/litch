// 工作树跟着会话走（worktree-life.mts）对着真的 git 仓库：归档时干净的删、有改动的留着、有人共用就转给它，
// 重新打开时建回来，删会话不留快照，留着到期存快照再删，超过保留个数按先后回收、该留的不动；
// 以及合入基础分支（worktrees.mts 的 syncBase）：没新提交、合进来、冲突、有改动时拒绝。
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { WorktreeLife } from '../src/worktree-life.mjs'
import type { WorktreeSettings } from '../src/worktrees.mjs'
import { tempDir } from './helpers.mjs'
import { commitAll, makeRepo, sh, worktreeWorld, write } from './worktree-kit.mjs'

function world(settings: Partial<WorktreeSettings> = {}) {
  const dir = realpathSync(tempDir())
  const repo = makeRepo(dir)
  const env = worktreeWorld(join(dir, 'state'), settings)
  /** 索引里的会话：updatedAt（秒）、归没归档 */
  const sessions = new Map<string, { updatedAt: number; archived: boolean }>()
  const pinned = new Set<string>()
  const running = new Set<string>()
  const roots: string[] = []
  const life = new WorktreeLife(env.worktrees, {
    known: (threadId) => sessions.get(threadId) ?? null,
    pinned: (threadId) => pinned.has(threadId),
    running: (threadId) => running.has(threadId),
    roots: () => roots,
    log: () => {},
  })
  /** 给会话 threadId 建一个工作树、记成主人 */
  const owned = async (threadId: string, title = threadId) => {
    const made = await env.worktrees.create({ cwd: repo, title })
    env.worktrees.own(made.id, threadId)
    sessions.set(threadId, { updatedAt: Math.floor(Date.now() / 1000), archived: false })
    return made
  }
  const state = (id: string) => env.worktrees.get(id)?.state
  return {
    ...env,
    repo,
    life,
    sessions,
    pinned,
    running,
    roots,
    owned,
    state,
    done() {
      env.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 把时钟往后拨 seconds 秒做一件事 */
async function later<T>(seconds: number, work: () => Promise<T>): Promise<T> {
  const real = Date.now
  Date.now = () => real() + seconds * 1000
  try {
    return await work()
  } finally {
    Date.now = real
  }
}

test('WTL-001：归档时干净的删目录、分支留着；重新打开建回来；有改动的原样留着，取消归档接着用', async () => {
  const w = world()
  try {
    const clean = await w.owned('t1')
    await w.life.archived('t1')
    assert.equal(w.state(clean.id), 'removed')
    assert.equal(existsSync(clean.path), false)
    assert.equal(w.worktrees.get(clean.id)?.snapshotRef, null, '干净的不留快照')
    assert.ok(sh(w.repo, 'branch', '--list', clean.branch), '分支留着')
    assert.equal(w.life.waiting('t1'), true)
    await w.life.reopen('t1')
    assert.equal(w.state(clean.id), 'ready')
    assert.equal(existsSync(clean.path), true)
    const dirty = await w.owned('t2')
    write(dirty.path, 'src/app.txt', 'changed\n')
    await w.life.archived('t2')
    assert.equal(w.state(dirty.id), 'kept')
    assert.equal(readFileSync(join(dirty.path, 'src/app.txt'), 'utf8'), 'changed\n')
    await w.life.reopen('t2')
    assert.equal(w.state(dirty.id), 'ready')
  } finally {
    w.done()
  }
})

test('WTL-002：主人归档时有没归档的共用者就转给它；删会话直接删目录不留快照；共用者删了不再记', async () => {
  const w = world()
  try {
    const made = await w.owned('owner')
    w.worktrees.share(made.id, 'child')
    w.sessions.set('child', { updatedAt: 1, archived: false })
    await w.life.archived('owner')
    assert.equal(w.worktrees.get(made.id)?.ownerThreadId, 'child')
    assert.equal(w.state(made.id), 'ready')
    assert.deepEqual(w.worktrees.sharers(made.id), [])
    write(made.path, 'notes.txt', 'draft\n')
    await w.life.deleted('child')
    assert.equal(w.state(made.id), 'removed')
    assert.equal(w.worktrees.get(made.id)?.snapshotRef, null, '删会话不留快照')
    assert.equal(existsSync(made.path), false)
  } finally {
    w.done()
  }
})

test('WTL-003：留着的到了天数存快照再删，能恢复回原样', async () => {
  const w = world({ keptDays: 7 })
  try {
    const made = await w.owned('t1')
    write(made.path, 'src/app.txt', 'kept change\n')
    await w.life.archived('t1')
    assert.equal(w.state(made.id), 'kept')
    await w.life.sweep()
    assert.equal(w.state(made.id), 'kept', '没到期不动')
    await later(8 * 86400, () => w.life.sweep())
    const gone = w.worktrees.get(made.id)
    assert.equal(gone?.state, 'removed')
    assert.ok(gone?.snapshotRef)
    await w.life.reopen('t1')
    assert.equal(readFileSync(join(made.path, 'src/app.txt'), 'utf8'), 'kept change\n')
  } finally {
    w.done()
  }
})

test('WTL-004：超过保留个数先回收主人归档了的，再按最后活动从旧到新；置顶、在跑、刚建、当了工作区根的不动', async () => {
  const w = world({ keepCount: 2 })
  try {
    // 都在两小时前建的，不算刚建
    const [a, b, c, d, e] = await later(-7200, async () => [
      await w.owned('a'),
      await w.owned('b'),
      await w.owned('c'),
      await w.owned('d'),
      await w.owned('e'),
    ])
    assert.ok(a && b && c && d && e)
    w.sessions.set('a', { updatedAt: 500, archived: false })
    w.sessions.set('b', { updatedAt: 100, archived: false })
    w.sessions.set('c', { updatedAt: 900, archived: true })
    w.sessions.set('d', { updatedAt: 50, archived: false })
    w.sessions.set('e', { updatedAt: 10, archived: false })
    w.pinned.add('d')
    w.roots.push(e.path)
    // 刚建的：不动
    const fresh = await w.owned('f')
    w.sessions.set('f', { updatedAt: 1, archived: false })
    await w.life.sweep()
    // 六个活着的、留两个：c（归档了）先收，再 b（100）、a（500）；d 置顶、e 是工作区根、f 刚建，收不到两个也只能这样
    assert.equal(w.state(c.id), 'removed')
    assert.equal(w.state(b.id), 'removed')
    assert.equal(w.state(a.id), 'removed')
    assert.equal(w.state(d.id), 'ready')
    assert.equal(w.state(e.id), 'ready')
    assert.equal(w.state(fresh.id), 'ready')
    // 关掉自动清理不收
    const off = world({ keepCount: 1, autoCleanup: false })
    try {
      const [x, y] = await later(-7200, async () => [await off.owned('x'), await off.owned('y')])
      await off.life.sweep()
      assert.equal(off.state(x?.id ?? ''), 'ready')
      assert.equal(off.state(y?.id ?? ''), 'ready')
    } finally {
      off.done()
    }
  } finally {
    w.done()
  }
})

test('WTL-005：合入基础分支：没新提交、合进来、有改动拒绝、冲突时停在冲突状态', async () => {
  const w = world()
  try {
    const made = await w.owned('t1')
    assert.deepEqual(await w.worktrees.syncBase(made.id), { status: 'upToDate', files: [] })
    write(w.repo, 'README.md', 'hello from main\n')
    commitAll(w.repo, 'main moves')
    assert.deepEqual(await w.worktrees.syncBase(made.id), { status: 'merged', files: [] })
    assert.equal(readFileSync(join(made.path, 'README.md'), 'utf8'), 'hello from main\n')
    write(made.path, 'src/app.txt', 'mine\n')
    await assert.rejects(w.worktrees.syncBase(made.id), /未提交的改动/)
    commitAll(made.path, 'mine')
    write(w.repo, 'src/app.txt', 'theirs\n')
    commitAll(w.repo, 'theirs')
    assert.deepEqual(await w.worktrees.syncBase(made.id), {
      status: 'conflicts',
      files: ['src/app.txt'],
    })
    await assert.rejects(w.worktrees.syncBase(made.id), /做到一半|未提交/)
    // 从 HEAD 切的没有基础分支
    const head = await w.worktrees.create({ cwd: w.repo, title: 'head', from: { kind: 'head' } })
    await assert.rejects(w.worktrees.syncBase(head.id), /不是从分支切的/)
  } finally {
    w.done()
  }
})
