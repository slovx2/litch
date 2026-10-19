// 文件面板的几样纯函数：路径运算（text/paths.mts）、目录与文件内容的投影和摊平（projection/files.mts）、
// 上色片段按行切开（text/spans.mts）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  baseName,
  encodeBase64,
  extensionOf,
  flattenTree,
  insideRoot,
  isAbsolutePath,
  joinPath,
  languageOf,
  MAX_ENTRIES,
  MAX_TEXT_BYTES,
  normalizePath,
  noTwin,
  parentPath,
  pathTwin,
  privateTwin,
  projectDirectory,
  projectFile,
  relativeTo,
  samePath,
  splitSpanLines,
  type TreeListing,
  textToBase64,
  unreadableGroup,
  withinRoot,
} from '../src/index.mjs'

test('路径：理成最简，.. 折不出绝对路径的根，相对路径和 ~ 折到头了照样留着', () => {
  assert.equal(normalizePath('/work//app/./src/../README.md/'), '/work/app/README.md')
  assert.equal(normalizePath('/work/app/../../../etc/passwd'), '/etc/passwd')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath('a/../../b'), '../b')
  assert.equal(normalizePath('~/work/../..'), '~/..')
  assert.equal(joinPath('/work/app', 'src/index.ts'), '/work/app/src/index.ts')
  assert.equal(joinPath('/work/app', '../other/x.ts'), '/work/other/x.ts')
  assert.equal(joinPath('/work/app', '/etc/hosts'), '/etc/hosts')
  assert.equal(joinPath('/work/app', '~/notes.md'), '~/notes.md')
})

test('路径：在不在根里只看整段，名字开头一样的兄弟目录不算', () => {
  assert.equal(insideRoot('/work/app', '/work/app'), true)
  assert.equal(insideRoot('/work/app', '/work/app/src/a.ts'), true)
  assert.equal(insideRoot('/work/app', '/work/app-secrets/key'), false)
  assert.equal(insideRoot('/work/app', '/work'), false)
  assert.equal(insideRoot('/', '/etc/hosts'), true)
  assert.equal(relativeTo('/work/app', '/work/app/src/a.ts'), 'src/a.ts')
  assert.equal(relativeTo('/work/app', '/work/app'), '')
  assert.equal(relativeTo('/', '/etc/hosts'), 'etc/hosts')
  assert.equal(relativeTo('/work/app', '/elsewhere/a.ts'), '/elsewhere/a.ts')
})

test('路径：macOS 上 /var、/tmp、/etc 和 /private 下的同名目录是一处，按设备的系统认；认出来的换成根的写法', () => {
  // 另一种写法只有这三处，两个方向都给；别的（/private 自己、/variable、/usr）没有
  assert.equal(privateTwin('/private/var/folders/x/T/tri/a.txt'), '/var/folders/x/T/tri/a.txt')
  assert.equal(privateTwin('/var/folders/x'), '/private/var/folders/x')
  assert.equal(privateTwin('/private/tmp'), '/tmp')
  assert.equal(privateTwin('/tmp/w'), '/private/tmp/w')
  assert.equal(privateTwin('/etc/hosts'), '/private/etc/hosts')
  for (const path of [
    '/private',
    '/private/varx/a',
    '/variable/a',
    '/usr/tmp',
    '/tmpdir',
    'var/a',
  ]) {
    assert.equal(privateTwin(path), null, path)
  }
  // macOS 和还不知道的认，确定是别的系统的不认
  assert.equal(pathTwin('macos'), privateTwin)
  assert.equal(pathTwin(null), privateTwin)
  assert.equal(pathTwin(undefined), privateTwin)
  assert.equal(pathTwin('linux'), noTwin)
  assert.equal(pathTwin('windows'), noTwin)

  const root = '/var/folders/x/T/tri'
  const real = '/private/var/folders/x/T/tri'
  // 根是用户给的写法，harness 报的是解开链接之后的：在里面，换成根的写法
  assert.equal(withinRoot(root, `${real}/a.txt`, privateTwin), `${root}/a.txt`)
  assert.equal(withinRoot(root, real, privateTwin), root)
  assert.equal(insideRoot(root, `${real}/sub/b.ts`, privateTwin), true)
  assert.equal(relativeTo(root, `${real}/sub/b.ts`, privateTwin), 'sub/b.ts')
  assert.equal(relativeTo(root, real, privateTwin), '')
  // 反过来也一样
  assert.equal(withinRoot(real, `${root}/a.txt`, privateTwin), `${real}/a.txt`)
  assert.equal(relativeTo(real, `${root}/a.txt`, privateTwin), 'a.txt')
  assert.equal(withinRoot('/tmp/w', '/private/tmp/w/x', privateTwin), '/tmp/w/x')
  // 字面上就在里面的原样给
  assert.equal(withinRoot(root, `${root}/a.txt`, privateTwin), `${root}/a.txt`)
  // 兄弟目录、根外面的照样不算
  assert.equal(withinRoot(root, '/private/var/folders/x/T/trio/a', privateTwin), null)
  assert.equal(withinRoot(root, '/private/etc/hosts', privateTwin), null)
  assert.equal(relativeTo(root, '/private/etc/hosts', privateTwin), '/private/etc/hosts')
  // 不给（或者设备是 Linux）就只比字面：和以前一样
  assert.equal(withinRoot(root, `${real}/a.txt`), null)
  assert.equal(insideRoot(root, `${real}/a.txt`, pathTwin('linux')), false)
  assert.equal(relativeTo(root, `${real}/a.txt`, noTwin), `${real}/a.txt`)
})

