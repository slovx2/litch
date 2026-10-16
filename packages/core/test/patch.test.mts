// 统一格式的差异怎么拆（packages/core/src/text/patch.mts），和 git 那几条给程序读的输出怎么读
// （projection/git-output.mts）。都是纯函数，拿 git 实际会给的样子来试。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  discardKindOf,
  expectedDiscard,
  parseGrepCounts,
  parsePatch,
  parseRawNumstat,
  parseStatus,
  summarize,
  unquotePath,
} from '../src/index.mjs'

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

test('改了内容的文件：段的起止行数、所在的函数、每行的记号', () => {
  const [file, ...rest] = parsePatch(
    lines(
      'diff --git a/src/app.ts b/src/app.ts',
      'index 2f0b8ee..1a2b3c4 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,4 +1,4 @@ export function main() {',
      ' a',
      '-b',
      '+B',
      ' c',
      ' d',
      '@@ -10,3 +10,4 @@',
      ' j',
      ' k',
      '-l',
      '+L',
      '+m',
    ),
  )
  assert.equal(rest.length, 0)
  assert.equal(file?.path, 'src/app.ts')
  assert.equal(file?.change, 'modify')
  assert.equal(file?.from, null)
  assert.deepEqual([file?.added, file?.removed], [3, 2])
  assert.deepEqual(file?.hunks[0], {
    oldStart: 1,
    oldLines: 4,
    newStart: 1,
    newLines: 4,
    section: 'export function main() {',
    lines: [' a', '-b', '+B', ' c', ' d'],
  })
  assert.deepEqual(file?.hunks[1]?.lines, [' j', ' k', '-l', '+L', '+m'])
})

test('新增、删除、改名、权限、二进制各认得出来', () => {
  const files = parsePatch(
    lines(
      'diff --git a/del.txt b/del.txt',
      'deleted file mode 100644',
      'index b77b4eb..0000000',
      '--- a/del.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/old-name.txt b/new-name.txt',
      'similarity index 90%',
      'rename from old-name.txt',
      'rename to new-name.txt',
      'index 0ec1772..aaaaaaa 100644',
      '--- a/old-name.txt',
      '+++ b/new-name.txt',
      '@@ -1 +1 @@',
      '-r1',
      '+R1',
      'diff --git a/pic.bin b/pic.bin',
      'index 6772730..e69de29 100644',
      'Binary files a/pic.bin and b/pic.bin differ',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/staged-new.txt b/staged-new.txt',
      'new file mode 100644',
      'index 0000000..19d9cc8',
      '--- /dev/null',
      '+++ b/staged-new.txt',
      '@@ -0,0 +1 @@',
      '+staged',
    ),
  )
  assert.deepEqual(
    files.map((file) => [file.path, file.change, file.from, file.binary, file.hunks.length]),
    [
      ['del.txt', 'delete', null, false, 1],
      ['new-name.txt', 'rename', 'old-name.txt', false, 1],
      ['pic.bin', 'modify', null, true, 0],
      ['run.sh', 'modify', null, false, 0],
      ['staged-new.txt', 'add', null, false, 1],
    ],
  )
  assert.deepEqual(files[3]?.mode, { from: '100644', to: '100755' })
  assert.deepEqual([files[0]?.added, files[0]?.removed], [0, 2])
})

test('末尾没有换行的记在对应的那一边；内容里长得像文件头的行不会被当成文件头', () => {
  const [file, ...rest] = parsePatch(
    lines(
      'diff --git a/notes.md b/notes.md',
      'index 1111111..2222222 100644',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,3 +1,3 @@',
      ' intro',
      '--- a/fake.txt',
      '-diff --git a/x b/y',
      '+++ b/fake.txt',
      '+tail',
      '\\ No newline at end of file',
    ),
  )
  assert.equal(rest.length, 0)
  // 删掉的那两行是 “-- a/fake.txt” 和 “diff --git a/x b/y”，加上的是 “++ b/fake.txt” 和 “tail”
  assert.deepEqual(file?.hunks[0]?.lines, [
    ' intro',
    '--- a/fake.txt',
    '-diff --git a/x b/y',
    '+++ b/fake.txt',
    '+tail',
  ])
  assert.equal(file?.noEolNew, true)
  assert.equal(file?.noEolOld, false)
})

test('带引号的路径还原成原来的字；名字里有空格的照样认', () => {
  assert.equal(unquotePath('"a/\\346\\226\\207 \\"q\\".txt"'), 'a/文 "q".txt')
  assert.equal(unquotePath('"tab\\there"'), 'tab\there')
  assert.equal(unquotePath('plain.txt'), 'plain.txt')
  const files = parsePatch(
    lines(
      'diff --git "a/\\344\\270\\255\\346\\226\\207 \\345\\220\\215.txt" "b/\\344\\270\\255\\346\\226\\207 \\345\\220\\215.txt"',
      'index 74088ef..0000000 100644',
      '--- "a/\\344\\270\\255\\346\\226\\207 \\345\\220\\215.txt"',
      '+++ "b/\\344\\270\\255\\346\\226\\207 \\345\\220\\215.txt"',
      '@@ -1 +1,2 @@',
      ' 中',
      '+文',
      'diff --git a/with space.bin b/with space.bin',
      'index 1111111..2222222 100644',
      'Binary files a/with space.bin and b/with space.bin differ',
      'diff --git a/a b/c.txt b/a b/c.txt',
      'old mode 100644',
      'new mode 100755',
    ),
  )
  assert.deepEqual(
    files.map((file) => file.path),
    ['中文 名.txt', 'with space.bin', 'a b/c.txt'],
  )
})

