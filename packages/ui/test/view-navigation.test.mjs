import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialNavigation, navigate } from '../src/app/view-navigation.ts'

const chat = { deviceId: 'local', sessionId: 'chat' }
const manager = { deviceId: 'local', sessionId: 'manager' }
const select = (state, mode, selection) => navigate(state, { type: 'select', mode, selection })
const switchTo = (state, mode) => navigate(state, { type: 'switch', mode })

test('对话 → 经理 → 对话恢复原会话，经理 → 对话 → 经理恢复原经理', () => {
  let state = select(initialNavigation, 'chat', chat)
  state = select(switchTo(state, 'manager'), 'manager', manager)
  state = switchTo(state, 'chat')
  assert.equal(state.chat.picked, chat)
  assert.equal(state.chat.page, null)
  state = switchTo(state, 'manager')
  assert.equal(state.manager.picked, manager)
  assert.equal(state.manager.page, null)
})

test('工作线和经理子页面保持自己的位置，普通新建对话不改经理位置', () => {
  const line = { deviceId: 'remote', sessionId: 'line' }
  let state = select(initialNavigation, 'manager', line)
  state = navigate(state, { type: 'compose', wish: { deviceId: 'local' } })
  state = switchTo(state, 'manager')
  assert.equal(state.manager.picked, line)
  state = navigate(state, { type: 'page', page: 'managers' })
  state = switchTo(switchTo(state, 'chat'), 'manager')
  assert.equal(state.manager.page, 'managers')
  assert.equal(state.chat.wish.deviceId, 'local')
})

test('隐藏视图的目标消失后回到默认页，不影响当前视图', () => {
  let state = select(select(initialNavigation, 'chat', chat), 'manager', manager)
  state = navigate(state, { type: 'missing', mode: 'chat', selection: chat })
  assert.equal(state.mode, 'manager')
  assert.equal(state.chat.picked, null)
  assert.equal(state.chat.page, null)
  state = switchTo(state, 'chat')
  state = navigate(state, { type: 'missing', mode: 'manager', selection: manager })
  assert.equal(state.manager.picked, null)
  assert.equal(state.manager.page, 'managers')
  assert.equal(state.mode, 'chat')
})

test('旧订阅的删除结果不能清掉新选中的会话，同栏重复点击不重置', () => {
  const state = select(initialNavigation, 'chat', chat)
  assert.deepEqual(switchTo(state, 'chat'), state)
  assert.equal(navigate(state, { type: 'missing', mode: 'chat', selection: manager }), state)
})
