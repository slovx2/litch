// 差异模块（packages/core/src/device/diffs.mts）对着真的 git：概况、单个文件的差异、一次取全部、
// 暂存、取消暂存、还原，以及看不了 git 时的几种交代。仓库都是临时目录里现建的（git-world.mts）。
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type ChannelError, type DiffEntry, type DiffView, privateTwin } from '../src/index.mjs'
import { gitWorld, mixedRepo } from './git-world.mjs'

const brief = (view: DiffView) =>
  view.entries.map((entry) => [entry.path, entry.status, entry.added, entry.removed])

const byPath = (view: DiffView): Record<string, DiffEntry> =>
  Object.fromEntries(view.entries.map((entry) => [entry.path, entry]))

const rejects = async (work: Promise<unknown>, code: string): Promise<ChannelError> => {
  const error = await work.then(
    () => null,
    (caught: ChannelError) => caught,
  )
  assert.equal(
    error?.code,
    code,
    `应该以 ${code} 结束，实际是 ${String(error?.code)}：${error?.message}`,
  )
  return error as ChannelError
}

test('全部没提交的：每种改动各是什么状态、增删多少行、暂存了没有', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  const view = await world.watch('all').settled()
  assert.equal(view.phase, 'ready')
  assert.equal(view.source, 'git')
  assert.equal(view.branch, 'main')
  assert.equal(view.writable, true)
  assert.equal(view.watching, true)
  assert.deepEqual(brief(view), [
    ['del.txt', 'deleted', 0, 2],
    ['empty-untracked.txt', 'untracked', 0, 0],
    ['mod.txt', 'modified', 3, 2],
    ['new-name.txt', 'renamed', 0, 0],
    ['pic.bin', 'modified', null, null],
    ['run.sh', 'modified', 0, 0],
    ['staged-new.txt', 'added', 1, 0],
    ['sub/in.txt', 'modified', 1, 0],
    ['untracked.bin', 'untracked', null, null],
    ['untracked.txt', 'untracked', 3, 0],
    ['中文 名.txt', 'modified', 1, 0],
  ])
  const entries = byPath(view)
  assert.equal(entries['new-name.txt']?.from, 'old-name.txt')
  assert.deepEqual(entries['run.sh']?.mode, { from: '100644', to: '100755' })
  assert.equal(entries['pic.bin']?.binary, true)
  assert.equal(entries['untracked.bin']?.binary, true)
  assert.equal(entries['empty-untracked.txt']?.binary, false)
  const flags = (path: string) => [entries[path]?.staged, entries[path]?.unstaged]
  assert.deepEqual(flags('del.txt'), [true, false])
  assert.deepEqual(flags('mod.txt'), [false, true])
  assert.deepEqual(flags('new-name.txt'), [true, false])
  assert.deepEqual(flags('staged-new.txt'), [true, false])
  assert.deepEqual(flags('untracked.txt'), [false, true])
  // 盯的是 git 的元数据目录和根这一层
  assert.deepEqual(
    world.sent('fs/watch').map((params) => params.path),
    [join(world.root, '.git'), world.root],
  )
})

test('Windows 上的仓库：根写成反斜杠、大小写不一样也认，git 报的 C:/… 照样对得上', async (t) => {
  const world = gitWorld({ platform: 'windows', drive: true })
  t.after(world.cleanup)
  world.put('a.txt', 'a\n')
  world.git('add', '.')
  world.git('commit', '-q', '-m', 'init')
  world.put('a.txt', 'a\nb\n')
  world.put('sub/new.txt', 'x\n')
  const at = world.remoteRoot.replaceAll('/', '\\').replace(/^C:/, 'c:')
  const view = await world.watch('all', 's1', at).settled()
  assert.equal(view.phase, 'ready')
  assert.equal(view.source, 'git')
  assert.deepEqual(brief(view), [
    ['a.txt', 'modified', 1, 0],
    ['sub/new.txt', 'untracked', 1, 0],
  ])
  // 起 git 的目录、盯的目录都是理过的 C:/… 写法
  assert.equal(world.sent('process/spawn')[0]?.cwd, world.remoteRoot)
  assert.deepEqual(
    world.sent('fs/watch').map((params) => params.path),
    [`${world.remoteRoot}/.git`, world.remoteRoot],
  )
})

