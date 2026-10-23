// 设备层的工作树（worktrees.mts）对着真的 git 仓库：四种起点、名字与位置、子目录、复制哪些被忽略的文件、
// 出错时不留半个工作树、删目录前的快照与恢复、连分支一起删。设备进程怎么用它见 worktrees-device.test.mts。
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import test from 'node:test'
import { tempDir } from './helpers.mjs'
import { commitAll, makeRepo, sh, worktreeWorld, write } from './worktree-kit.mjs'

function world(settings = {}) {
  const dir = realpathSync(tempDir())
  const repo = makeRepo(dir)
  const env = worktreeWorld(join(dir, 'state'), settings)
  return {
    ...env,
    dir,
    repo,
    done() {
      env.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 期待失败，返回那个错误 */
async function failure(work: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await work
  } catch (error) {
    return error as { code: number; message: string }
  }
  return assert.fail('应该失败，却成功了')
}

test('WT-001：默认从 main 切，目录在根下按仓库名分、分支带前缀和标题短名；会话目录保持子路径', async () => {
  const env = world()
  try {
    const made = await env.worktrees.create({
      cwd: join(env.repo, 'src'),
      title: 'Fix the Login bug!',
    })
    assert.equal(made.state, 'ready')
    assert.equal(made.ownerThreadId, null)
    assert.equal(made.sourceRoot, env.repo)
    assert.equal(made.subPath, 'src')
    assert.equal(made.baseRef, 'main')
    assert.equal(made.baseCommit, sh(env.repo, 'rev-parse', 'main'))
    assert.match(made.id, /^fix-the-login-bug-[0-9a-f]{6}$/)
    assert.equal(made.path, join(env.settings.root, basename(env.repo), made.id))
    assert.equal(made.branch, `litch/${made.id}`)
    assert.equal(readFileSync(join(made.path, 'src/app.txt'), 'utf8'), 'v1\n')
    assert.equal(sh(made.path, 'symbolic-ref', '--short', 'HEAD'), made.branch)
    // 不跟踪远端分支
    assert.equal(sh(env.repo, 'config', '--list').includes(`branch.${made.branch}.`), false)
    // 记录与通知
    assert.deepEqual(env.worktrees.list(), [made])
    assert.deepEqual(
      env.changed.map((one) => one.state),
      ['ready'],
    )
    // 工作树自己的 git 目录里留了一份标识
    const gitDir = sh(made.path, 'rev-parse', '--path-format=absolute', '--git-dir')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(JSON.parse(readFileSync(join(gitDir, 'litch-worktree.json'), 'utf8')).id, made.id)
    // 标题转不出短名（全中文）时只用随机串
    const plain = await env.worktrees.create({ cwd: env.repo, title: '修登录' })
    assert.match(plain.id, /^[0-9a-f]{6}$/)
    assert.equal(plain.subPath, '')
  } finally {
    env.done()
  }
})

test('WT-002：默认分支在本地落后于 origin 时从 origin 的切；开了先拉取就先 fetch', async () => {
  const env = world()
  try {
    const origin = join(env.dir, 'origin.git')
    sh(env.dir, 'clone', '-q', '--bare', env.repo, origin)
    sh(env.repo, 'remote', 'add', 'origin', origin)
    sh(env.repo, 'fetch', '-q', 'origin')
    // 别人往 origin 推了一个提交
    const other = join(env.dir, 'other')
    sh(env.dir, 'clone', '-q', origin, other)
    write(other, 'src/app.txt', 'v2\n')
    const newer = commitAll(other, 'v2')
    sh(other, 'push', '-q', 'origin', 'main')
    // 没开先拉取：本地的 origin/main 还是旧的，用本地 main
    const stale = await env.worktrees.create({ cwd: env.repo })
    assert.equal(stale.baseRef, 'main')
    // 开了先拉取：拉到新的，本地 main 是它的祖先，用 origin/main
    env.settings.fetchFirst = true
    const fresh = await env.worktrees.create({ cwd: env.repo })
    assert.equal(fresh.baseRef, 'origin/main')
    assert.equal(fresh.baseCommit, newer)
    assert.equal(readFileSync(join(fresh.path, 'src/app.txt'), 'utf8'), 'v2\n')
    // 本地 main 有自己的新提交（不是 origin 的祖先）：用本地的
    env.settings.fetchFirst = false
    write(env.repo, 'local.txt', 'mine\n')
    const mine = commitAll(env.repo, 'local')
    const local = await env.worktrees.create({ cwd: env.repo })
    assert.equal(local.baseRef, 'main')
    assert.equal(local.baseCommit, mine)
  } finally {
    env.done()
  }
})

test('WT-003：从分支、从 HEAD、从当前本地状态（未提交的改动、新文件都带上）', async () => {
  const env = world()
  try {
    sh(env.repo, 'checkout', '-q', '-b', 'feature')
    write(env.repo, 'src/app.txt', 'feature\n')
    const feature = commitAll(env.repo, 'feature')
    sh(env.repo, 'checkout', '-q', 'main')
    const fromBranch = await env.worktrees.create({
      cwd: env.repo,
      from: { kind: 'branch', branch: 'feature' },
    })
    assert.equal(fromBranch.baseRef, 'feature')
    assert.equal(fromBranch.baseCommit, feature)
    sh(env.repo, 'checkout', '-q', 'feature')
    const fromHead = await env.worktrees.create({ cwd: env.repo, from: { kind: 'head' } })
    assert.equal(fromHead.baseRef, 'HEAD')
    assert.equal(fromHead.baseCommit, feature)
    // 改了一个跟踪的文件、删了一个、暂存了一个新文件、还有一个没跟踪的
    write(env.repo, 'src/app.txt', 'dirty\n')
    rmSync(join(env.repo, 'README.md'))
    write(env.repo, 'staged.txt', 'staged\n')
    sh(env.repo, 'add', 'staged.txt')
    write(env.repo, 'notes/untracked.txt', 'untracked\n')
    const carried = await env.worktrees.create({ cwd: env.repo, from: { kind: 'working-tree' } })
    assert.equal(carried.baseRef, 'working-tree')
    assert.equal(carried.baseCommit, feature)
    assert.equal(readFileSync(join(carried.path, 'src/app.txt'), 'utf8'), 'dirty\n')
    assert.equal(existsSync(join(carried.path, 'README.md')), false)
    assert.equal(readFileSync(join(carried.path, 'staged.txt'), 'utf8'), 'staged\n')
    assert.equal(readFileSync(join(carried.path, 'notes/untracked.txt'), 'utf8'), 'untracked\n')
    // 源检出原样不动
    assert.equal(readFileSync(join(env.repo, 'src/app.txt'), 'utf8'), 'dirty\n')
  } finally {
    env.done()
  }
})

test('WT-004：被忽略的文件只复制 .worktreeinclude 列的和各 harness 的本地配置', async () => {
  const env = world()
  try {
    write(
      env.repo,
      '.gitignore',
      '.env\nnode_modules/\n.claude/settings.local.json\n.mcp.json\nsecret.txt\n',
    )
    write(env.repo, '.worktreeinclude', '.env\nsecret.txt\nnot-ignored.txt\n')
    commitAll(env.repo, 'ignore rules')
    write(env.repo, '.env', 'TOKEN=x\n')
    write(env.repo, 'secret.txt', 'secret\n')
    write(env.repo, 'node_modules/lib/index.js', 'x\n')
    write(env.repo, '.claude/settings.local.json', '{}\n')
    write(env.repo, '.mcp.json', '{}\n')
    // 列在 .worktreeinclude 里但没被忽略的未跟踪文件：不归这里管（从 main 切时不带）
    write(env.repo, 'not-ignored.txt', 'x\n')
    const made = await env.worktrees.create({ cwd: env.repo })
    assert.equal(readFileSync(join(made.path, '.env'), 'utf8'), 'TOKEN=x\n')
    assert.equal(existsSync(join(made.path, 'secret.txt')), true)
    assert.equal(existsSync(join(made.path, '.claude/settings.local.json')), true)
    assert.equal(existsSync(join(made.path, '.mcp.json')), true)
    assert.equal(existsSync(join(made.path, 'node_modules')), false)
    assert.equal(existsSync(join(made.path, 'not-ignored.txt')), false)
  } finally {
    env.done()
  }
})

test('WT-005：不在仓库里、分支不存在回 -32602；git 半路失败时不留目录、分支和记录', async () => {
  const env = world()
  try {
    const outside = join(env.dir, 'plain')
    write(outside, 'a.txt', 'x\n')
    assert.equal((await failure(env.worktrees.create({ cwd: outside }))).code, -32602)
    const missing = await failure(
      env.worktrees.create({ cwd: env.repo, from: { kind: 'branch', branch: 'nope' } }),
    )
    assert.equal(missing.code, -32602)
    // 前缀不合 git 的分支名规矩：worktree add 失败
    env.settings.branchPrefix = 'bad..'
    const broken = await failure(env.worktrees.create({ cwd: env.repo, title: 'x' }))
    assert.equal(broken.code, -32603)
    assert.deepEqual(env.worktrees.list(), [])
    assert.deepEqual(
      sh(env.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'),
      'main',
    )
    assert.equal(sh(env.repo, 'worktree', 'list', '--porcelain').split('\n\n').length, 1)
  } finally {
    env.done()
  }
})

test('WT-006：有改动时先做快照再删目录、分支留着；恢复后改动回到未提交的样子；连分支删时记录也删', async () => {
  const env = world()
  try {
    const made = await env.worktrees.create({ cwd: env.repo })
    env.worktrees.own(made.id, 'thread-1')
    assert.equal(env.worktrees.forThread('thread-1')?.id, made.id)
    // 一处提交、一处未提交的改动、一个删掉的文件、一个新文件，暂存区里也有东西
    write(made.path, 'committed.txt', 'c\n')
    const tip = commitAll(made.path, 'work')
    write(made.path, 'src/app.txt', 'edited\n')
    rmSync(join(made.path, 'README.md'))
    write(made.path, 'new/file.txt', 'new\n')
    sh(made.path, 'add', 'new/file.txt')
    const removed = await env.worktrees.remove(made.id)
    assert.equal(removed.state, 'removed')
    assert.match(removed.snapshotRef ?? '', new RegExp(`^refs/litch/snapshots/${made.id}-\\d+$`))
    assert.equal(existsSync(made.path), false)
    assert.equal(sh(env.repo, 'rev-parse', made.branch), tip)
    assert.equal(sh(env.repo, 'rev-parse', `${removed.snapshotRef}^`), tip)
    const restored = await env.worktrees.restore(made.id)
    assert.equal(restored.state, 'ready')
    assert.equal(restored.snapshotRef, null)
    assert.equal(readFileSync(join(made.path, 'src/app.txt'), 'utf8'), 'edited\n')
    assert.equal(existsSync(join(made.path, 'README.md')), false)
    assert.equal(readFileSync(join(made.path, 'new/file.txt'), 'utf8'), 'new\n')
    assert.equal(sh(made.path, 'rev-parse', 'HEAD'), tip)
    // 改动回到未提交、未暂存
    assert.equal(sh(made.path, 'diff', '--cached', '--name-only'), '')
    assert.equal(
      sh(made.path, 'status', '--porcelain=v1', '--untracked-files=all'),
      // sh 去掉了头尾空白
      [' D README.md', ' M src/app.txt', '?? new/file.txt'].join('\n').trim(),
    )
    assert.equal(sh(env.repo, 'for-each-ref', 'refs/litch/snapshots/'), '')
    // 干净的直接删、不做快照；分支删了、有快照的从快照建回分支
    const clean = await env.worktrees.create({ cwd: env.repo })
    assert.equal((await env.worktrees.remove(clean.id)).snapshotRef, null)
    // 连分支一起删：目录、分支、快照、记录都没了
    const gone = await env.worktrees.remove(made.id, { withBranch: true })
    assert.equal(gone.state, 'removed')
    assert.equal(existsSync(made.path), false)
    assert.equal(sh(env.repo, 'branch', '--list', made.branch), '')
    assert.equal(sh(env.repo, 'for-each-ref', 'refs/litch/snapshots/'), '')
    assert.equal(env.worktrees.get(made.id), null)
    assert.equal((await failure(env.worktrees.restore(made.id))).code, -32602)
  } finally {
    env.done()
  }
})

test('WT-007：丢弃改动删目录不做快照；分支被删掉后只有快照的照样能恢复', async () => {
  const env = world()
  try {
    const dropped = await env.worktrees.create({ cwd: env.repo })
    write(dropped.path, 'scratch.txt', 'x\n')
    assert.equal((await env.worktrees.remove(dropped.id, { discard: true })).snapshotRef, null)
    const kept = await env.worktrees.create({ cwd: env.repo })
    write(kept.path, 'draft.txt', 'draft\n')
    await env.worktrees.remove(kept.id)
    sh(env.repo, 'branch', '-D', kept.branch)
    const back = await env.worktrees.restore(kept.id)
    assert.equal(back.state, 'ready')
    assert.equal(readFileSync(join(kept.path, 'draft.txt'), 'utf8'), 'draft\n')
    assert.equal(sh(kept.path, 'symbolic-ref', '--short', 'HEAD'), kept.branch)
    // 原路径上已经有东西时恢复不了
    await env.worktrees.remove(kept.id, { discard: true })
    write(kept.path, 'blocker.txt', 'x\n')
    assert.equal((await failure(env.worktrees.restore(kept.id))).code, -32602)
  } finally {
    env.done()
  }
})

test('WT-008：列分支：当前分支、默认分支、本地与 origin 上的', async () => {
  const env = world()
  try {
    const origin = join(env.dir, 'origin.git')
    sh(env.dir, 'clone', '-q', '--bare', env.repo, origin)
    sh(env.repo, 'remote', 'add', 'origin', origin)
    sh(env.repo, 'branch', 'dev')
    sh(env.repo, 'push', '-q', 'origin', 'dev')
    sh(env.repo, 'fetch', '-q', 'origin')
    sh(env.repo, 'remote', 'set-head', 'origin', 'main')
    const branches = await env.worktrees.branches(join(env.repo, 'src'))
    assert.deepEqual(branches, {
      current: 'main',
      defaultBranch: 'main',
      local: ['dev', 'main'],
      remote: ['origin/dev', 'origin/main'],
    })
  } finally {
    env.done()
  }
})
