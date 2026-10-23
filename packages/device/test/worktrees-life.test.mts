// 工作树跟着会话走（worktree-life.mts）对着真的 git 仓库：归档时干净的删、有改动的留着、有人共用就转给它，
// 重新打开时建回来，删会话不留快照，留着到期存快照再删，超过保留个数按先后回收、该留的不动；
// 以及合入基础分支（worktrees.mts 的 syncBase）：没新提交、合进来、冲突、有改动时拒绝。
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, win32 } from 'node:path'
import test from 'node:test'
import { WorktreeLife } from '../src/worktree-life.mjs'
import { inside, type WorktreeSettings } from '../src/worktrees.mjs'
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

test('WTL-004：超过保留个数只回收主人归档了的，按主人最后活动从旧到新；没归档的、置顶、在跑、刚建、当了工作区根的不动', async () => {
  const w = world({ keepCount: 1 })
  try {
    // 都在两小时前建的，不算刚建
    const [a, b, c, d, e, g] = await later(-7200, async () => [
      await w.owned('a'),
      await w.owned('b'),
      await w.owned('c'),
      await w.owned('d'),
      await w.owned('e'),
      await w.owned('g'),
    ])
    assert.ok(a && b && c && d && e && g)
    w.sessions.set('a', { updatedAt: 500, archived: true })
    w.sessions.set('b', { updatedAt: 100, archived: false })
    w.sessions.set('c', { updatedAt: 900, archived: true })
    w.sessions.set('d', { updatedAt: 50, archived: true })
    w.sessions.set('e', { updatedAt: 10, archived: true })
    w.sessions.set('g', { updatedAt: 20, archived: true })
    w.pinned.add('d')
    w.roots.push(join(e.path, 'src'))
    // 共用着 g 的会话还没归档：不回收
    w.worktrees.share(g.id, 'g-child')
    w.sessions.set('g-child', { updatedAt: 30, archived: false })
    // 刚建的：不动
    const fresh = await w.owned('f')
    w.sessions.set('f', { updatedAt: 1, archived: true })
    await w.life.sweep()
    // 七个活着的、留一个：能收的只有 a、c（d 置顶、e 下面有工作区根、g 有人共用、f 刚建、b 没归档）
    assert.equal(w.state(a.id), 'removed')
    assert.equal(w.state(c.id), 'removed')
    for (const kept of [b, d, e, g, fresh]) assert.equal(w.state(kept.id), 'ready')
    // 关掉自动清理不收
    const off = world({ keepCount: 1, autoCleanup: false })
    try {
      const [x, y] = await later(-7200, async () => [await off.owned('x'), await off.owned('y')])
      off.sessions.set('x', { updatedAt: 1, archived: true })
      off.sessions.set('y', { updatedAt: 2, archived: true })
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

test('WTL-006：主人删了时有共用者就转给它：没归档的接着用；归档了的照归档处理（干净删目录、有改动留着）', async () => {
  const w = world()
  try {
    const live = await w.owned('owner')
    w.worktrees.share(live.id, 'child')
    w.sessions.set('child', { updatedAt: 1, archived: false })
    await w.life.deleted('owner')
    assert.equal(w.worktrees.get(live.id)?.ownerThreadId, 'child')
    assert.equal(w.state(live.id), 'ready')
    assert.equal(existsSync(live.path), true)
    // 共用者已经归档了：转过去后照归档处理
    const clean = await w.owned('o2')
    w.worktrees.share(clean.id, 'c2')
    w.sessions.set('c2', { updatedAt: 1, archived: true })
    await w.life.deleted('o2')
    assert.equal(w.worktrees.get(clean.id)?.ownerThreadId, 'c2')
    assert.equal(w.state(clean.id), 'removed')
    await w.life.reopen('c2')
    assert.equal(w.state(clean.id), 'ready')
    const dirty = await w.owned('o3')
    w.worktrees.share(dirty.id, 'c3')
    w.sessions.set('c3', { updatedAt: 1, archived: true })
    write(dirty.path, 'src/app.txt', 'child work\n')
    await w.life.deleted('o3')
    assert.equal(w.state(dirty.id), 'kept')
    assert.equal(readFileSync(join(dirty.path, 'src/app.txt'), 'utf8'), 'child work\n')
    // 共用者被删了（索引里没有了）的不算：直接删
    const gone = await w.owned('o4')
    w.worktrees.share(gone.id, 'ghost')
    await w.life.deleted('o4')
    assert.equal(w.state(gone.id), 'removed')
  } finally {
    w.done()
  }
})

test('WTL-007：共用者重新打开主人归档后删掉的工作树：建回来、主人换成它', async () => {
  const w = world()
  try {
    const made = await w.owned('owner')
    w.worktrees.share(made.id, 'child')
    w.sessions.set('child', { updatedAt: 1, archived: true })
    w.sessions.set('owner', { updatedAt: 1, archived: true })
    await w.life.archived('owner')
    assert.equal(w.state(made.id), 'removed')
    assert.equal(w.life.waiting('child'), true)
    await w.life.reopen('child')
    assert.equal(w.state(made.id), 'ready')
    assert.equal(w.worktrees.get(made.id)?.ownerThreadId, 'child')
  } finally {
    w.done()
  }
})

test('WTL-008：删到一半失败：快照已落库、状态不变；再删不重做快照；恢复时先删完再从快照建回', async () => {
  const w = world()
  const parent = (path: string) => join(path, '..')
  try {
    const made = await w.owned('t1')
    write(made.path, 'src/app.txt', 'precious\n')
    // 工作树所在目录只读：里面的东西删得掉，工作树目录本身删不掉
    chmodSync(parent(made.path), 0o555)
    await assert.rejects(w.worktrees.remove(made.id), /删不掉/)
    const half = w.worktrees.get(made.id)
    assert.equal(half?.state, 'ready')
    assert.match(half?.snapshotRef ?? '', /^refs\/litch\/snapshots\//)
    assert.equal(w.life.waiting('t1'), true)
    // 再删一次（目录已经空了）：不重做快照、引用不变
    await assert.rejects(w.worktrees.remove(made.id), /删不掉/)
    assert.equal(w.worktrees.get(made.id)?.snapshotRef, half?.snapshotRef)
    chmodSync(parent(made.path), 0o755)
    await w.life.reopen('t1')
    assert.equal(w.state(made.id), 'ready')
    assert.equal(readFileSync(join(made.path, 'src/app.txt'), 'utf8'), 'precious\n')
    assert.equal(sh(w.repo, 'for-each-ref', 'refs/litch/snapshots/'), '')
  } finally {
    w.done()
  }
})

/** 在工作树的分支上另外提交一个（工作树目录已经删了时用临时检出） */
function commitOnBranch(repo: string, branch: string, file: string, content: string): string {
  const scratch = join(repo, '..', `scratch-${Date.now()}`)
  sh(repo, 'worktree', 'add', scratch, branch)
  write(scratch, file, content)
  const tip = commitAll(scratch, `moves ${file}`)
  sh(repo, 'worktree', 'remove', '--force', scratch)
  return tip
}

test('WTL-009：恢复时分支在快照之后有了新提交：三方应用、不撤掉新提交；有冲突的留着冲突和快照引用', async () => {
  const w = world()
  try {
    const made = await w.owned('t1')
    write(made.path, 'notes.txt', 'draft\n')
    await w.worktrees.remove(made.id)
    const tip = commitOnBranch(w.repo, made.branch, 'README.md', 'moved on\n')
    await w.worktrees.restore(made.id)
    assert.equal(sh(made.path, 'rev-parse', 'HEAD'), tip, '新提交还在')
    assert.equal(readFileSync(join(made.path, 'README.md'), 'utf8'), 'moved on\n')
    assert.equal(readFileSync(join(made.path, 'notes.txt'), 'utf8'), 'draft\n')
    assert.equal(sh(made.path, 'diff', '--cached', '--name-only'), '', '没留在暂存区')
    assert.equal(sh(w.repo, 'for-each-ref', 'refs/litch/snapshots/'), '')
    // 冲突：快照和新提交改了同一行
    write(made.path, 'src/app.txt', 'mine\n')
    await w.worktrees.remove(made.id)
    const ref = w.worktrees.get(made.id)?.snapshotRef
    assert.ok(ref)
    commitOnBranch(w.repo, made.branch, 'src/app.txt', 'theirs\n')
    const restored = await w.worktrees.restore(made.id)
    assert.equal(restored.state, 'ready')
    assert.match(
      readFileSync(join(made.path, 'src/app.txt'), 'utf8'),
      /<<<<<<<[\s\S]*theirs[\s\S]*mine/,
    )
    assert.ok(sh(w.repo, 'for-each-ref', ref), '快照引用留着')
  } finally {
    w.done()
  }
})

test('WTL-010：清理算完候选后、真删之前在跑了的不删；归档时在队里重判；revive 也排队', async () => {
  const w = world({ keepCount: 0 })
  try {
    const made = await later(-7200, () => w.owned('b'))
    w.sessions.set('b', { updatedAt: 1, archived: true })
    // 队里先排一件事，清理的删除排在它后面；候选算完之后会话开始跑了
    const blocker = w.worktrees.create({ cwd: w.repo, title: 'blocker' })
    const sweeping = w.life.sweep()
    w.running.add('b')
    await Promise.all([blocker, sweeping])
    assert.equal(w.state(made.id), 'ready')
    assert.equal(await w.worktrees.removeIf(made.id, () => false), null)
    // 归档：转出前主人已经不是它了
    const other = await w.owned('o')
    const archiving = w.life.archived('o')
    w.worktrees.transfer(other.id, 'someone-else')
    await archiving
    assert.equal(w.state(other.id), 'ready')
  } finally {
    w.done()
  }
})

test('WTL-011：设备进程起来时对账：建到一半的、没主人没人用的干净工作树删掉，有改动的留着', async () => {
  const w = world()
  try {
    const orphan = await w.worktrees.create({ cwd: w.repo, title: 'orphan' })
    const dirtyOrphan = await w.worktrees.create({ cwd: w.repo, title: 'dirty' })
    write(dirtyOrphan.path, 'notes.txt', 'keep me\n')
    const owned = await w.owned('t1')
    await w.worktrees.reconcile()
    assert.equal(w.worktrees.get(orphan.id), null)
    assert.equal(existsSync(orphan.path), false)
    assert.equal(sh(w.repo, 'branch', '--list', orphan.branch), '')
    assert.equal(w.state(dirtyOrphan.id), 'ready')
    assert.equal(w.state(owned.id), 'ready')
  } finally {
    w.done()
  }
})

test('WTL-012：路径包含按系统的路径规则算（Windows 的反斜杠、盘符大小写）', () => {
  assert.equal(inside('/wt/app-1', '/wt/app-1'), true)
  assert.equal(inside('/wt/app-1', '/wt/app-1/src'), true)
  assert.equal(inside('/wt/app-1', '/wt/app-10'), false)
  assert.equal(inside('/wt/app-1', '/wt/app-1/..x'), true)
  assert.equal(inside('/wt/app-1', '/wt'), false)
  assert.equal(inside('C:\\wt\\app-1', 'C:\\wt\\app-1\\src', win32), true)
  assert.equal(inside('C:\\wt\\app-1', 'c:\\WT\\app-1\\src', win32), true)
  assert.equal(inside('C:\\wt\\app-1', 'C:\\wt\\app-10', win32), false)
  assert.equal(inside('C:\\wt\\app-1', 'D:\\wt\\app-1', win32), false)
})