test('已暂存的、没暂存的各是一个范围；没人看的范围不去取', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  const staged = await world.watch('staged').settled()
  assert.deepEqual(brief(staged), [
    ['del.txt', 'deleted', 0, 2],
    ['new-name.txt', 'renamed', 0, 0],
    ['staged-new.txt', 'added', 1, 0],
  ])
  // 只有人看着“已暂存”：没跟踪的文件不用数行数
  assert.equal(world.commands().filter((command) => command[0] === 'grep').length, 0)
  const unstaged = await world.watch('unstaged').settled()
  assert.deepEqual(brief(unstaged), [
    ['empty-untracked.txt', 'untracked', 0, 0],
    ['mod.txt', 'modified', 3, 2],
    ['pic.bin', 'modified', null, null],
    ['run.sh', 'modified', 0, 0],
    ['sub/in.txt', 'modified', 1, 0],
    ['untracked.bin', 'untracked', null, null],
    ['untracked.txt', 'untracked', 3, 0],
    ['中文 名.txt', 'modified', 1, 0],
  ])
})

test('一个文件的差异：改了的、没跟踪的、二进制的、改了名的、只变了权限的；展开上下文带上整个文件', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  await world.watch('all').settled()
  const file = (path: string, full = false) => world.diffs.file(world.root, 'all', 's1', path, full)

  const mod = await file('mod.txt')
  assert.equal(mod.kind, 'text')
  assert.equal(mod.full, false)
  assert.deepEqual([mod.added, mod.removed], [3, 2])
  assert.equal(mod.hunks.length, 2)
  assert.deepEqual(mod.hunks[0]?.lines, [' a', '-b', '+B', ' c', ' d', ' e'])

  const whole = await file('mod.txt', true)
  assert.equal(whole.full, true)
  assert.equal(whole.hunks.length, 1)
  assert.equal(whole.hunks[0]?.lines.length, 15)

  const fresh = await file('untracked.txt')
  assert.equal(fresh.kind, 'text')
  assert.deepEqual(fresh.hunks[0]?.lines, ['+new', '+file', '+no newline'])
  assert.equal(fresh.noEolNew, true)
  assert.equal(fresh.language, null)

  assert.equal((await file('pic.bin')).kind, 'binary')
  assert.equal((await file('untracked.bin')).kind, 'binary')
  assert.equal((await file('empty-untracked.txt')).kind, 'empty')
  assert.equal((await file('run.sh')).kind, 'empty')
  const renamed = await file('new-name.txt')
  assert.equal(renamed.kind, 'empty')
  assert.equal(renamed.from, 'old-name.txt')
  const gone = await file('del.txt')
  assert.deepEqual(gone.hunks[0]?.lines, ['-x', '-y'])
  assert.equal((await file('中文 名.txt')).hunks[0]?.lines.join('|'), ' 中|+文')
  // 概况里没有的文件：没有差异可给
  assert.equal((await file('nothing-here.txt')).kind, 'missing')
})

test('一次取全部文件：和概况里的顺序一样，一条 git diff 加上没跟踪的各一条', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  const view = await world.watch('all').settled()
  const before = world.commands().length
  const bundle = await world.diffs.files(world.root, 'all', 's1')
  assert.equal(bundle.truncated, false)
  assert.equal(bundle.version, view.version)
  assert.deepEqual(
    bundle.files.map((file) => [file.path, file.kind]),
    [
      ['del.txt', 'text'],
      ['empty-untracked.txt', 'empty'],
      ['mod.txt', 'text'],
      ['new-name.txt', 'empty'],
      ['pic.bin', 'binary'],
      ['run.sh', 'empty'],
      ['staged-new.txt', 'text'],
      ['sub/in.txt', 'text'],
      ['untracked.bin', 'binary'],
      ['untracked.txt', 'text'],
      ['中文 名.txt', 'text'],
    ],
  )
  // 跟踪着的一条命令取完，没跟踪的三个各一条
  assert.equal(world.commands().length - before, 4)
})

