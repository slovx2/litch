import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyOf, travel } from '../src/app/history.ts'
import { navigationHistory } from '../src/app/navigation-history.ts'
import { initialNavigation, navigate, sessionSelection } from '../src/app/view-navigation.ts'

const chat = { deviceId: 'local', sessionId: 'chat' }
const manager = { deviceId: 'local', sessionId: 'manager' }
const select = (state, mode, selection) => navigate(state, { type: 'select', mode, selection })
const switchTo = (state, mode) => navigate(state, { type: 'switch', mode })

for (const [entry, mode] of [
  ['最近', 'chat'],
  ['未读', 'chat'],
  ['经理侧栏', 'manager'],
  ['经理目录', 'manager'],
  ['标题搜索', undefined],
  ['@ 会话', undefined],
  ['会话通知', undefined],
  ['经理通知', undefined],
  ['定时任务运行记录及通知', undefined],
  ['子会话回报和父子链接', undefined],
  ['建议来源', undefined],
  ['浏览器去看及看板引用', undefined],
]) {
  test(`${entry}打开经理与经理目录一致，后退不会经过普通经理对话`, () => {
    const before = navigate(initialNavigation, sessionSelection(chat, null))
    const action = sessionSelection(manager, 'm1', mode)
    const expected = navigate(before, sessionSelection(manager, 'm1', 'manager'))
    const history = navigationHistory(historyOf(before), action)
    assert.deepEqual(history.entries[history.index], expected)
    assert.equal(expected.mode, 'manager')
    assert.equal(expected.manager.page, null)
    assert.equal(expected.manager.picked, manager)
    assert.equal(expected.chat.picked, chat, '进入经理保留普通会话位置')
    assert.deepEqual(travel(history, -1, () => true).entries[0], before)
    assert.equal(navigationHistory(history, action).entries.length, 2, '重复打开不新增返回层')
  })
}

test('普通会话与子会话仍选普通详情，工作线保留原侧栏模式', () => {
  for (const sessionId of ['chat', 'child']) {
    const next = navigate(initialNavigation, sessionSelection({ ...chat, sessionId }, null))
    assert.equal(next.mode, 'chat')
    assert.equal(next.chat.picked.sessionId, sessionId)
  }
  assert.equal(sessionSelection(chat, null, 'chat', true).mode, 'chat')
  assert.equal(sessionSelection(chat, null, undefined, true).mode, 'manager')
})

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

test('修改设备连接导致原会话消失时，继续显示设备页与连接结果', () => {
  let state = select(initialNavigation, 'chat', chat)
  state = navigate(state, { type: 'page', page: 'devices' })
  state = navigate(state, { type: 'missing', mode: 'chat', selection: chat })
  assert.equal(state.chat.picked, null)
  assert.equal(state.chat.page, 'devices')
})

test('隐藏经理视图的会话消失时，保留独立设置页且不切换当前视图', () => {
  let state = select(initialNavigation, 'manager', manager)
  state = navigate(state, { type: 'page', page: 'settings' })
  state = switchTo(state, 'chat')
  state = navigate(state, { type: 'missing', mode: 'manager', selection: manager })
  assert.equal(state.manager.picked, null)
  assert.equal(state.manager.page, 'settings')
  assert.equal(state.mode, 'chat')
})
