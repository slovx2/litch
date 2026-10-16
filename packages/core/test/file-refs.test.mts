// 对话里哪些字是工作区里的文件路径（projection/file-refs.mts）。规矩是“认不准的宁可不认”。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type FileScope,
  fileRefOf,
  findFileRefs,
  knownFileRef,
  pathTwin,
  privateTwin,
} from '../src/index.mjs'

const scope: FileScope = { root: '/work/app', cwd: '/work/app' }

test('整段是路径：相对的按工作目录接，行号有几种写法', () => {
  assert.deepEqual(fileRefOf('src/index.ts', scope), {
    path: '/work/app/src/index.ts',
    alt: null,
    line: null,
  })
  assert.deepEqual(fileRefOf('./src/index.ts:42', scope), {
    path: '/work/app/src/index.ts',
    alt: null,
    line: 42,
  })
  for (const tail of [':131:7', ':131-140', '#L131', '#L131-L140', '#L131C4']) {
    assert.equal(fileRefOf(`cmd/serve.go${tail}`, scope)?.line, 131, tail)
    assert.equal(fileRefOf(`cmd/serve.go${tail}`, scope)?.path, '/work/app/cmd/serve.go', tail)
  }
  // 行号写成 0 的不当行号用，路径照认
  assert.deepEqual(fileRefOf('src/a.ts:0', scope), {
    path: '/work/app/src/a.ts',
    alt: null,
    line: null,
  })
})

test('整段是路径：绝对的要在根之内；光一个文件名只认常见的扩展名和几个名字', () => {
  assert.equal(fileRefOf('/work/app/docs/guide.md', scope)?.path, '/work/app/docs/guide.md')
  assert.equal(fileRefOf('README.md', scope)?.path, '/work/app/README.md')
  assert.equal(fileRefOf('Makefile', scope)?.path, '/work/app/Makefile')
  assert.equal(fileRefOf('config/.env', scope)?.path, '/work/app/config/.env')
  assert.equal(
    fileRefOf('.github/workflows/ci.yml', scope)?.path,
    '/work/app/.github/workflows/ci.yml',
  )
  // 带目录的，扩展名不常见也认（行内代码里整段就是它）
  assert.equal(fileRefOf('assets/logo.xcf', scope)?.path, '/work/app/assets/logo.xcf')
})

test('不认的：根之外的、目录、网址和域名、属性访问、带空白和通配的', () => {
  for (const raw of [
    '/etc/passwd',
    '../outside/secret.txt',
    '/work/app-secrets/key.txt',
    '/work/app',
    'src/',
    'src/components',
    'packages',
    'https://example.com/a/b.ts',
    'example.com/a/b.ts',
    'github.com/acme/tool/main.go',
    'console.log',
    'a.b',
    // 光一个以点开头的名字不认：行内代码里更常见的是 `.then`、`.map` 这类
    '.then',
    '.gitignore',
    'e.g.',
    'v1.2.3',
    '1.5',
    'src/my file.ts',
    'src/*.ts',
    'src//index.ts',
    '--flag=a/b.ts',
    'application/json',
    'and/or',
    'x',
    '',
  ]) {
    assert.equal(fileRefOf(raw, scope), null, raw)
  }
  assert.equal(fileRefOf('src/index.ts', { root: '', cwd: '' }), null)
})

test('工作目录不是根：相对路径先按工作目录接，另一种读法（按根接）也带上', () => {
  const nested: FileScope = { root: '/work/app', cwd: '/work/app/packages/ui' }
  assert.deepEqual(fileRefOf('src/App.tsx:9', nested), {
    path: '/work/app/packages/ui/src/App.tsx',
    alt: '/work/app/src/App.tsx',
    line: 9,
  })
  // 往上走出了工作目录、还在根里的照认
  assert.deepEqual(fileRefOf('../core/src/index.mts', nested), {
    path: '/work/app/packages/core/src/index.mts',
    alt: null,
    line: null,
  })
  // 按工作目录接出了根，按根接还在里面：用后一种
  const outside: FileScope = { root: '/work/app', cwd: '/elsewhere' }
  assert.deepEqual(fileRefOf('src/a.ts', outside), {
    path: '/work/app/src/a.ts',
    alt: null,
    line: null,
  })
})