test('用户的 git 配置把输出改了样子（颜色、去前缀、路径加引号、外部工具）也照样读得对', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  world.git('config', 'color.ui', 'always')
  world.git('config', 'diff.noprefix', 'true')
  world.git('config', 'core.quotePath', 'true')
  world.git('config', 'diff.external', '/usr/bin/false')
  world.git('config', 'status.relativePaths', 'true')
  const view = await world.watch('all').settled()
  assert.equal(view.phase, 'ready')
  assert.equal(view.entries.length, 11)
  assert.equal(byPath(view)['中文 名.txt']?.added, 1)
  const file = await world.diffs.file(world.root, 'all', 's1', '中文 名.txt', false)
  assert.equal(file.kind, 'text')
  assert.deepEqual(file.hunks[0]?.lines, [' 中', '+文'])
})

test('根在仓库的子目录里：只看这个子目录，路径相对于它', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  world.put('sub/fresh.txt', 'one\ntwo\n')
  const sub = join(world.root, 'sub')
  world.state.roots.add(sub)
  const view = await world.watch('all', 's1', sub).settled()
  assert.deepEqual(brief(view), [
    ['fresh.txt', 'untracked', 2, 0],
    ['in.txt', 'modified', 1, 0],
  ])
  const file = await world.diffs.file(sub, 'all', 's1', 'in.txt', false)
  assert.deepEqual(file.hunks[0]?.lines, [' s', '+t'])
  await world.diffs.stage(sub, ['in.txt', 'fresh.txt'])
  assert.match(world.git('status', '--porcelain'), /^M {2}sub\/in\.txt$/m)
  assert.match(world.git('status', '--porcelain'), /^A {2}sub\/fresh\.txt$/m)
})

test('还没有提交的仓库：文件都算新加的', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  world.put('first.txt', 'hello\n')
  world.put('second.txt', 'a\nb\n')
  world.git('add', 'first.txt')
  const view = await world.watch('all').settled()
  assert.deepEqual(brief(view), [
    ['first.txt', 'added', 1, 0],
    ['second.txt', 'untracked', 2, 0],
  ])
  const file = await world.diffs.file(world.root, 'all', 's1', 'first.txt', false)
  assert.deepEqual(file.hunks[0]?.lines, ['+hello'])
})

test('暂存和取消暂存：不用确认，做完概况跟着变；改名的两头一起退', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  const seen = world.watch('all')
  const first = await seen.settled()
  await world.diffs.stage(world.root, ['mod.txt', 'untracked.txt'])
  const staged = byPath(seen.latest())
  assert.ok(seen.latest().version > first.version)
  assert.deepEqual([staged['mod.txt']?.staged, staged['mod.txt']?.unstaged], [true, false])
  assert.equal(staged['untracked.txt']?.status, 'added')

  await world.diffs.unstage(world.root, ['mod.txt', 'new-name.txt'])
  const after = byPath(seen.latest())
  assert.deepEqual([after['mod.txt']?.staged, after['mod.txt']?.unstaged], [false, true])
  // 改名退回去之后：旧名字是“删了、没暂存”，新名字是没跟踪的
  assert.equal(after['old-name.txt']?.status, 'deleted')
  assert.equal(after['new-name.txt']?.status, 'untracked')
  assert.doesNotMatch(world.git('status', '--porcelain'), /^R/m)
})