test('路径：Windows 的盘符开头的理成 C:/…，反斜杠当分隔符，盘符大写，.. 折不出盘符的根', () => {
  assert.equal(normalizePath('c:\\Work\\App\\.\\src\\..\\README.md\\'), 'C:/Work/App/README.md')
  assert.equal(normalizePath('C:/Work//App/'), 'C:/Work/App')
  assert.equal(normalizePath('C:\\..\\..\\Windows'), 'C:/Windows')
  assert.equal(normalizePath('D:'), 'D:/')
  assert.equal(normalizePath('D:\\'), 'D:/')
  // 不是盘符开头的照旧：反斜杠在 POSIX 上是名字里的字
  assert.equal(normalizePath('/work/a\\b'), '/work/a\\b')
  assert.equal(normalizePath('C:relative'), 'C:relative')
  assert.equal(isAbsolutePath('C:\\a'), true)
  assert.equal(isAbsolutePath('c:/a'), true)
  assert.equal(isAbsolutePath('C:'), true)
  assert.equal(isAbsolutePath('C:a'), false)
  assert.equal(isAbsolutePath('src\\a.ts'), false)
  assert.equal(joinPath('C:/Work/App', 'src\\a.ts'), 'C:/Work/App/src/a.ts')
  assert.equal(joinPath('C:/Work/App', 'D:\\x'), 'D:/x')
  assert.equal(joinPath('C:/', 'a'), 'C:/a')
  assert.equal(samePath('C:\\Work\\App\\', 'c:/work/app'), true)
  assert.equal(samePath('/work/App', '/work/app'), false)
  assert.equal(samePath('/work/app/', '/work//app'), true)
})

test('路径：Windows 的根不分大小写，认出来的照根的写法；兄弟目录、别的盘不算；盘符的根和上一级', () => {
  const root = 'C:/Users/Me/App'
  assert.equal(withinRoot(root, 'c:/users/me/app/src/A.ts'), 'C:/Users/Me/App/src/A.ts')
  assert.equal(withinRoot(root, 'C:/USERS/ME/APP'), root)
  assert.equal(withinRoot(root, 'C:/Users/Me/Apple/a.ts'), null)
  assert.equal(withinRoot(root, 'D:/Users/Me/App/a.ts'), null)
  assert.equal(withinRoot(root, '/Users/Me/App/a.ts'), null)
  assert.equal(relativeTo(root, 'c:/users/me/app/src/a.ts'), 'src/a.ts')
  assert.equal(relativeTo(root, 'C:/users/me/APP'), '')
  // POSIX 的根照旧分大小写
  assert.equal(withinRoot('/work/App', '/work/app/a'), null)
  assert.equal(withinRoot('C:/', 'c:/x/y'), 'C:/x/y')
  assert.equal(relativeTo('C:/', 'C:/x/y'), 'x/y')
  assert.equal(insideRoot('C:/', 'D:/x'), false)
  assert.equal(parentPath('C:/a/b'), 'C:/a')
  assert.equal(parentPath('C:/a'), 'C:/')
  assert.equal(parentPath('C:/'), null)
  assert.equal(baseName('C:/a/b.ts'), 'b.ts')
})

test('路径：文件名、上一级、扩展名', () => {
  assert.equal(baseName('/work/app/src/a.test.ts'), 'a.test.ts')
  assert.equal(parentPath('/work/app'), '/work')
  assert.equal(parentPath('/work'), '/')
  assert.equal(parentPath('/'), null)
  assert.equal(parentPath('README.md'), null)
  assert.equal(extensionOf('/work/app/src/A.Test.TS'), 'ts')
  assert.equal(extensionOf('.gitignore'), '')
  assert.equal(extensionOf('Makefile'), '')
  assert.equal(extensionOf('/a.b/c'), '')
})

