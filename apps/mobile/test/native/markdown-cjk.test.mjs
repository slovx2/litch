// 同一语料分别通过手机原生 C++ 核心和网页 WASM，不用模型、模拟器或个人配置。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { linkify } from '../../src/detail/links.ts'

const dependency = fileURLToPath(
  new URL('../../node_modules/react-native-enriched-markdown/', import.meta.url),
)
const cpp = join(dependency, 'cpp')
const work = mkdtempSync(join(tmpdir(), 'litch-markdown-test-'))
after(() => rmSync(work, { recursive: true, force: true }))
const binary = join(work, 'parser')
const object = join(work, 'md4c.o')
execFileSync(process.env.CC ?? 'cc', ['-O2', '-c', join(cpp, 'md4c/md4c.c'), '-o', object])
execFileSync(process.env.CXX ?? 'c++', [
  '-std=c++17',
  '-O2',
  '-I',
  cpp,
  fileURLToPath(new URL('../fixtures/markdown-parser.cpp', import.meta.url)),
  join(cpp, 'parser/MD4CParser.cpp'),
  join(cpp, 'wasm/ASTSerializer.cpp'),
  object,
  '-o',
  binary,
])

const context = {
  module: { exports: {} },
  exports: {},
  WebAssembly,
  TextDecoder,
  TextEncoder,
  atob,
  console,
}
runInNewContext(
  readFileSync(join(dependency, 'lib/module/web/wasm/md4c-litch.js'), 'utf8'),
  context,
)
const wasm = await context.module.exports()
const parseWasm = wasm.cwrap('parseMarkdown', 'string', ['string', ...Array(8).fill('number')])
const parseNative = (source) =>
  JSON.parse(execFileSync(binary, [], { input: source, encoding: 'utf8' }))
const parseWeb = (source) => JSON.parse(parseWasm(source, 0, 1, 0, 0, 0, 0, 0, 1))
const nodes = (root) => [root, ...(root.children ?? []).flatMap(nodes)]
const content = (root) => root.content ?? (root.children ?? []).map(content).join('')
const kinds = {
  strong: 'Strong',
  em: 'Emphasis',
  del: 'Strikethrough',
  code: 'CodeBlock',
  codespan: 'Code',
  link: 'Link',
}
const cases = JSON.parse(
  readFileSync(new URL('../../../../packages/ui/test/fixtures/cjk-emphasis.json', import.meta.url)),
)

test('网页 WASM 必须由当前原生源码构建，两入口产物一致', () => {
  const patch = readFileSync(
    new URL('../../patches/react-native-enriched-markdown+1.1.0.patch', import.meta.url),
    'utf8',
  )
  assert.ok(
    !patch.includes('Binary files '),
    'patch-package 不会应用二进制差异，WASM 必须使用 base64 文本',
  )
  const manifest = JSON.parse(
    readFileSync(new URL('../fixtures/markdown-wasm.json', import.meta.url)),
  )
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  assert.equal(
    JSON.parse(readFileSync(join(dependency, 'package.json'))).version,
    manifest.dependency,
  )
  const cjk = JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/ui/node_modules/marked-cjk-friendly/package.json',
        import.meta.url,
      ),
    ),
  )
  assert.equal(cjk.version, manifest.cjkExtension, '升级桌面 CJK 扩展时需要同时审查手机补丁')
  for (const [path, expected] of Object.entries(manifest.sources))
    assert.equal(hash(join(cpp, path)), expected, path)
  for (const dir of ['src', 'lib/module'])
    assert.equal(hash(join(dependency, dir, 'web/wasm/md4c-litch.js')), manifest.wasm)
  for (const [dir, extension] of [
    ['src', 'ts'],
    ['lib/module', 'js'],
  ]) {
    assert.ok(
      readFileSync(join(dependency, dir, `web/parseMarkdown.${extension}`), 'utf8').includes(
        "import('./wasm/md4c-litch')",
      ),
    )
  }
})

for (const { source, kind, text, href, count = 1 } of cases) {
  test(`原生与网页中文强调：${source}`, () => {
    // 正式回答在进入 Markdown 组件前也调用 linkify，将裸网址变成自动链接。
    const input = linkify(source, null)
    const root = parseNative(input)
    assert.deepEqual(parseWeb(input), root)
    const all = nodes(root)
    if (kind === 'text') {
      assert.equal(content(root), text)
      assert.ok(!all.some((node) => ['Strong', 'Emphasis', 'Strikethrough'].includes(node.type)))
    } else {
      const matches = all.filter((node) => node.type === kinds[kind])
      assert.equal(matches.length, count)
      assert.equal(content(matches[0]).replace(/\n$/, ''), text)
      if (href) assert.equal(matches[0].attributes.url, href)
      if (['code', 'codespan', 'link'].includes(kind))
        assert.ok(!all.some((node) => ['Strong', 'Emphasis', 'Strikethrough'].includes(node.type)))
    }
    // 原生选字和复制都取 AST 内容；不能偷偷添加零宽字符或其他新字。
    for (const char of content(root))
      assert.ok(source.includes(char), `解析器添加了 ${JSON.stringify(char)}`)
  })
}

for (const source of ['$a**b**c$', '$$**标题：**正文$$']) {
  test(`手机已有的数学式不解析强调：${source}`, () => {
    const root = parseNative(source)
    assert.deepEqual(parseWeb(source), root)
    assert.ok(!nodes(root).some((node) => ['Strong', 'Emphasis'].includes(node.type)))
    assert.ok(content(root).includes('**'))
  })
}