test('还原：各种情形各做对的事；确认之后文件变成了另一种情形就不动它', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  const seen = world.watch('all')
  await seen.settled()
  const at = (path: string) => join(world.root, path)
  const discard = (path: string, expect: DiffEntry['status']) =>
    world.diffs.discard(world.root, 'all', path, expect)

  // 改了的：内容回到上一次提交
  await discard('mod.txt', 'modified')
  assert.equal(readFileSync(at('mod.txt'), 'utf8'), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n')
  // 删了的：拿回来
  await discard('del.txt', 'deleted')
  assert.equal(readFileSync(at('del.txt'), 'utf8'), 'x\ny\n')
  // 没跟踪的、暂存区里新加的：文件删掉
  await discard('untracked.txt', 'untracked')
  assert.equal(existsSync(at('untracked.txt')), false)
  await discard('staged-new.txt', 'added')
  assert.equal(existsSync(at('staged-new.txt')), false)
  // 改了名的：名字改回去
  await discard('new-name.txt', 'renamed')
  assert.equal(existsSync(at('new-name.txt')), false)
  assert.equal(readFileSync(at('old-name.txt'), 'utf8'), 'r1\nr2\nr3\nr4\nr5\n')
  assert.deepEqual(
    seen.latest().entries.map((entry) => entry.path),
    ['empty-untracked.txt', 'pic.bin', 'run.sh', 'sub/in.txt', 'untracked.bin', '中文 名.txt'],
  )

  // 界面上确认的是“改了的文件（丢一行）”，这期间别处提交了“不再跟踪它”，它成了没跟踪的文件：
  // 这时候还原就是整个删掉，和确认的不是一回事，不动
  world.git('rm', '-q', '--cached', 'sub/in.txt')
  world.git('commit', '-q', '-m', 'untrack')
  const stale = seen.latest().version
  const error = await rejects(discard('sub/in.txt', 'modified'), 'conflict')
  assert.equal(error.text?.key, 'diff.moved')
  assert.equal(readFileSync(at('sub/in.txt'), 'utf8'), 's\nt\n')
  // 拒了之后概况自己换成新的，界面上看到的就是它现在的样子
  assert.equal(byPath(await seen.next(stale))['sub/in.txt']?.status, 'untracked')
  // 已暂存的范围不能还原
  await rejects(world.diffs.discard(world.root, 'staged', 'run.sh', 'modified'), 'rejected')
})

test('只还原没暂存的那一半：暂存区里的留着', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  world.put('a.txt', 'one\n')
  world.git('add', '-A')
  world.git('commit', '-q', '-m', 'base')
  world.put('a.txt', 'one\ntwo\n')
  world.git('add', 'a.txt')
  world.put('a.txt', 'one\ntwo\nthree\n')
  const seen = world.watch('unstaged')
  assert.deepEqual(brief(await seen.settled()), [['a.txt', 'modified', 1, 0]])
  await world.diffs.discard(world.root, 'unstaged', 'a.txt', 'modified')
  assert.equal(readFileSync(join(world.root, 'a.txt'), 'utf8'), 'one\ntwo\n')
  assert.deepEqual(seen.latest().entries, [])
  assert.match(world.git('status', '--porcelain'), /^M {2}a\.txt$/m)
})

test('暂存区里删了、工作区里还留着同名的文件：看全部时是一个整个换了内容的文件，不列成两条', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  world.put('a.txt', 'one\ntwo\n')
  world.git('add', '-A')
  world.git('commit', '-q', '-m', 'base')
  world.git('rm', '-q', '--cached', 'a.txt')
  world.put('a.txt', 'one\nthree\nfour\n')
  const seen = world.watch('all')
  const view = await seen.settled()
  assert.deepEqual(brief(view), [['a.txt', 'modified', 3, 2]])
  assert.deepEqual([view.entries[0]?.staged, view.entries[0]?.unstaged], [true, true])
  const file = await world.diffs.file(world.root, 'all', 's1', 'a.txt', false)
  assert.deepEqual(file.hunks[0]?.lines, ['-one', '-two', '+one', '+three', '+four'])
  assert.deepEqual((await world.diffs.files(world.root, 'all', 's1')).files[0], file)
  assert.deepEqual(brief(await world.watch('staged').settled()), [['a.txt', 'deleted', 0, 2]])
  assert.deepEqual(brief(await world.watch('unstaged').settled()), [['a.txt', 'untracked', 3, 0]])
  // 还原它：回到上一次提交的样子
  await world.diffs.discard(world.root, 'all', 'a.txt', 'modified')
  assert.equal(readFileSync(join(world.root, 'a.txt'), 'utf8'), 'one\ntwo\n')
  assert.deepEqual(seen.latest().entries, [])
})

