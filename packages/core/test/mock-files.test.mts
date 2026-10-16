// 模拟核心的文件面板（packages/core/src/mock/mock-files.mts、sample-files.mts）：
// 示例树里特意放的那几样边角各走一遍，和真的核心是同一条路；另外是“看文件”那句回答里的路径认得对不对。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ChannelError,
  createMockCore,
  type DirectoryView,
  type FileContent,
  type FileSearchView,
  fileRefOf,
  findFileRefs,
  MAX_TEXT_BYTES,
} from '../src/index.mjs'
import { SAMPLE_TEXT } from '../src/mock/sample-text.mjs'
import { fakeClock, settle } from './helpers.mjs'

const never = { aborted: false, addEventListener() {} }
const ROOT = '~/work/litch'

function setup(deviceId = 'local', root = ROOT) {
  const time = fakeClock()
  const core = createMockCore({ clock: time.clock, chunkMs: 0 })
  /** 发一条命令，把对面欠着的应答都放出来 */
  const run = async <T,>(name: string, params: object): Promise<T> => {
    const pending = core.command(name, { deviceId, root, ...params }, never) as Promise<T>
    let done = false
    const mark = () => {
      done = true
    }
    pending.then(mark, mark)
    for (let round = 0; round < 40 && !done; round++) {
      await settle()
      time.advance(1)
    }
    return pending
  }
  return {
    core,
    time,
    list: (path: string) => run<DirectoryView>('files.list', { path }),
    read: (path: string) => run<FileContent>('files.read', { path: `${root}/${path}` }),
    search: (query: string) => run<FileSearchView>('files.search', { query }),
    run,
  }
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('示例树：根那一层有目录、文件、隐藏的，符号链接照它指向的算；路径照界面给的写法回', async () => {
  const { list } = setup()
  const view = await list(ROOT)
  assert.equal(view.path, ROOT)
  assert.deepEqual(
    view.entries.map((entry) => `${entry.kind}:${entry.name}`),
    [
      'dir:.github',
      'dir:cmd',
      'dir:crates',
      'dir:docs',
      'dir:fixtures',
      'dir:link-to-docs',
      'dir:packages',
      'dir:scripts',
      'file:.gitignore',
      'file:AGENTS.md',
      'file:Makefile',
      'file:package.json',
      'file:README.md',
    ],
  )
  // 穿过符号链接往下列
  const linked = await list(`${ROOT}/link-to-docs`)
  assert.deepEqual(
    linked.entries.map((entry) => entry.name),
    ['images', 'guide.md', 'snippet.html'],
  )
})

test('示例树：几种语言的源文件读得出来，语言认得对；示例对话里提到的那一行就在那一行', async () => {
  const { read } = setup()
  const languages: [string, string | null][] = [
    ['cmd/codex-harness-adapter/serve.go', 'go'],
    ['packages/core/src/device/files.mts', 'typescript'],
    ['packages/ui/src/app/App.tsx', 'typescript'],
    ['packages/ui/src/styles/base.css', 'css'],
    ['scripts/build.sh', 'bash'],
    ['scripts/tool.py', 'python'],
    ['crates/pty/src/lib.rs', 'rust'],
    ['docs/guide.md', 'markdown'],
    ['package.json', 'json'],
    ['Makefile', 'makefile'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['.gitignore', null],
  ]
  for (const [path, language] of languages) {
    const content = await read(path)
    assert.equal(content.kind, 'text', path)
    assert.equal(content.kind === 'text' && content.language, language, path)
    assert.equal(content.path, `${ROOT}/${path}`)
  }
  const serve = await read('cmd/codex-harness-adapter/serve.go')
  const lines = serve.kind === 'text' ? serve.text.split('\n') : []
  assert.match(lines[130] ?? '', /listenFailure\(c\.port, err\)/)
  const guide = await read('docs/guide.md')
  assert.ok(guide.kind === 'text' && guide.text.split('\n').length > 12)
})

test('示例树：大文件、长文件、一行特别长的、不是文字的、不是 UTF-8 的、读的时候没了的', async () => {
  const { read } = setup()
  const big = await read('fixtures/big.log')
  assert.equal(big.kind, 'tooLarge')
  assert.ok(big.kind === 'tooLarge' && big.bytes > MAX_TEXT_BYTES && big.limit === MAX_TEXT_BYTES)

  const long = await read('fixtures/long.ts')
  assert.ok(long.kind === 'text' && long.text.split('\n').length > 6000)
  const minified = await read('fixtures/minified.js')
  assert.ok(minified.kind === 'text' && (minified.text.split('\n')[0] ?? '').length > 20_000)

  assert.deepEqual(await read('fixtures/blob.dat'), {
    kind: 'binary',
    path: `${ROOT}/fixtures/blob.dat`,
    group: 'binary',
    bytes: 2048,
  })
  assert.deepEqual(await read('docs/images/shot.png'), {
    kind: 'binary',
    path: `${ROOT}/docs/images/shot.png`,
    group: 'image',
    bytes: null,
  })
  const latin = await read('fixtures/latin1.txt')
  assert.ok(latin.kind === 'text' && latin.lossy)
  assert.deepEqual(await read('fixtures/gone.txt'), {
    kind: 'missing',
    path: `${ROOT}/fixtures/gone.txt`,
  })
  assert.deepEqual(await read('no/such/file.ts'), {
    kind: 'missing',
    path: `${ROOT}/no/such/file.ts`,
  })
  assert.deepEqual(await read('docs'), { kind: 'directory', path: `${ROOT}/docs` })
})

test('根之外的路径、不认识的根被拒；每个工作区的根、不属于工作区的会话的工作目录都认', async () => {
  const { list, run } = setup()
  const outside = await failureOf(list('~/work/docs-site/README.md'))
  assert.deepEqual([outside.code, outside.text?.key], ['rejected', 'files.outside'])
  const escaped = await failureOf(list(`${ROOT}/../../.ssh`))
  assert.deepEqual([escaped.code, escaped.text?.key], ['rejected', 'files.outside'])
  const unknown = await failureOf(run('files.list', { root: '~/.ssh', path: '~/.ssh' }))
  assert.deepEqual([unknown.code, unknown.text?.key], ['rejected', 'files.unknownRoot'])

  const docs = await run<DirectoryView>('files.list', {
    root: '~/work/docs-site',
    path: '~/work/docs-site/docs',
  })
  assert.equal(docs.path, '~/work/docs-site/docs')
  // s9 不属于任何工作区，它的工作目录是完整路径：结果里也照这种写法
  const loose = await run<DirectoryView>('files.list', {
    root: '/Users/dev/notes/launchd',
    path: '/Users/dev/notes/launchd/docs',
  })
  assert.equal(loose.path, '/Users/dev/notes/launchd/docs')
})

test('找文件：模糊对上的排在前面，带着对上了哪几个字；最多五十条', async () => {
  const { search } = setup()
  const found = await search('servego')
  assert.equal(found.query, 'servego')
  assert.deepEqual(found.matches[0], {
    path: `${ROOT}/cmd/codex-harness-adapter/serve.go`,
    relative: 'cmd/codex-harness-adapter/serve.go',
    kind: 'file',
    indices: [26, 27, 28, 29, 30, 32, 33],
  })
  // 没加载过的目录里的也找得到：找的是整棵树，不是界面上展开了的那些
  const deep = await search('item-12345')
  assert.equal(deep.matches[0]?.relative, 'fixtures/many/item-12345.txt')
  assert.equal((await search('e')).matches.length, 50)
  assert.deepEqual(await search('zzzzqqqq'), { query: 'zzzzqqqq', matches: [] })
  assert.deepEqual(await search('   '), { query: '', matches: [] })
})

test('两台示例设备各缺一样：nas 不提供文件访问，build 只是不提供找文件；没连上的是 offline', async () => {
  const nas = setup('nas', '~/backup-scripts')
  const denied = await failureOf(nas.list('~/backup-scripts'))
  assert.deepEqual([denied.code, denied.text?.key], ['unsupported', 'files.unsupported'])
  assert.equal((await failureOf(nas.read('README.md'))).code, 'unsupported')

  const build = setup('build', '/srv/work/litch')
  assert.equal((await build.list('/srv/work/litch')).entries.length, 13)
  assert.equal((await build.read('README.md')).kind, 'text')
  const blind = await failureOf(build.search('readme'))
  assert.deepEqual([blind.code, blind.text?.key], ['unsupported', 'files.searchUnsupported'])

  const gpu = setup('gpu', '~/train-lab')
  assert.equal((await failureOf(gpu.list('~/train-lab'))).code, 'offline')
  const nowhere = await failureOf(
    setup().core.command('files.list', { deviceId: 'ghost', root: ROOT, path: ROOT }, never),
  )
  assert.equal(nowhere.code, 'notFound')
})

test('“看文件”的回答：该认的路径都认出来、都在示例树里；不该认的一个都不认', async () => {
  for (const lang of ['zh-CN', 'en'] as const) {
    const { read } = setup()
    const scope = { root: ROOT, cwd: ROOT }
    const text = SAMPLE_TEXT[lang].filesReply
    // 行内代码和链接的地址：整段拿去认
    const pieces = [...text.matchAll(/`([^`]+)`|\]\(([^)]+)\)/g)].map((m) => m[1] ?? m[2] ?? '')
    const refs = pieces.map((piece) => [piece, fileRefOf(piece, scope)] as const)
    assert.deepEqual(
      refs.map(([piece, ref]) => [piece, ref ? [ref.path.slice(ROOT.length + 1), ref.line] : null]),
      [
        ['cmd/codex-harness-adapter/serve.go:131', ['cmd/codex-harness-adapter/serve.go', 131]],
        ['docs/guide.md#L12', ['docs/guide.md', 12]],
        ['README.md', ['README.md', null]],
        ['packages/ui/src/app/App.tsx', ['packages/ui/src/app/App.tsx', null]],
        ['fixtures/long.ts:4200', ['fixtures/long.ts', 4200]],
        ['console.log', null],
        ['../outside/secret.txt', null],
      ],
    )
    // 正文里扫出来的：去掉行内代码和链接之后只剩一个
    const prose = text.replace(/`[^`]+`|\[[^\]]*\]\([^)]+\)/g, ' ')
    assert.deepEqual(
      findFileRefs(prose, scope).map((span) => [span.ref.path, span.ref.line]),
      [[`${ROOT}/packages/core/src/device/files.mts`, 40]],
    )
    for (const [piece, ref] of refs) {
      if (!ref) continue
      const content = await read(ref.path.slice(ROOT.length + 1))
      assert.equal(content.kind, 'text', piece)
      const count = content.kind === 'text' ? content.text.split('\n').length : 0
      assert.ok(ref.line === null || ref.line <= count, `${piece} 的行号在文件里`)
    }
  }
})
