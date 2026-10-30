import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containsSession, revealPath, revealRow } from '../src/sidebar/reveal.ts'

const children = { root: ['parent'], parent: ['child'] }
const groups = { workspace: ['other', 'root', 'parent', 'child'] }
const all = (ids) => ids

test('定位取完整父链及顶层行的位置，供展开折叠和展示更多使用', () => {
  assert.deepEqual(revealPath('child', groups, children, all), {
    group: 'workspace',
    rootIndex: 1,
    ids: ['root', 'parent', 'child'],
  })
})

test('目标被筛掉时定位最近可见祖先，不改变筛选', () => {
  const shown = (ids) => ids.filter((id) => id !== 'child')
  assert.deepEqual(revealPath('child', groups, children, shown)?.ids, ['root', 'parent'])
  assert.equal(revealPath('missing', groups, children, shown), null)
})

test('父会话被筛掉时目标按实际绘制规则排回自己的组', () => {
  const shown = (ids) => ids.filter((id) => id !== 'parent')
  assert.deepEqual(revealPath('child', groups, children, shown)?.ids, ['child'])
})

test('经理子树不依赖普通会话分组；循环关系不会卡住定位', () => {
  assert.deepEqual(revealPath('child', {}, children, all, 'root')?.ids, ['parent', 'child'])
  assert.equal(containsSession(children, 'root', 'child'), true)
  assert.equal(containsSession({ a: ['b'], b: ['a'] }, 'a', 'missing'), false)
  assert.equal(revealPath('missing', groups, { child: ['child'] }, all), null)
})

test('已在视口内不滚动，视口外只调整侧栏到大致居中', () => {
  const scroll = { scrollTop: 100, getBoundingClientRect: () => ({ top: 100, bottom: 500 }) }
  revealRow({ getBoundingClientRect: () => ({ top: 120, bottom: 160 }) }, scroll)
  assert.equal(scroll.scrollTop, 100)
  revealRow({ getBoundingClientRect: () => ({ top: 600, bottom: 640 }) }, scroll)
  assert.equal(scroll.scrollTop, 420)
})