test('以 ~ 开头的根（示例数据里的写法）：路径照样认', () => {
  const home: FileScope = { root: '~/work/litch', cwd: '~/work/litch' }
  assert.equal(fileRefOf('docs/guide.md#L12', home)?.path, '~/work/litch/docs/guide.md')
  assert.equal(fileRefOf('~/work/litch/README.md', home)?.path, '~/work/litch/README.md')
  assert.equal(fileRefOf('~/other/README.md', home), null)
  assert.equal(fileRefOf('../../../etc/passwd', home), null)
})

test('正文里扫路径：要有目录分隔，扩展名常见或者带行号；位置能直接拿去切字符串', () => {
  const text =
    '入口在 cmd/serve.go:131，说明见 docs/guide.md。另见（packages/core/src/index.mts）和 src/weird.xyz:7.'
  const spans = findFileRefs(text, scope)
  assert.deepEqual(
    spans.map((span) => [text.slice(span.start, span.end), span.ref.path, span.ref.line]),
    [
      ['cmd/serve.go:131', '/work/app/cmd/serve.go', 131],
      ['docs/guide.md', '/work/app/docs/guide.md', null],
      ['packages/core/src/index.mts', '/work/app/packages/core/src/index.mts', null],
      ['src/weird.xyz:7', '/work/app/src/weird.xyz', 7],
    ],
  )
})

test('正文里不认的：光一个文件名、网址、扩展名不常见又没行号的、读/写这类斜杠', () => {
  for (const text of [
    '看一下 README.md 和 package.json 就行',
    '文档在 https://example.com/docs/guide.md 上',
    '打开 example.com/a/b.ts 看看',
    '读/写都要权限，and/or 也一样',
    '图在 assets/logo.xcf 里',
    '版本 1.2/1.3 都行',
    '路径 ../outside/a.ts 在外面',
    '没有斜杠的一句话',
  ]) {
    assert.deepEqual(findFileRefs(text, scope), [], text)
  }
})

test('明知是文件的路径（工具改动的文件）：不看像不像，只看在不在根之内', () => {
  const nested: FileScope = { root: '/work/app', cwd: '/work/app/packages/ui' }
  assert.deepEqual(knownFileRef('src/weird-name', nested), {
    path: '/work/app/packages/ui/src/weird-name',
    alt: null,
    line: null,
  })
  assert.equal(knownFileRef('/work/app/LICENSE', scope)?.path, '/work/app/LICENSE')
  assert.equal(knownFileRef('/etc/hosts', scope), null)
  assert.equal(knownFileRef('../../outside.txt', scope), null)
  assert.equal(knownFileRef('C:\\work\\a.ts', scope), null)
  assert.equal(knownFileRef('', scope), null)
  assert.equal(knownFileRef('.', scope), null)
})

test('macOS 上根的另一种写法（Claude Code 给的是 /private/var/…，根是 /var/…）：照样认，路径换成根的写法', () => {
  const root = '/var/folders/x/T/work/tri'
  const real = `/private${root}`
  const mac: FileScope = { root, cwd: root, twin: privateTwin }
  // 工具改动的文件：“改了文件”那一条上的路径能点开，点了去的是根的写法
  assert.deepEqual(knownFileRef(`${real}/agent-written.claude-code.txt`, mac), {
    path: `${root}/agent-written.claude-code.txt`,
    alt: null,
    line: null,
  })
  assert.equal(knownFileRef(real, mac), null)
  // 回答里写的完整路径、正文里扫到的
  assert.deepEqual(fileRefOf(`${real}/src/app.ts:12`, mac), {
    path: `${root}/src/app.ts`,
    alt: null,
    line: 12,
  })
  assert.deepEqual(
    findFileRefs(`改在 ${real}/src/app.ts 里`, mac).map((span) => span.ref.path),
    [`${root}/src/app.ts`],
  )
  // 工作目录是另一种写法、给的是相对路径：一样落在根里
  const away: FileScope = { root, cwd: `${real}/src`, twin: privateTwin }
  assert.deepEqual(fileRefOf('app.ts', away), {
    path: `${root}/src/app.ts`,
    alt: `${root}/app.ts`,
    line: null,
  })
  // 设备是 Linux、或者没给：只比字面，不认
  for (const twin of [pathTwin('linux'), undefined]) {
    const plain: FileScope = { root, cwd: root, ...(twin ? { twin } : {}) }
    assert.equal(knownFileRef(`${real}/a.txt`, plain), null)
    assert.equal(fileRefOf(`${real}/src/app.ts`, plain), null)
  }
})
