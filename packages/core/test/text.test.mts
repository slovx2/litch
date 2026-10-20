import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffLines, repairStreamingMarkdown as repair } from '../src/index.mjs'

test('补齐流式 Markdown：没闭合的加粗、删除线、行内代码', () => {
  assert.equal(repair('这是**重点'), '这是**重点**')
  assert.equal(repair('这是**重点**，后面'), '这是**重点**，后面')
  assert.equal(repair('用 `npm ci'), '用 `npm ci`')
  assert.equal(repair('~~不要了'), '~~不要了~~')
  assert.equal(repair('代码里的 `a ** b` 不算，**这个算'), '代码里的 `a ** b` 不算，**这个算**')
})

test('补齐流式 Markdown：刚敲出来的半个标记先不显示', () => {
  assert.equal(repair('接下来**'), '接下来')
  assert.equal(repair('运行 `'), '运行 ')
  assert.equal(repair('看[文档](https://exam'), '看文档')
  assert.equal(repair('看[文档](https://example.com)'), '看[文档](https://example.com)')
})

test('补齐流式 Markdown：只动最后一段，代码块里不动', () => {
  assert.equal(repair('第一段有**没闭合\n\n第二段'), '第一段有**没闭合\n\n第二段')
  assert.equal(repair('前面\n\n最后一段**加粗'), '前面\n\n最后一段**加粗**')
  const fenced = '说明\n\n```ts\nconst a = `x${'
  assert.equal(repair(fenced), fenced)
  assert.equal(repair('```sh\nls\n```\n\n然后**看'), '```sh\nls\n```\n\n然后**看**')
  assert.equal(repair(''), '')
})

test('差异：补丁按行拆开，带两边的行号，文件头不显示', () => {
  const diff = [
    'Index: a.txt',
    '===================================================================',
    '--- a.txt',
    '+++ a.txt',
    '@@ -3,3 +3,4 @@ header',
    ' keep',
    '-old',
    '+new',
    '+more',
    ' tail',
    '\\ No newline at end of file',
    '',
  ].join('\n')
  assert.deepEqual(diffLines({ diff, diffKind: 'patch', change: 'update', elided: null }), [
    { type: 'hunk', text: '@@ -3,3 +3,4 @@ header', oldNo: null, newNo: null },
    { type: 'ctx', text: 'keep', oldNo: 3, newNo: 3 },
    { type: 'del', text: 'old', oldNo: 4, newNo: null },
    { type: 'add', text: 'new', oldNo: null, newNo: 4 },
    { type: 'add', text: 'more', oldNo: null, newNo: 5 },
    { type: 'ctx', text: 'tail', oldNo: 5, newNo: 6 },
  ])
})

test('差异：给的是整个文件内容时，新增全算加，删除全算减', () => {
  assert.deepEqual(
    diffLines({ diff: '一\n二\n', diffKind: 'content', change: 'add', elided: null }),
    [
      { type: 'add', text: '一', oldNo: null, newNo: 1 },
      { type: 'add', text: '二', oldNo: null, newNo: 2 },
    ],
  )
  assert.deepEqual(diffLines({ diff: '一', diffKind: 'content', change: 'delete', elided: null }), [
    { type: 'del', text: '一', oldNo: 1, newNo: null },
  ])
  assert.deepEqual(diffLines({ diff: '', diffKind: 'content', change: 'add', elided: null }), [])
})
