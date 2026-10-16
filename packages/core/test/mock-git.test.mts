// 假的 git（mock/mock-git.mts）和真的对不对得上：同一份内容两边各摆一遍，同一条命令两边各跑一遍，
// 读出来的东西（用的就是差异模块读输出的那几个函数）要一样。对象名是假的，不比。
import assert from 'node:assert/strict'
import { chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  hunksOf,
  lineDiff,
  parseGrepCounts,
  parsePatch,
  parseRawNumstat,
  parseStatus,
} from '../src/index.mjs'
import { type FakeBlob, type FakeRepo, type FakeTree, fakeGit } from '../src/mock/mock-git.mjs'
import { type GitWorld, gitWorld } from './git-world.mjs'

const GIT = ['--no-pager', '--literal-pathspecs', '-c', 'core.quotePath=false']
const DIFF = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '-M',
  '--relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

const text = (data: string, exec = false): FakeBlob => (exec ? { data, exec } : { data })
const numbered = (prefix: string, count: number): string =>
  `${Array.from({ length: count }, (_, n) => `${prefix}${n + 1}`).join('\n')}\n`

/** 三棵树：各种改动都有一个 */
function scenario(top: string): FakeRepo {
  const head: FakeTree = new Map([
    ['mod.txt', text(numbered('line', 20))],
    ['both.txt', text('a\nb\nc\nd\ne\n')],
    ['del.txt', text('x\ny\n')],
    ['old-name.txt', text(numbered('r', 6))],
    ['run.sh', text('#!/bin/sh\necho hi\n')],
    ['pic.bin', { data: Uint8Array.from([0, 1, 2, 98, 105, 110]) }],
    ['sub/in.txt', text('s1\ns2\n')],
    ['sub/keep.txt', text('keep\n')],
    ['noeol.txt', text('x\ny')],
    ['noeol2.txt', text('p\nq\n')],
    ['gone-work.txt', text('w1\nw2\nw3\n')],
    ['replaced.txt', text('one\ntwo\n')],
  ])
  const index: FakeTree = new Map(head)
  index.delete('del.txt')
  index.delete('replaced.txt')
  index.delete('old-name.txt')
  index.set('new-name.txt', text(numbered('r', 6)))
  index.set('both.txt', text('a\nb\nc\nd\ne\nstaged\n'))
  index.set('staged-new.txt', text('fresh\n'))
  index.set('empty-staged.txt', text(''))
  const work: FakeTree = new Map(index)
  work.delete('gone-work.txt')
  work.set(
    'mod.txt',
    text(
      numbered('line', 20)
        .replace('line2\n', 'LINE2\n')
        .replace('line19\n', 'LINE19\n')
        .concat('line21\n'),
    ),
  )
  work.set('both.txt', text('A\nb\nc\nd\ne\nstaged\n'))
  work.set('run.sh', text('#!/bin/sh\necho hi\n', true))
  work.set('pic.bin', { data: Uint8Array.from([0, 9, 2, 98, 105, 110, 50]) })
  work.set('sub/in.txt', text('s1\ns2\ns3\n'))
  work.set('noeol.txt', text('x\ny\nz\n'))
  work.set('noeol2.txt', text('p\nq2'))
  work.set('replaced.txt', text('one\nthree\n'))
  work.set('untracked.txt', text('new\nfile\nno newline'))
  work.set('untracked.bin', { data: Uint8Array.from([0, 1]) })
  work.set('empty-untracked.txt', text(''))
  work.set('sub/new.txt', text('n1\n'))
  work.set('中文 名.txt', text('中\n文\n'))
  return { top, branch: 'main', head, index, work }
}

