import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activitySettled,
  bucketItems,
  diffLines,
  repairStreamingMarkdown as repair,
} from '../src/index.mjs'

test('分块：过程性的条目连成一个活动块，回答和计划各自成块', () => {
  const blocks = bucketItems([
    { id: 'u', kind: 'userMessage' },
    { id: 'r', kind: 'reasoning' },
    { id: 'note', kind: 'agentMessage', phase: 'commentary' },
    { id: 'c', kind: 'command' },
    { id: 'p', kind: 'plan' },
    { id: 'f', kind: 'fileChange' },
    { id: 'a1', kind: 'agentMessage', phase: 'unknown' },
    { id: 't', kind: 'toolCall' },
    { id: 'a2', kind: 'agentMessage', phase: 'final' },
  ])
  assert.deepEqual(blocks, [
    { type: 'user', itemId: 'u' },
    { type: 'activity', key: 'r', itemIds: ['r', 'note', 'c'] },
    { type: 'plan', itemId: 'p' },
    { type: 'activity', key: 'f', itemIds: ['f'] },
    { type: 'answer', itemId: 'a1' },
    { type: 'activity', key: 't', itemIds: ['t'] },
    { type: 'answer', itemId: 'a2' },
  ])
})

test('分块：待办进度自己成块；只有说明的回合，说明直接露在外面', () => {
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'c1', kind: 'command' },
      { id: 'd', kind: 'todo' },
      { id: 'c2', kind: 'command' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'activity', key: 'c1', itemIds: ['c1'] },
      { type: 'todo', itemId: 'd' },
      { type: 'activity', key: 'c2', itemIds: ['c2'] },
    ],
  )
  assert.deepEqual(bucketItems([{ id: 'n', kind: 'notice' }]), [
    { type: 'notes', key: 'n', itemIds: ['n'] },
  ])
  // 说明夹在别的条目中间时照旧进活动块
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'n', kind: 'notice' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'activity', key: 'n', itemIds: ['n'] },
    ],
  )
})

test('分块：活动块里再来条目，块的标识不变', () => {
  const before = bucketItems([{ id: 'r', kind: 'reasoning' }])
  const after = bucketItems([
    { id: 'r', kind: 'reasoning' },
    { id: 'c', kind: 'command' },
  ])
  assert.equal(before[0]?.type === 'activity' && before[0].key, 'r')
  assert.equal(after[0]?.type === 'activity' && after[0].key, 'r')
})

test('活动块什么时候自动收起：回合结束，或者后面已经有写完的最终回答', () => {
  assert.equal(activitySettled(false, []), true)
  assert.equal(activitySettled(true, []), false)
  const answer = (phase: string, status: string) => [
    { kind: 'agentMessage' as const, phase, status },
  ]
  assert.equal(activitySettled(true, answer('final', 'completed')), true)
  assert.equal(
    activitySettled(true, answer('final', 'inProgress')),
    false,
    '刚开始就自称最终回答的不算',
  )
  assert.equal(activitySettled(true, answer('unknown', 'completed')), false)
  // harness 声明了消息一开始阶段值就是准的：最终回答一开始就收，不等它写完
  assert.equal(activitySettled(true, answer('final', 'inProgress'), true), true)
  assert.equal(activitySettled(true, answer('commentary', 'inProgress'), true), false)
  assert.equal(activitySettled(true, answer('unknown', 'inProgress'), true), false)
  assert.equal(activitySettled(true, [], true), false)
})

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