test('路径出了根的一条命令都不发', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  await world.watch('all').settled()
  const before = world.seen.length
  for (const path of ['../outside.txt', '/etc/passwd', 'sub/../../x', '', '.', 'a\0b']) {
    await rejects(world.diffs.stage(world.root, [path]), 'rejected')
    await rejects(world.diffs.unstage(world.root, [path]), 'rejected')
    await rejects(world.diffs.discard(world.root, 'all', path, 'modified'), 'rejected')
    await rejects(world.diffs.file(world.root, 'all', 's1', path, false), 'rejected')
  }
  assert.equal(world.seen.length, before)
  // 不认识的根：订阅和命令都拒
  assert.throws(() => world.watch('all', 's1', '/somewhere/else'), { code: 'rejected' })
  await rejects(world.diffs.refresh('/somewhere/else'), 'rejected')
})

test('路径里的星号、方括号、开头的减号和冒号都只是字', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  world.put('keep.txt', 'keep\n')
  world.put('*.txt', 'star\n')
  world.put('-rf', 'dash\n')
  world.put(':(top)x', 'magic\n')
  world.put('[ab].txt', 'bracket\n')
  world.put('a.txt', 'a\n')
  world.git('add', '--', 'keep.txt', 'a.txt')
  world.git('commit', '-q', '-m', 'base')
  world.put('keep.txt', 'keep\nmore\n')
  world.put('a.txt', 'a\nmore\n')
  const seen = world.watch('all')
  assert.deepEqual(
    (await seen.settled()).entries.map((entry) => [entry.path, entry.added]),
    [
      ['*.txt', 1],
      ['-rf', 1],
      [':(top)x', 1],
      ['[ab].txt', 1],
      ['a.txt', 1],
      ['keep.txt', 1],
    ],
  )
  // 暂存 “*.txt” 和 “[ab].txt” 这两个文件：别的 .txt 不跟着进去
  await world.diffs.stage(world.root, ['*.txt', '[ab].txt', '-rf', ':(top)x'])
  const entries = byPath(seen.latest())
  assert.equal(entries['keep.txt']?.staged, false)
  assert.equal(entries['a.txt']?.staged, false)
  assert.equal(entries['*.txt']?.staged, true)
  assert.equal(entries['-rf']?.staged, true)
  // 还原 “*.txt”：只删它自己
  await world.diffs.unstage(world.root, ['*.txt'])
  await world.diffs.discard(world.root, 'all', '*.txt', 'untracked')
  assert.equal(existsSync(join(world.root, '*.txt')), false)
  assert.equal(readFileSync(join(world.root, 'keep.txt'), 'utf8'), 'keep\nmore\n')
  assert.equal(readFileSync(join(world.root, 'a.txt'), 'utf8'), 'a\nmore\n')
})