/** 把三棵树照样摆到真的仓库里 */
function materialize(world: GitWorld, repo: FakeRepo) {
  const lay = (tree: FakeTree, previous: FakeTree | null) => {
    for (const path of previous?.keys() ?? []) {
      if (!tree.has(path)) rmSync(join(world.root, path), { force: true })
    }
    for (const [path, blob] of tree) {
      world.put(path, blob.data)
      chmodSync(join(world.root, path), blob.exec ? 0o755 : 0o644)
    }
  }
  if (repo.head) {
    lay(repo.head, null)
    world.git('add', '-A')
    world.git('commit', '-q', '-m', 'base')
  }
  lay(repo.index, repo.head)
  world.git('add', '-A')
  lay(repo.work, repo.index)
}

const patches = (output: string) =>
  parsePatch(output).map((file) => ({
    ...file,
    hunks: file.hunks.map((hunk) => ({ ...hunk, section: '' })),
  }))

/** 两边各跑一遍，读出来的要一样 */
function agree(world: GitWorld, repo: FakeRepo, sub = '') {
  const cwd = sub ? join(world.root, sub) : world.root
  const both = (args: string[]) => ({
    real: world.raw([...GIT, ...args], cwd),
    fake: fakeGit(repo, cwd, ['git', ...GIT, ...args]),
    said: args.join(' '),
  })
  const status = both([
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ])
  const real = parseStatus(status.real.stdout)
  assert.deepEqual(parseStatus(status.fake.stdout), real, status.said)
  for (const rev of [['HEAD'], ['--cached'], []]) {
    const summary = both(['diff', '--raw', '--numstat', '-z', ...DIFF, ...rev])
    assert.deepEqual(
      parseRawNumstat(summary.fake.stdout),
      parseRawNumstat(summary.real.stdout),
      summary.said,
    )
    for (const context of ['-U3', '-U0', '-U1000000']) {
      const all = both(['diff', ...DIFF, context, ...rev])
      assert.deepEqual(patches(all.fake.stdout), patches(all.real.stdout), all.said)
    }
    for (const paths of [
      ['mod.txt'],
      ['new-name.txt'],
      ['new-name.txt', 'old-name.txt'],
      ['in.txt'],
    ]) {
      const one = both(['diff', ...DIFF, '-U3', ...rev, '--', ...paths])
      assert.deepEqual(patches(one.fake.stdout), patches(one.real.stdout), one.said)
    }
  }
  const prefix = sub ? `${sub}/` : ''
  const untracked = real.entries
    .filter((entry) => entry.kind === 'untracked')
    .map((entry) => entry.path.slice(prefix.length))
  const counts = both(['grep', '--untracked', '-I', '-c', '-z', '-e', '', '--', ...untracked])
  assert.deepEqual(parseGrepCounts(counts.fake.stdout), parseGrepCounts(counts.real.stdout))
  assert.equal(counts.fake.exitCode, counts.real.exitCode, counts.said)
  for (const path of untracked) {
    const stat = both(['diff', '--no-index', '--numstat', '--', '/dev/null', path])
    assert.equal(
      stat.fake.stdout.startsWith('-\t-\t'),
      stat.real.stdout.startsWith('-\t-\t'),
      stat.said,
    )
    const one = both([
      'diff',
      '--no-index',
      ...DIFF.filter((flag) => flag !== '-M' && flag !== '--relative'),
      '--',
      '/dev/null',
      path,
    ])
    assert.deepEqual(patches(one.fake.stdout), patches(one.real.stdout), one.said)
    assert.equal(one.fake.exitCode, one.real.exitCode, one.said)
  }
}

test('假的 git 和真的读出来一样：状态、三种范围的概况和差异、没跟踪的文件', (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  const repo = scenario(world.root)
  materialize(world, repo)
  agree(world, repo)
  agree(world, repo, 'sub')
  const probe = ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-prefix']
  assert.equal(
    fakeGit(repo, join(world.root, 'sub'), ['git', ...probe]).stdout,
    world.raw(probe, join(world.root, 'sub')).stdout,
  )
})