test('没有 diff --git 那一行的朴素写法也认：一对 ---/+++ 是一个文件', () => {
  const files = parsePatch(
    lines(
      '--- a/one.txt\t2026-10-13 08:00:00',
      '+++ b/one.txt\t2026-10-13 08:00:01',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '--- /dev/null',
      '+++ b/two.txt',
      '@@ -0,0 +1,2 @@',
      '+x',
      '+y',
    ),
  )
  assert.deepEqual(
    files.map((file) => [file.path, file.change, file.added, file.removed]),
    [
      ['one.txt', 'modify', 1, 1],
      ['two.txt', 'add', 2, 0],
    ],
  )
})

test('空的输入没有文件；只有文件头没有内容的（空文件）也算一个文件', () => {
  assert.deepEqual(parsePatch(''), [])
  const files = parsePatch(
    lines('diff --git a/empty.txt b/empty.txt', 'new file mode 100644', 'index 0000000..e69de29'),
  )
  assert.deepEqual(
    files.map((file) => [file.path, file.change, file.hunks.length]),
    [['empty.txt', 'add', 0]],
  )
})

const z = (...records: string[]) => `${records.join('\0')}\0`

test('status：分支、每个文件的暂存和工作区状态、改名带着原来的名字、没跟踪的', () => {
  const sha = 'a'.repeat(40)
  const none = '0'.repeat(40)
  const status = parseStatus(
    z(
      '# branch.oid eef6a5f52e8fbf2d9b2dab71b4fd37710a47c91c',
      '# branch.head main',
      `1 D. N... 100644 000000 000000 ${sha} ${none} del.txt`,
      `1 .M N... 100644 100644 100644 ${sha} ${sha} dir with space/mod.txt`,
      `2 R. N... 100644 100644 100644 ${sha} ${sha} R100 new-name.txt`,
      'old-name.txt',
      `1 A. N... 000000 100644 100644 ${none} ${sha} staged-new.txt`,
      `u UU N... 100644 100644 100644 100644 ${sha} ${sha} ${sha} both.txt`,
      '? untracked.txt',
      '? build/',
    ),
  )
  assert.equal(status.branch, 'main')
  assert.equal(status.initial, false)
  assert.deepEqual(
    status.entries.map((entry) => [entry.path, entry.kind, entry.x + entry.y, entry.from]),
    [
      ['del.txt', 'changed', 'D.', null],
      ['dir with space/mod.txt', 'changed', '.M', null],
      ['new-name.txt', 'changed', 'R.', 'old-name.txt'],
      ['staged-new.txt', 'changed', 'A.', null],
      ['both.txt', 'unmerged', 'UU', null],
      ['untracked.txt', 'untracked', '.?', null],
      ['build/', 'untracked', '.?', null],
    ],
  )
  // 新加的那个上一次提交里没有，别的有
  assert.deepEqual(
    status.entries.slice(0, 4).map((entry) => entry.inHead),
    [true, true, false, false],
  )
  const fresh = parseStatus(z('# branch.oid (initial)', '# branch.head (detached)'))
  assert.equal(fresh.initial, true)
  assert.equal(fresh.branch, null)
})

test('diff --raw --numstat：状态和行数按路径对上，改名的两头都在，二进制的没有行数', () => {
  const entries = parseRawNumstat(
    z(
      ':100644 000000 b77b4eb 0000000 D',
      'del.txt',
      ':100644 100644 0ec1772 0ec1772 R100',
      'old-name.txt',
      'new-name.txt',
      ':100644 100644 6772730 0000000 M',
      'pic.bin',
      ':100644 100755 4163036 0000000 M',
      'run.sh',
      ':100644 100644 74088ef 0000000 M',
      '中文 名.txt',
      '0\t2\tdel.txt',
      '0\t0\t',
      'old-name.txt',
      'new-name.txt',
      '-\t-\tpic.bin',
      '0\t0\trun.sh',
      '1\t0\t中文 名.txt',
    ),
  )
  assert.deepEqual(
    entries.map((entry) => [
      entry.path,
      entry.letter,
      entry.from,
      entry.added,
      entry.removed,
      entry.binary,
    ]),
    [
      ['del.txt', 'D', null, 0, 2, false],
      ['new-name.txt', 'R', 'old-name.txt', 0, 0, false],
      ['pic.bin', 'M', null, null, null, true],
      ['run.sh', 'M', null, 0, 0, false],
      ['中文 名.txt', 'M', null, 1, 0, false],
    ],
  )
  assert.deepEqual([entries[3]?.oldMode, entries[3]?.newMode], ['100644', '100755'])
})

