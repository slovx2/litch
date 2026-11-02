import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyOf, travel, visit, without } from '../src/app/history.ts'
import { navigationKey } from '../src/app/navigation-key.ts'

const same = (a, b) => a === b
const valid = () => true
test('访问历史：前进后退、相邻去重、返回后截断和两端边界', () => {
  let h = historyOf('new')
  h = visit(h, 'session-a', same)
  assert.equal(visit(h, 'session-a', same), h)
  h = visit(h, 'manager', same)
  assert.equal(travel(h, 1, valid), h)
  h = travel(travel(h, -1, valid), -1, valid)
  assert.equal(h.entries[h.index], 'new')
  assert.equal(travel(h, -1, valid), h)
  h = travel(h, 1, valid)
  assert.equal(h.entries[h.index], 'session-a')
  h = visit(h, 'devices', same)
  assert.deepEqual(h.entries, ['new', 'session-a', 'devices'])
})
test('失效会话：跳过归档/删除项，清理时保留当前位置', () => {
  let h = ['a', 'archived', 'deleted', 'b'].reduce(
    (h, item) => visit(h, item, same),
    historyOf('new'),
  )
  h = travel(h, -1, (item) => item !== 'archived' && item !== 'deleted')
  assert.equal(h.entries[h.index], 'a')
  h = without(h, (item) => item !== 'archived' && item !== 'deleted')
  assert.deepEqual(h.entries, ['new', 'a', 'b'])
  assert.equal(h.index, 1)
  for (let i = 0; i < 150; i++) h = visit(h, `session-${i}`, same)
  assert.equal(h.entries.length, 100)
  assert.equal(h.index, 99)
})
test('导航快捷键按平台匹配，编辑控件和输入法不触发', () => {
  const base = {
    key: '[',
    metaKey: true,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 0,
  }
  assert.equal(navigationKey(base, 'mac', false), -1)
  assert.equal(navigationKey({ ...base, key: ']' }, 'mac', false), 1)
  assert.equal(navigationKey(base, 'win', false), null)
  assert.equal(navigationKey(base, 'mac', true), null)
  assert.equal(navigationKey({ ...base, isComposing: true }, 'mac', false), null)
  assert.equal(navigationKey({ ...base, keyCode: 229 }, 'mac', false), null)
  for (const platform of ['win', 'linux']) {
    assert.equal(
      navigationKey({ ...base, metaKey: false, altKey: true, key: 'ArrowLeft' }, platform, false),
      -1,
    )
    assert.equal(
      navigationKey({ ...base, metaKey: false, altKey: true, key: 'ArrowRight' }, platform, false),
      1,
    )
  }
})