test('假的 git 改东西的那几条：暂存、取消暂存、还原、删掉，做完两边还是一样', (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  const repo = scenario(world.root)
  materialize(world, repo)
  const steps: string[][] = [
    ['add', '-A', '--', 'mod.txt', 'untracked.txt', 'gone-work.txt', 'sub'],
    ['reset', '-q', '--', 'mod.txt', 'new-name.txt', 'old-name.txt', 'staged-new.txt'],
    ['checkout', '-q', 'HEAD', '--', 'mod.txt', 'replaced.txt', 'del.txt'],
    ['checkout', '-q', '--', 'both.txt', 'noeol.txt'],
    ['rm', '-q', '-f', '--', 'empty-staged.txt', 'untracked.txt'],
    ['clean', '-q', '-f', '--', 'untracked.bin', 'staged-new.txt', '中文 名.txt'],
  ]
  for (const step of steps) {
    const real = world.raw([...GIT, ...step])
    const fake = fakeGit(repo, world.root, ['git', ...GIT, ...step])
    assert.equal(fake.exitCode, real.exitCode, step.join(' '))
    agree(world, repo)
  }
})

test('还没有提交的仓库、不是仓库的目录', (t) => {
  const world = gitWorld()
  t.after(world.cleanup)
  const repo: FakeRepo = {
    top: world.root,
    branch: 'main',
    head: null,
    index: new Map([['first.txt', text('hello\n')]]),
    work: new Map([
      ['first.txt', text('hello\n')],
      ['second.txt', text('a\nb\n')],
    ]),
  }
  materialize(world, repo)
  const args = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']
  assert.deepEqual(
    parseStatus(fakeGit(repo, world.root, ['git', ...args]).stdout),
    parseStatus(world.raw(args).stdout),
  )
  const tree = ['hash-object', '-t', 'tree', '/dev/null']
  const empty = world.raw(tree).stdout
  assert.equal(fakeGit(repo, world.root, ['git', ...tree]).stdout, empty)
  for (const rev of [[empty.trim()], ['--cached']]) {
    const summary = ['diff', '--raw', '--numstat', '-z', ...DIFF, ...rev]
    assert.deepEqual(
      parseRawNumstat(fakeGit(repo, world.root, ['git', ...summary]).stdout),
      parseRawNumstat(world.raw(summary).stdout),
    )
  }
  const none = fakeGit(null, '/somewhere', ['git', 'rev-parse', '--show-toplevel'])
  assert.equal(none.exitCode, 128)
  assert.match(none.stderr, /not a git repository/)
})

test('按行比：先去掉两头一样的，一段改动里删的在前加的在后；改得太多就整段换', () => {
  assert.deepEqual(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']).join(''), ' -+ ')
  assert.deepEqual(lineDiff([], ['a', 'b']).join(''), '++')
  assert.deepEqual(lineDiff(['a', 'b'], []).join(''), '--')
  assert.deepEqual(lineDiff(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'e']).join(''), '-   +')
  assert.deepEqual(lineDiff(['a', 'b'], ['a', 'b']).join(''), '  ')
  // 每一行都不一样、又多：不细比
  const before = Array.from({ length: 4000 }, (_, n) => `old ${n}`)
  const after = Array.from({ length: 4000 }, (_, n) => `new ${n}`)
  const ops = lineDiff(['same', ...before, 'end'], ['same', ...after, 'end'])
  assert.equal(ops.join(''), ` ${'-'.repeat(4000)}${'+'.repeat(4000)} `)
})

test('切成段：隔得近的并成一段，一边没有行的起点是前一行', () => {
  const before = Array.from({ length: 30 }, (_, n) => `l${n + 1}`)
  const after = [...before]
  after[1] = 'L2'
  after[7] = 'L8'
  after[25] = 'L26'
  const hunks = hunksOf(before, after, 3)
  assert.deepEqual(
    hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
    [
      [1, 11, 1, 11],
      [23, 7, 23, 7],
    ],
  )
  assert.deepEqual(hunksOf([], ['a'], 3)[0], {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 1,
    section: '',
    lines: ['+a'],
  })
  assert.deepEqual(hunksOf(['a', 'b'], ['a', 'b'], 3), [])
})
