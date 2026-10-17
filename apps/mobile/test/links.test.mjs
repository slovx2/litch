// 对话里的文件路径和网址改写成链接（src/detail/links.ts）：代码块不动、已有链接的行不动、litch-file: 来回不失真。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileHref, isWebUrl, linkify, parseFileHref } from '../src/detail/links.ts'

const scope = { root: '/w/proj', cwd: '/w/proj' }

test('裸网址改成自动链接，结尾的句读留在外面', () => {
  assert.equal(linkify('看 https://example.com/a?b=1。', null), '看 <https://example.com/a?b=1>。')
  assert.equal(linkify('see https://example.com.', null), 'see <https://example.com>.')
})

test('行内代码整段是路径：改成链接（地址是绝对路径）、样子还是行内代码；正文里的路径也认', () => {
  assert.equal(
    linkify('改了 `src/app.ts`', scope),
    '改了 [`src/app.ts`](litch-file:%2Fw%2Fproj%2Fsrc%2Fapp.ts)',
  )
  const prose = linkify('打开 /w/proj/src/app.ts:12 看看', scope)
  assert.match(prose, /\[\/w\/proj\/src\/app\.ts:12\]\(litch-file:[^)]+#L12\)/)
})

test('代码块、缩进代码、已经有链接的行一律不动；没有工作区时不认路径', () => {
  const fenced = '```\nhttps://example.com\n`src/app.ts`\n```'
  assert.equal(linkify(fenced, scope), fenced)
  assert.equal(linkify('    https://example.com', scope), '    https://example.com')
  const linked = '[文档](https://a.b) 和 https://c.d'
  assert.equal(linkify(linked, scope), linked)
  assert.equal(linkify('`src/app.ts`', null), '`src/app.ts`')
})

test('litch-file: 链接来回：括号、中文、空格都不丢；不是这种链接的是 null', () => {
  const ref = { path: 'docs/说明 (草稿).md', line: 7 }
  const href = fileHref(ref)
  assert.ok(!href.includes('(') && !href.includes(')'), '括号转义了，Markdown 的地址不会断')
  assert.deepEqual(parseFileHref(href), ref)
  assert.deepEqual(parseFileHref('litch-file:a.ts'), { path: 'a.ts', line: null })
  assert.deepEqual(parseFileHref('litch-file:a.ts#L0'), { path: 'a.ts', line: null })
  assert.equal(parseFileHref('litch-file:%E0%A4%A'), null)
  assert.equal(parseFileHref('https://a.b'), null)
  assert.equal(isWebUrl('HTTPS://a.b'), true)
  assert.equal(isWebUrl('litch-file:a'), false)
})
