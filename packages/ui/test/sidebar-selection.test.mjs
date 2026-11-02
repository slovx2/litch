import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clickedRow,
  navigatedRow,
  navigateRows,
  reconcileProjection,
  rowMemory,
  sameSession,
} from '../src/sidebar/selection.ts'

const session = { deviceId: 'local', sessionId: 'a' }
const recent = { ...session, source: 'recent' }
const unread = { ...session, source: 'unread' }
const tree = { ...session, source: 'tree' }

test('对话和经理分别记住来源：切模式与窗口重渲染不重算，外部重新打开仍定位树行', () => {
  const manager = { deviceId: 'local', sessionId: 'manager' }
  let memory = rowMemory('chat')
  memory = navigateRows(clickedRow(memory, 'chat', session, 'recent'), 'chat', session, true)
  const chatRow = memory.rows.chat
  memory = navigateRows(memory, 'manager', null, true)
  memory = navigateRows(clickedRow(memory, 'manager', manager, 'tree'), 'manager', manager, true)
  const managerRow = memory.rows.manager
  memory = navigateRows(memory, 'chat', session, true)
  assert.equal(memory.rows.chat, chatRow)
  assert.equal(memory.request, null)
  memory = navigateRows(memory, 'manager', manager, true)
  assert.equal(memory.rows.manager, managerRow)
  assert.equal(memory.request, null)
  memory = navigateRows(memory, 'chat', session, true)
  memory = navigateRows(memory, 'chat', { ...session }, true)
  assert.deepEqual(memory.rows.chat, tree)
  assert.equal(memory.rows.manager, managerRow)
})

test('模式切换保留未选中状态；跨模式点击保存来源模式的行，目标模式独立定位', () => {
  let memory = navigateRows(rowMemory('chat'), 'chat', session, false)
  memory = navigateRows(memory, 'manager', null, false)
  memory = navigateRows(memory, 'chat', session, false)
  assert.equal(memory.rows.chat, null)
  const manager = { ...session, sessionId: 'manager' }
  memory = navigateRows(clickedRow(memory, 'chat', manager, 'recent'), 'manager', manager, true)
  assert.equal(memory.rows.chat.source, 'recent')
  assert.equal(memory.rows.manager.source, 'tree')
  memory = navigateRows(memory, 'chat', session, true)
  assert.deepEqual(memory.rows.chat, { ...manager, source: 'recent' })
})

test('同一会话的三个位置只选中明确点过的位置，设备标识也参与匹配', () => {
  for (const chosen of [recent, unread, tree]) {
    const matches = [recent, unread, tree].filter(
      (row) => row.source === chosen.source && sameSession(row, chosen),
    )
    assert.deepEqual(matches, [chosen])
    assert.equal(sameSession(chosen, { ...session, deviceId: 'remote' }), false)
  }
})

test('外部导航和重新打开当前对话定位树行，包括历史、通知、新建；关闭定位不新增选择', () => {
  assert.deepEqual(navigatedRow(recent, session, true), tree)
  assert.deepEqual(navigatedRow(null, session, true), tree)
  assert.equal(navigatedRow(null, session, false), null)
  assert.equal(navigatedRow(recent, session, false), recent)
  assert.equal(navigatedRow(recent, { ...session, sessionId: 'b' }, false), null)
  assert.equal(navigatedRow(recent, null, true), null)
})

test('投影刷新、重排、增加副本不改变选择；选中的投影移除后回到同一会话的树行', () => {
  assert.equal(reconcileProjection(recent, 'recent', [session], {}), recent)
  assert.equal(
    reconcileProjection(recent, 'recent', [{ ...session, sessionId: 'b' }, { ...session }], {}),
    recent,
  )
  assert.equal(reconcileProjection(recent, 'unread', [], {}), recent)
  assert.equal(reconcileProjection(tree, 'recent', [session], {}), tree)
  assert.deepEqual(reconcileProjection(recent, 'recent', [], {}), tree)
  assert.deepEqual(reconcileProjection(unread, 'unread', [], {}), tree)
  assert.deepEqual(
    reconcileProjection(recent, 'recent', [{ ...session, deviceId: 'remote' }], {}),
    tree,
  )
})

test('投影中展开的子会话按父链保留，子会话移出投影子树时回树行', () => {
  const roots = [{ ...session, sessionId: 'parent' }]
  assert.equal(reconcileProjection(recent, 'recent', roots, { parent: ['a'] }), recent)
  assert.deepEqual(reconcileProjection(recent, 'recent', roots, { parent: [] }), tree)
})
