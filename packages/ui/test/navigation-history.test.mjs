import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyOf, travel } from '../src/app/history.ts'
import { navigationHistory } from '../src/app/navigation-history.ts'
import { initialNavigation } from '../src/app/view-navigation.ts'

const a = { deviceId: 'local', sessionId: 'a' }
const manager = { deviceId: 'local', sessionId: 'manager' }
const select = (h, selection) => navigationHistory(h, { type: 'select', selection })
const current = (h) => h.entries[h.index]

test('重开当前会话保留历史长度，同时刷新选择供通知重新定位', () => {
  const h = select(historyOf(initialNavigation), a)
  const again = { ...a }
  const next = select(h, again)
  assert.equal(next.entries.length, h.entries.length)
  assert.equal(current(next).location.picked, again)
  const afterPage = navigationHistory(navigationHistory(next, { type: 'page', page: 'archived' }), {
    type: 'page',
    page: null,
  })
  assert.equal(select(afterPage, { ...a }).entries.length, afterPage.entries.length)
})
test('旧会话删除后从历史移除；当前经理不变', () => {
  let h = select(select(historyOf(initialNavigation), a), manager)
  h = navigationHistory(h, { type: 'missing', selection: a })
  assert.equal(current(h).location.picked, manager)
  assert.ok(h.entries.every((entry) => entry.location.picked !== a))
  assert.equal(h.entries.length, 2)
})
test('切树不新增访问，前进和后退只改变正文，不恢复旧导航树', () => {
  let h = select(select(historyOf(initialNavigation), a), manager)
  const size = h.entries.length
  h = navigationHistory(h, { type: 'switch', mode: 'manager' })
  assert.equal(h.entries.length, size)
  assert.equal(current(h).location.picked, manager)
  h = travel(h, -1, () => true)
  assert.equal(current(h).location.picked, a)
  assert.equal(current(h).mode, 'manager')
  h = navigationHistory(h, { type: 'switch', mode: 'chat' })
  h = travel(h, 1, () => true)
  assert.equal(current(h).location.picked, manager)
  assert.equal(current(h).mode, 'chat')
})
test('经理列表与新建路由分别恢复，归档来源只记录实际预览页面', () => {
  let h = historyOf(initialNavigation)
  h = navigationHistory(h, { type: 'managers', route: { view: 'list' } })
  h = navigationHistory(h, { type: 'managers', route: { view: 'new', deviceId: 'local' } })
  h = travel(h, -1, () => true)
  assert.deepEqual(current(h).location.managersRoute, { view: 'list' })
  h = travel(h, 1, () => true)
  assert.deepEqual(current(h).location.managersRoute, { view: 'new', deviceId: 'local' })
  const size = h.entries.length
  h = navigationHistory(h, { type: 'page', page: 'archived', peek: a })
  assert.equal(h.entries.length, size + 1)
  assert.equal(current(h).location.peek, a)
})

test('看板标签更新当前历史项，来源/决策/事项链接跳出后返回恢复当时标签', () => {
  for (const tab of ['suggestions', 'decisions', 'items']) {
    let h = select(historyOf(initialNavigation), manager)
    const size = h.entries.length
    h = navigationHistory(h, {
      type: 'manager-location',
      key: 'local:m1',
      location: { tab, narrow: 'board', settings: false },
    })
    assert.equal(h.entries.length, size, '切标签不多压一层')
    h = select(h, a)
    assert.equal(h.entries.length, size + 1, '会话链接压入历史')
    h = travel(h, -1, () => true)
    assert.equal(current(h).location.picked, manager)
    assert.equal(current(h).location.managerPage.location.tab, tab)
    h = travel(h, 1, () => true)
    assert.equal(current(h).location.picked, a)
  }
})
test('多次访问同一经理保留各自的标签，后一次改标签不污染较早历史', () => {
  let h = select(historyOf(initialNavigation), manager)
  const location = (tab) => ({
    type: 'manager-location',
    key: 'local:m1',
    location: { tab, narrow: 'board', settings: false },
  })
  h = navigationHistory(h, location('suggestions'))
  h = select(select(h, a), manager)
  h = navigationHistory(h, location('decisions'))
  h = travel(
    travel(h, -1, () => true),
    -1,
    () => true,
  )
  assert.equal(current(h).location.managerPage.location.tab, 'suggestions')
})
