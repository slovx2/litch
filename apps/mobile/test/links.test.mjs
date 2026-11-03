// 对话里的文件路径和网址改写成链接（src/detail/links.ts）：代码块不动、已有链接的行不动、litch-file: 来回不失真。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileHref, fileRefFromHref, isWebUrl, linkify, parseFileHref } from '../src/detail/links.ts'

const scope = { root: '/w/proj', cwd: '/w/proj' }

test('裸网址改成自动链接，结尾的句读留在外面', () => {
  assert.equal(linkify('看 https://example.com/a?b=1。', null), '看 <https://example.com/a?b=1>。')
  assert.equal(linkify('see https://example.com.', null), 'see <https://example.com>.')
})

test('行内代码整段是路径：改成链接（地址是绝对路径）、样子还是行内代码；正文里的路径也认', () => {
  assert.equal(
    linkify('改了 `src/app.ts`', scope),
    '改了 [`src/app.ts`](' +
      fileHref({ path: '/w/proj/src/app.ts', alt: null, line: null }, 'src/app.ts') +
      ')',
  )
  const prose = linkify('打开 /w/proj/src/app.ts:12 看看', scope)
  assert.equal(parseFileHref(prose.match(/\((litch-file:[^)]+)\)/)[1]).line, 12)
})

test('标准 Markdown 点击与内部路径使用同一解析，保留备选、行号和锚点', () => {
  const nested = { root: '/w/proj', cwd: '/w/proj/sub', roots: ['/w/proj', '/another'] }
  for (const href of [
    'a.ts:12',
    'docs/My%20Report.md#L12C3',
    '/outside/a.pdf',
    'C:/work/a.ts:12',
  ]) {
    const ref = fileRefFromHref(href, nested)
    assert.ok(ref, href)
    assert.deepEqual(fileRefFromHref(fileHref(ref), nested), ref)
  }
  assert.equal(fileRefFromHref('docs/a.md#标题', nested).fragment, '标题')
  assert.deepEqual(fileRefFromHref('a.ts', nested).candidates, [
    '/w/proj/sub/a.ts',
    '/w/proj/a.ts',
    '/another/a.ts',
  ])
  const mixed = linkify('[网站](https://example.com) 与 `src/a.ts:12`、src/b.ts', nested)
  assert.ok(mixed.startsWith('[网站](https://example.com)'))
  assert.equal([...mixed.matchAll(/litch-file:/g)].length, 2)
  const explicit = '[报告](<docs/My Report.md:12>)'
  assert.equal(linkify(explicit, nested), explicit)
})

test('代码块、缩进代码、已经有链接的行一律不动；没有工作区时不认路径', () => {
  const fenced = '```\nhttps://example.com\n`src/app.ts`\n```'
  assert.equal(linkify(fenced, scope), fenced)
  assert.equal(linkify('    https://example.com', scope), '    https://example.com')
  const linked = '[文档](https://a.b) 和 https://c.d'
  assert.equal(linkify(linked, scope), '[文档](https://a.b) 和 <https://c.d>')
  assert.equal(linkify('`src/app.ts`', null), '`src/app.ts`')
})

test('litch-file: 链接来回：括号、中文、空格都不丢；不是这种链接的是 null', () => {
  const ref = {
    path: 'docs/说明 (草稿).md',
    alt: '/repo/说明 (草稿).md',
    line: 7,
    fragment: '标题',
    candidates: ['/a.md', '/b.md'],
  }
  const href = fileHref(ref)
  assert.ok(!href.includes('(') && !href.includes(')'), '括号转义了，Markdown 的地址不会断')
  assert.deepEqual(parseFileHref(href), ref)
  assert.equal(parseFileHref('litch-file:a.ts'), null)
  assert.equal(parseFileHref(fileHref({ path: '/a.ts', alt: null, line: 0 })), null)
  assert.equal(parseFileHref('litch-file:%E0%A4%A'), null)
  assert.equal(parseFileHref('https://a.b'), null)
  assert.equal(isWebUrl('HTTPS://a.b'), true)
  assert.equal(isWebUrl('litch-file:a'), false)
})
