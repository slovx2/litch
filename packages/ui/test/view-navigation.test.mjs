import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyOf, travel } from '../src/app/history.ts'
import { navigationHistory } from '../src/app/navigation-history.ts'
import { initialNavigation, navigate } from '../src/app/view-navigation.ts'

const chat = { deviceId: 'local', sessionId: 'chat' }
const manager = { deviceId: 'local', sessionId: 'manager', managerId: 'm1' }
const select = (state, selection) => navigate(state, { type: 'select', selection })
const switchTo = (state, mode) => navigate(state, { type: 'switch', mode })

for (const mode of ['chat', 'manager']) {
  for (const selection of [chat, manager, { ...chat, sessionId: 'line' }]) {
    test(`${mode} 树打开 ${selection.sessionId} 保留导航树，切树不改变正文`, () => {
      const before = select(switchTo(initialNavigation, mode), chat)
      const action = { type: 'select', selection }
      const next = navigate(before, action)
      assert.equal(next.mode, mode)
      assert.equal(next.location.picked, selection)
      assert.equal(next.location.page, null)
      const other = switchTo(next, mode === 'chat' ? 'manager' : 'chat')
      assert.equal(other.location, next.location)
      assert.equal(switchTo(other, mode).location, next.location)
      const history = navigationHistory(historyOf(before), action)
      assert.equal(navigationHistory(history, action).entries.length, history.entries.length)
      if (selection !== chat) assert.deepEqual(travel(history, -1, () => true).entries[0], before)
    })
  }
}

test('会话等待身份期间切树，完成打开时保留用户最后选的树', () => {
  let state = select(initialNavigation, manager)
  state = switchTo(state, 'manager')
  state = select(state, chat)
  assert.equal(state.mode, 'manager')
  assert.equal(state.location.picked, chat)
})

test('新建对话和经理子页面也不随切树切换内容', () => {
  let state = select(initialNavigation, manager)
  state = navigate(state, { type: 'compose', wish: { deviceId: 'local' } })
  state = switchTo(state, 'manager')
  assert.equal(state.location.picked, null)
  assert.equal(state.location.wish.deviceId, 'local')
  state = navigate(state, { type: 'managers', route: { view: 'new' } })
  state = switchTo(state, 'chat')
  assert.equal(state.location.page, 'managers')
  assert.deepEqual(state.location.managersRoute, { view: 'new' })
})

test('当前会话删除后回默认页，与导航树无关；旧订阅不清掉新会话', () => {
  for (const mode of ['chat', 'manager']) {
    const state = select(switchTo(initialNavigation, mode), chat)
    assert.equal(navigate(state, { type: 'missing', selection: manager }), state)
    const next = navigate(state, { type: 'missing', selection: chat })
    assert.equal(next.mode, mode)
    assert.equal(next.location.picked, null)
    assert.equal(next.location.page, null)
  }
})

test('设备改连导致会话消失时，保留独立页面与连接结果', () => {
  let state = select(initialNavigation, chat)
  state = navigate(state, { type: 'page', page: 'devices' })
  state = switchTo(state, 'manager')
  state = navigate(state, { type: 'missing', selection: chat })
  assert.equal(state.location.picked, null)
  assert.equal(state.location.page, 'devices')
  assert.equal(state.mode, 'manager')
})