test('不是 git 仓库：照实说；harness 发本回合差异的，用它当唯一的来源', async (t) => {
  const world = gitWorld({ plain: true, turnDiff: true })
  t.after(world.cleanup)
  const seen = world.watch('all', 's1')
  const none = await seen.settled()
  assert.equal(none.phase, 'absent')
  assert.equal(none.why, 'notRepo')
  // 会发、只是还没发过
  assert.equal(none.source, 'turn')
  assert.equal(none.writable, false)

  world.diffs.turnDiff(
    's1',
    't1',
    [
      'diff --git a/notes.md b/notes.md',
      'index 1111111..2222222 100644',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,2 +1,3 @@',
      ' # 周报',
      '-旧的一行',
      '+新的一行',
      '+再加一行',
      `diff --git a/${world.root}/deep/new.ts b/${world.root}/deep/new.ts`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${world.root}/deep/new.ts`,
      '@@ -0,0 +1 @@',
      '+export {}',
      '',
    ].join('\n'),
  )
  const view = seen.latest()
  assert.equal(view.phase, 'ready')
  assert.equal(view.source, 'turn')
  assert.equal(view.why, 'notRepo')
  assert.equal(view.writable, false)
  assert.deepEqual(brief(view), [
    ['deep/new.ts', 'added', 1, 0],
    ['notes.md', 'modified', 2, 1],
  ])
  const bundle = await world.diffs.files(world.root, 'all', 's1')
  assert.equal(bundle.version, view.version)
  assert.deepEqual(
    bundle.files.map((file) => [file.path, file.kind, file.language]),
    [
      ['deep/new.ts', 'text', 'typescript'],
      ['notes.md', 'text', 'markdown'],
    ],
  )
  const file = await world.diffs.file(world.root, 'all', 's1', 'notes.md', false)
  assert.deepEqual(file.hunks[0]?.lines, [' # 周报', '-旧的一行', '+新的一行', '+再加一行'])
  // 别的会话的本回合差异不串过来
  assert.equal(world.watch('all', 's2').latest().phase, 'absent')
  // 这里暂存、还原都做不了
  await rejects(world.diffs.stage(world.root, ['notes.md']), 'rejected')
})

test('本回合差异里的完整路径是根的另一种写法（macOS 上 /private/var 和 /var）：设备是 macOS 时也换成相对于根的', async (t) => {
  for (const platform of ['macos', 'linux']) {
    const world = gitWorld({ plain: true, turnDiff: true, platform })
    t.after(world.cleanup)
    // 根是解开链接之后的路径（/private/var/…、/private/tmp/…，Linux 上是 /tmp/…）；harness 报的是另一种写法
    const other = privateTwin(world.root)
    if (other === null) return t.skip(`临时目录不在 /tmp、/var 下面：${world.root}`)
    const seen = world.watch('all', 's1')
    await seen.settled()
    world.diffs.turnDiff(
      's1',
      't1',
      [
        `diff --git a/${other}/deep/new.ts b/${other}/deep/new.ts`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${other}/deep/new.ts`,
        '@@ -0,0 +1 @@',
        '+export {}',
        '',
      ].join('\n'),
    )
    const view = seen.latest()
    assert.equal(view.phase, 'ready', platform)
    if (platform === 'linux') {
      // Linux 上 /private 没有特殊含义：不认，照原样留着完整路径（和别的落在根外面的一样）
      assert.deepEqual(brief(view), [[`${other}/deep/new.ts`, 'added', 1, 0]])
      continue
    }
    assert.deepEqual(brief(view), [['deep/new.ts', 'added', 1, 0]])
    const file = await world.diffs.file(world.root, 'all', 's1', 'deep/new.ts', false)
    assert.deepEqual(file.hunks[0]?.lines, ['+export {}'])
  }
})