test('一层目录：目录在前，同类按名字不分大小写排；来路不明的条目不要', () => {
  const view = projectDirectory('/work/app', [
    { fileName: 'zeta.ts', isDirectory: false, isFile: true },
    { fileName: 'src', isDirectory: true, isFile: false },
    { fileName: 'Alpha.md', isDirectory: false, isFile: true },
    { fileName: '.github', isDirectory: true, isFile: false },
    { fileName: 'link', isDirectory: false, isFile: false },
    { fileName: 'beta.md', isDirectory: false, isFile: true },
    { fileName: 'Docs', isDirectory: true, isFile: false },
    // 下面这些都不该出现在结果里
    { fileName: '', isDirectory: false, isFile: true },
    { fileName: '..', isDirectory: true, isFile: false },
    { fileName: 'a/b', isDirectory: false, isFile: true },
    { fileName: 7 as unknown as string, isDirectory: false, isFile: true },
  ])
  assert.equal(view.path, '/work/app')
  assert.equal(view.total, 7)
  assert.deepEqual(
    view.entries.map((entry) => `${entry.kind}:${entry.name}`),
    [
      'dir:.github',
      'dir:Docs',
      'dir:src',
      'file:Alpha.md',
      'file:beta.md',
      'other:link',
      'file:zeta.ts',
    ],
  )
})

test('一层目录：太多的只留前面的，total 是实际有多少', () => {
  const entries = Array.from({ length: MAX_ENTRIES + 25 }, (_, n) => ({
    fileName: `f${String(n).padStart(6, '0')}.txt`,
    isDirectory: false,
    isFile: true,
  }))
  const view = projectDirectory('/big', entries)
  assert.equal(view.entries.length, MAX_ENTRIES)
  assert.equal(view.total, MAX_ENTRIES + 25)
  assert.equal(view.entries[0]?.name, 'f000000.txt')
})

test('语言和不读的类型：看扩展名和几个不带扩展名的名字', () => {
  assert.equal(languageOf('/a/b/main.go'), 'go')
  assert.equal(languageOf('/a/App.TSX'), 'typescript')
  assert.equal(languageOf('/a/Makefile'), 'makefile')
  assert.equal(languageOf('/a/notes.txt'), null)
  assert.equal(languageOf('/a/.gitignore'), null)
  assert.equal(unreadableGroup('/a/shot.PNG'), 'image')
  assert.equal(unreadableGroup('/a/pack.tar.gz'), 'archive')
  assert.equal(unreadableGroup('/a/tool.wasm'), 'executable')
  assert.equal(unreadableGroup('/a/main.go'), null)
  // .key 可能是文字的密钥文件，不按文档类挡掉
  assert.equal(unreadableGroup('/a/server.key'), null)
})

test('读回来的内容：文字去掉字节序标记、换行统一；语言跟着扩展名', () => {
  const content = projectFile('/a/x.ts', textToBase64('\uFEFFconst a = 1\r\nconst b = "好"\rend\n'))
  assert.deepEqual(content, {
    kind: 'text',
    path: '/a/x.ts',
    text: 'const a = 1\nconst b = "好"\nend\n',
    bytes: 36,
    language: 'typescript',
    lossy: false,
  })
  const empty = projectFile('/a/empty.txt', '')
  assert.deepEqual(empty, {
    kind: 'text',
    path: '/a/empty.txt',
    text: '',
    bytes: 0,
    language: null,
    lossy: false,
  })
})

test('读回来的内容：不是 UTF-8 的照样显示，标明有认不出的字节；带零字节的不是文字', () => {
  const latin = projectFile(
    '/a/old.txt',
    encodeBase64(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])),
  )
  assert.equal(latin.kind, 'text')
  assert.equal(latin.kind === 'text' && latin.lossy, true)
  assert.equal(latin.kind === 'text' && latin.text, 'caf�\n')

  const blob = projectFile(
    '/a/data',
    encodeBase64(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2])),
  )
  assert.deepEqual(blob, { kind: 'binary', path: '/a/data', group: 'binary', bytes: 7 })
})

test('读回来的内容：超过上限的只说多大，不去解', () => {
  // 不用真的造几兆的数据：字节数是按 base64 的长度算的
  const big = 'A'.repeat(Math.ceil(((MAX_TEXT_BYTES + 3) * 4) / 3 / 4) * 4)
  const content = projectFile('/a/big.log', big)
  assert.equal(content.kind, 'tooLarge')
  assert.equal(content.kind === 'tooLarge' && content.limit, MAX_TEXT_BYTES)
  assert.ok(content.kind === 'tooLarge' && content.bytes > MAX_TEXT_BYTES)
})