test('git grep -c -z：路径和行数；路径里有换行也不乱', () => {
  const counts = parseGrepCounts('a.txt\x003\nsub/b c.txt\x0012\nodd\nname.txt\x001\n')
  assert.deepEqual(
    [...counts],
    [
      ['a.txt', 3],
      ['sub/b c.txt', 12],
      ['odd\nname.txt', 1],
    ],
  )
})

test('合成概况：按路径排、根在仓库的子目录里时去掉前面那一截、没跟踪的各种情形、太多时只报个数', () => {
  const sha = 'a'.repeat(40)
  const status = parseStatus(
    z(
      '# branch.oid abc',
      '# branch.head main',
      `1 MM N... 100644 100644 100644 ${sha} ${sha} pkg/src/b.ts`,
      `1 .M N... 100644 100644 100755 ${sha} ${sha} pkg/run.sh`,
      `1 .M N... 100644 100644 100644 ${sha} ${sha} other/outside.ts`,
      '? pkg/new.txt',
      '? pkg/empty.txt',
      '? pkg/blob.dat',
      '? pkg/uncounted.txt',
      '? pkg/vendor/',
      '? elsewhere.txt',
    ),
  )
  const raw = parseRawNumstat(
    z(
      ':100644 100644 1111111 0000000 M',
      'src/b.ts',
      ':100644 100755 2222222 0000000 M',
      'run.sh',
      '4\t1\tsrc/b.ts',
      '0\t0\trun.sh',
    ),
  )
  const input = {
    scope: 'all' as const,
    prefix: 'pkg/',
    status,
    raw,
    untracked: {
      lines: new Map([['new.txt', 7]]),
      binary: new Set(['blob.dat']),
      counted: new Set(['new.txt', 'empty.txt', 'blob.dat']),
    },
    limit: 100,
  }
  const { entries, omitted } = summarize(input)
  assert.equal(omitted, 0)
  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.status, entry.added, entry.removed]),
    [
      ['blob.dat', 'untracked', null, null],
      ['empty.txt', 'untracked', 0, 0],
      ['new.txt', 'untracked', 7, 0],
      ['run.sh', 'modified', 0, 0],
      ['src/b.ts', 'modified', 4, 1],
      ['uncounted.txt', 'untracked', null, null],
      ['vendor', 'untracked', null, null],
    ],
  )
  const by = Object.fromEntries(entries.map((entry) => [entry.path, entry]))
  assert.deepEqual([by['src/b.ts']?.staged, by['src/b.ts']?.unstaged], [true, true])
  assert.deepEqual([by['run.sh']?.staged, by['run.sh']?.unstaged], [false, true])
  assert.deepEqual(by['run.sh']?.mode, { from: '100644', to: '100755' })
  assert.equal(by['blob.dat']?.binary, true)
  assert.equal(by.vendor?.dir, true)
  // 已暂存的范围里没有没跟踪的
  assert.deepEqual(
    summarize({ ...input, scope: 'staged' }).entries.map((entry) => entry.path),
    ['run.sh', 'src/b.ts'],
  )
  const capped = summarize({ ...input, limit: 3 })
  assert.equal(capped.entries.length, 3)
  assert.equal(capped.omitted, 4)
})

test('还原算哪一类：按 status 现在说的；和界面上确认时看到的对不上就是文件又变了', () => {
  const entry = (fields: object) => ({
    path: 'f',
    from: null,
    kind: 'changed' as const,
    x: '.',
    y: 'M',
    inHead: true,
    ...fields,
  })
  assert.equal(discardKindOf(undefined, 'all'), 'clean')
  assert.equal(discardKindOf(entry({ kind: 'untracked', y: '?' }), 'all'), 'remove')
  assert.equal(discardKindOf(entry({ kind: 'unmerged', x: 'U', y: 'U' }), 'all'), 'conflict')
  assert.equal(discardKindOf(entry({}), 'all'), 'restore')
  assert.equal(discardKindOf(entry({ x: 'D', y: '.' }), 'all'), 'restore')
  assert.equal(discardKindOf(entry({ x: 'A', y: '.', inHead: false }), 'all'), 'remove')
  assert.equal(discardKindOf(entry({ x: 'R', y: '.', from: 'old' }), 'all'), 'rename')
  // 只看没暂存的那一半：暂存区里新加的文件，工作区里又改了，还原的是工作区的改动
  assert.equal(discardKindOf(entry({ x: 'A', y: 'M', inHead: false }), 'unstaged'), 'restore')
  assert.equal(discardKindOf(entry({ x: 'M', y: '.' }), 'unstaged'), 'clean')

  assert.equal(expectedDiscard('untracked', 'all'), 'remove')
  assert.equal(expectedDiscard('added', 'all'), 'remove')
  assert.equal(expectedDiscard('added', 'unstaged'), 'restore')
  assert.equal(expectedDiscard('modified', 'all'), 'restore')
  assert.equal(expectedDiscard('deleted', 'all'), 'restore')
  assert.equal(expectedDiscard('renamed', 'all'), 'rename')
  assert.equal(expectedDiscard('conflicted', 'all'), 'conflict')
})