test('不是 git 仓库，harness 也声明了不发本回合差异：只说这里不是仓库', async (t) => {
  const world = gitWorld({ plain: true, turnDiff: false })
  t.after(world.cleanup)
  const seen = world.watch('all', 's1')
  const view = await seen.settled()
  assert.equal(view.phase, 'absent')
  assert.equal(view.why, 'notRepo')
  assert.equal(view.source, 'git')
  // 就算真来了一份也不用
  world.diffs.turnDiff('s1', 't1', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
  assert.equal(seen.latest().phase, 'absent')
})

test('后来才成了仓库（git init）：下一次取就认出来', async (t) => {
  const world = gitWorld({ plain: true, turnDiff: false })
  t.after(world.cleanup)
  world.put('a.txt', 'a\n')
  const seen = world.watch('all')
  assert.equal((await seen.settled()).phase, 'absent')
  world.git('init', '-q', '-b', 'main', '.')
  await world.diffs.refresh(world.root)
  assert.equal(seen.latest().phase, 'ready')
  assert.deepEqual(brief(seen.latest()), [['a.txt', 'untracked', 1, 0]])
})

test('设备上没有 git、对面不会起进程：各有各的说法，不当成出错', async (t) => {
  const missing = gitWorld()
  t.after(missing.cleanup)
  missing.state.gitMissing = true
  const noGit = await missing.watch('all').settled()
  assert.deepEqual([noGit.phase, noGit.why], ['absent', 'noGit'])

  const dumb = gitWorld({ noSpawn: true })
  t.after(dumb.cleanup)
  const unsupported = await dumb.watch('all').settled()
  assert.deepEqual([unsupported.phase, unsupported.why], ['absent', 'unsupported'])

  // 目录不在了：这是出错，不是“没有 git”
  const gone = gitWorld()
  t.after(gone.cleanup)
  rmSync(gone.root, { recursive: true, force: true })
  const failed = await gone.watch('all').settled()
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error?.text?.key, 'diff.rootMissing')
})

test('什么时候重新取：回合结束、对面报文件变了（合成一次）、手动；没人看的时候不取', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  const seen = world.watch('all')
  const first = await seen.settled()
  const refreshes = () => world.diffs.requests().refreshes
  assert.equal(refreshes(), 1)

  // 回合结束
  world.put('by-agent.txt', 'agent\n')
  world.diffs.turnEnded('s1')
  const second = await seen.next(first.version)
  assert.equal(byPath(second)['by-agent.txt']?.status, 'untracked')
  assert.equal(refreshes(), 2)

  // 对面报了一连串变化：过一小会儿取一次
  const watchId = world.sent('fs/watch')[0]?.watchId
  world.put('by-hand.txt', 'hand\n')
  for (let n = 0; n < 5; n++) {
    assert.equal(world.diffs.notification('fs/changed', { watchId, changedPaths: [] }), true)
  }
  assert.equal(refreshes(), 2)
  world.time.advance(2000)
  const third = await seen.next(second.version)
  assert.equal(byPath(third)['by-hand.txt']?.status, 'untracked')
  assert.equal(refreshes(), 3)
  // 不是这里登记的监视：不认
  assert.equal(world.diffs.notification('fs/changed', { watchId: 'someone-else' }), false)

  // 自己刚暂存过：紧跟着报来的变化就是自己弄出来的，不再取一遍
  await world.diffs.stage(world.root, ['by-hand.txt'])
  const afterStage = refreshes()
  world.diffs.notification('fs/changed', { watchId, changedPaths: [] })
  world.time.advance(500)
  assert.equal(refreshes(), afterStage)

  // 没人看了：回合结束也不取；再有人看才取
  seen.stop()
  world.put('unseen.txt', 'unseen\n')
  world.diffs.turnEnded('s1')
  world.time.advance(5000)
  assert.equal(refreshes(), afterStage)
  const back = world.watch('all')
  const fourth = await back.next(seen.latest().version)
  assert.equal(byPath(fourth)['unseen.txt']?.status, 'untracked')
  assert.equal(refreshes(), afterStage + 1)
})

test('正取着概况的时候来要内容：等那一趟取完，不让它再来一遍', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  const seen = world.watch('all')
  const first = await seen.settled()
  const refreshes = () => world.diffs.requests().refreshes
  assert.equal(refreshes(), 1)
  // 界面的做法：每见到一版新的概况就要一次全部内容。回合结束引出一趟重取，趁它还没取完就来要
  let asked = 0
  const versions = new Set<number>([first.version])
  const follow = () => {
    const now = seen.latest().version
    if (versions.has(now)) return
    versions.add(now)
    asked++
    void world.diffs.files(world.root, 'all', 's1').then(follow, follow)
  }
  world.put('by-agent.txt', 'agent\n')
  world.diffs.turnEnded('s1')
  const during = world.diffs.files(world.root, 'all', 's1')
  const second = await seen.next(first.version)
  follow()
  const bundle = await during
  assert.equal(bundle.version, second.version)
  assert.ok(bundle.files.some((file) => file.path === 'by-agent.txt'))
  // 等一阵：没有再多出来的重取，版本也停住了
  for (let round = 0; round < 20; round++) {
    await new Promise((done) => setTimeout(done, 10))
    follow()
  }
  assert.equal(refreshes(), 2)
  assert.equal(seen.latest().version, second.version)
  assert.ok(asked <= 1)
})