const ready = (path: string, names: [name: string, kind: 'dir' | 'file'][]): TreeListing => ({
  state: 'ready',
  view: { path, entries: names.map(([name, kind]) => ({ name, kind })), total: names.length },
  error: null,
})

test('摊平：展开着的目录下面接它的内容，没展开的不接；隐藏的看开关', () => {
  const listings = new Map<string, TreeListing>([
    [
      '/r',
      ready('/r', [
        ['.git', 'dir'],
        ['src', 'dir'],
        ['test', 'dir'],
        ['.env', 'file'],
        ['a.ts', 'file'],
      ]),
    ],
    [
      '/r/src',
      ready('/r/src', [
        ['deep', 'dir'],
        ['index.ts', 'file'],
      ]),
    ],
    ['/r/src/deep', ready('/r/src/deep', [])],
    ['/r/test', ready('/r/test', [['t.ts', 'file']])],
  ])
  const shape = (rows: ReturnType<typeof flattenTree>) =>
    rows.map(
      (row) =>
        `${'  '.repeat(row.depth)}${row.kind}:${row.name || row.path}${row.expanded ? '*' : ''}`,
    )

  assert.deepEqual(shape(flattenTree('/r', listings, new Set(['/r/src', '/r/src/deep']), false)), [
    'dir:src*',
    '  dir:deep*',
    '    empty:/r/src/deep',
    '  file:index.ts',
    'dir:test',
    'file:a.ts',
  ])
  assert.deepEqual(shape(flattenTree('/r', listings, new Set(), true)), [
    'dir:.git',
    'dir:src',
    'dir:test',
    'file:.env',
    'file:a.ts',
  ])
})

test('摊平：还没取到的是“正在取”，没取到的带着错误，被截掉的说明少了多少；行的标识不重复', () => {
  const failure = { code: 'remote' as const, message: 'EACCES' }
  const listings = new Map<string, TreeListing>([
    [
      '/r',
      ready('/r', [
        ['a', 'dir'],
        ['b', 'dir'],
        ['c', 'dir'],
        ['.hidden', 'file'],
      ]),
    ],
    ['/r/b', { state: 'failed', view: null, error: failure }],
    [
      '/r/c',
      {
        state: 'ready',
        view: { path: '/r/c', entries: [{ name: 'x', kind: 'file' }], total: 9 },
        error: null,
      },
    ],
  ])
  const rows = flattenTree('/r', listings, new Set(['/r/a', '/r/b', '/r/c']), false)
  assert.deepEqual(
    rows.map((row) => [row.depth, row.kind, row.path]),
    [
      [0, 'dir', '/r/a'],
      [1, 'loading', '/r/a'],
      [0, 'dir', '/r/b'],
      [1, 'failed', '/r/b'],
      [0, 'dir', '/r/c'],
      [1, 'file', '/r/c/x'],
      [1, 'truncated', '/r/c'],
    ],
  )
  assert.deepEqual(rows[3]?.note, { kind: 'failed', error: failure })
  assert.deepEqual(rows[6]?.note, { kind: 'truncated', hidden: 8 })
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length)

  // 根还没取到：只有一行“正在取”；根里只有隐藏的：一行“空的”
  assert.deepEqual(
    flattenTree('/r', new Map(), new Set(), false).map((row) => row.kind),
    ['loading'],
  )
  assert.deepEqual(
    flattenTree('/r', new Map([['/r', ready('/r', [['.env', 'file']])]]), new Set(), false).map(
      (row) => row.kind,
    ),
    ['empty'],
  )
})

test('上色片段按行切开：跨行的片段在每一行里重开，空行也占一行', () => {
  const lines = splitSpanLines([
    'a ',
    { cls: 'comment', children: ['/* x\n', { cls: 'doctag', children: ['@y'] }, '\n\nz */'] },
    ' b\n',
  ])
  assert.deepEqual(lines, [
    ['a ', { cls: 'comment', children: ['/* x'] }],
    [{ cls: 'comment', children: [{ cls: 'doctag', children: ['@y'] }] }],
    [{ cls: 'comment', children: [] }],
    [{ cls: 'comment', children: ['z */'] }, ' b'],
    [],
  ])
  assert.deepEqual(splitSpanLines([]), [[]])
  assert.deepEqual(splitSpanLines(['one']), [['one']])
})