test('盯上的应答比概况晚到：到了之后界面知道是盯着的', async (t) => {
  const world = gitWorld({ watchDelayMs: 60 })
  t.after(world.cleanup)
  mixedRepo(world)
  const seen = world.watch('all')
  const first = await seen.settled()
  assert.equal(first.phase, 'ready')
  for (let round = 0; round < 100 && !seen.latest().watching; round++) {
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.equal(seen.latest().watching, true)
  // 只是多报了一次，没有为这个再取一遍
  assert.equal(world.diffs.requests().refreshes, 1)
  assert.equal(seen.latest().version, first.version)
})

test('没人看了过一阵就不盯了；对面没有 fs/watch 的照样能用，只是不自己跟', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  const seen = world.watch('all')
  await seen.settled()
  assert.equal(world.sent('fs/unwatch').length, 0)
  seen.stop()
  world.time.advance(31_000)
  assert.equal(world.sent('fs/unwatch').length, 2)

  const plain = gitWorld({ noWatch: true })
  t.after(plain.cleanup)
  mixedRepo(plain)
  const view = await plain.watch('all').settled()
  assert.equal(view.phase, 'ready')
  assert.equal(view.watching, false)
  // 问过一次说没有，之后不再问
  await plain.diffs.refresh(plain.root)
  assert.equal(plain.sent('fs/watch').length, 1)
})

test('取到一半不要了：对面的进程被结束，命令以 cancelled 结束', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  mixedRepo(world)
  await world.watch('all').settled()
  const listeners: (() => void)[] = []
  const signal = {
    aborted: false,
    addEventListener(_type: 'abort', listener: () => void) {
      listeners.push(listener)
    },
  }
  // 命令一发出去就取消
  world.state.onSpawn = () => {
    world.state.onSpawn = null
    signal.aborted = true
    for (const listener of listeners) listener()
  }
  const work = world.diffs.files(world.root, 'all', 's1', signal)
  await rejects(work, 'cancelled')
  assert.ok(world.sent('process/kill').length >= 1)
})

test('几百个文件的改动：概况取得出来，命令的条数不随文件数涨', async (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  for (let n = 0; n < 300; n++) world.put(`src/mod-${n}.ts`, `export const v${n} = ${n}\n`)
  world.git('add', '-A')
  world.git('commit', '-q', '-m', 'base')
  for (let n = 0; n < 300; n++) {
    world.put(`src/mod-${n}.ts`, `export const v${n} = ${n + 1}\nexport const w${n} = 0\n`)
  }
  for (let n = 0; n < 200; n++) world.put(`gen/new-${n}.ts`, `// ${n}\nexport {}\n`)
  const started = Date.now()
  const view = await world.watch('all').settled()
  assert.equal(view.entries.length, 500)
  assert.equal(view.omitted, 0)
  assert.equal(byPath(view)['gen/new-199.ts']?.added, 2)
  assert.equal(byPath(view)['src/mod-299.ts']?.removed, 1)
  // 认仓库、看状态、数行数、看改了什么：四条
  assert.equal(world.diffs.requests().spawns, 4)
  assert.ok(Date.now() - started < 20_000)
  // 文件太多：不一次全取，界面改成一个一个看
  const bundle = await world.diffs.files(world.root, 'all', 's1')
  assert.equal(bundle.truncated, true)
  assert.equal(bundle.files.length, 0)
})
