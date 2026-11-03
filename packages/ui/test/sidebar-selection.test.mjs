import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clickedRow,
  navigatedRow,
  navigateRows,
  projectionRoot,
  reconcileProjection,
  rememberUnread,
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

test('模式切换保留未选中状态；跨模式点击恢复来源模式的原行，目标模式独立定位', () => {
  let memory = navigateRows(rowMemory('chat'), 'chat', session, false)
  memory = navigateRows(memory, 'manager', null, false)
  memory = navigateRows(memory, 'chat', session, false)
  assert.equal(memory.rows.chat, null)
  const manager = { ...session, sessionId: 'manager' }
  memory = navigateRows(clickedRow(memory, 'chat', manager, 'recent'), 'manager', manager, true)
  assert.equal(memory.rows.chat, null)
  assert.equal(memory.rows.manager.source, 'tree')
  memory = navigateRows(memory, 'chat', session, true)
  assert.equal(memory.rows.chat, null)
})

test('最近打开经理后切回普通对话，正文与高亮均恢复原会话的最近行', () => {
  const manager = { ...session, sessionId: 'manager' }
  let memory = navigateRows(
    clickedRow(rowMemory('chat'), 'chat', session, 'recent'),
    'chat',
    session,
    true,
  )
  memory = navigateRows(clickedRow(memory, 'chat', manager, 'recent'), 'manager', manager, true)
  assert.deepEqual(memory.rows.chat, recent)
  memory = navigateRows(memory, 'chat', session, true)
  assert.deepEqual(memory.rows.chat, recent)
  assert.equal(memory.request, null)
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

test('未读暂留按整棵树认当前会话：根、子会话、深层后代和经理工作线', () => {
  const children = { parent: ['child', 'sibling'], child: ['grandchild'], manager: ['line'] }
  const at = (sessionId, deviceId = 'local') => ({ deviceId, sessionId })
  for (const id of ['parent', 'child', 'sibling', 'grandchild'])
    assert.deepEqual(projectionRoot(at(id), children), at('parent'))
  assert.deepEqual(projectionRoot(at('line'), children), at('manager'))
  assert.deepEqual(projectionRoot(at('child', 'remote'), children), at('parent', 'remote'))
  assert.equal(projectionRoot(null, children), null)
  assert.deepEqual(projectionRoot(at('missing'), children), at('missing'))
  assert.ok(projectionRoot(at('a'), { a: ['b'], b: ['a'] }), '错误父链不死循环')
})

test('正在看的树后来才出现未读：点子会话清完未读后仍保持第一次出现的位置', () => {
  const children = { parent: ['child', 'sibling'], child: ['grandchild'] }
  const at = (sessionId) => projectionRoot({ deviceId: 'local', sessionId }, children)
  const parent = { ...at('parent'), workspaceId: 'w', at: 200 }
  const other = { ...parent, sessionId: 'other', at: 300 }
  const rows = [other, parent]
  let memory = rememberUnread({ root: null, opened: null }, at('parent'), [])
  assert.equal(memory.opened, null)
  // 父项已打开时子会话完成；根项没变，这一帧也必须记住位置。
  memory = rememberUnread(memory, at('parent'), rows)
  assert.deepEqual(memory.opened, { row: parent, index: 1 })
  const held = memory
  for (const id of ['child', 'sibling', 'grandchild', 'parent']) {
    memory = rememberUnread(memory, at(id), [other])
    assert.equal(memory, held, '清已读和树内切换不丢掉暂留项')
  }
  assert.equal(
    rememberUnread(memory, at('child'), [{ ...parent, at: 400 }, other]),
    held,
    '新结果引起排序变化也不挪动当前项',
  )
  assert.deepEqual(rows, [other, parent], '暂留不修改真实未读集合')
  assert.equal(rememberUnread(memory, at('read-elsewhere'), [other]).opened, null)
  assert.equal(rememberUnread(memory, null, [other]).opened, null, '离开对话释放暂留')
  const left = rememberUnread(memory, null, [other])
  assert.equal(rememberUnread(left, at('child'), [other]).opened, null, '返回已读子会话不回填')
})

test('从别的树直接打开未读子会话也暂留根项，跨设备同标识不能沿用', () => {
  const root = { deviceId: 'local', sessionId: 'parent' }
  const row = { ...root, workspaceId: null, at: 1 }
  const chosen = projectionRoot({ ...root, sessionId: 'child' }, { parent: ['child'] })
  const memory = rememberUnread({ root: null, opened: null }, chosen, [row])
  assert.deepEqual(memory.opened, { row, index: 0 })
  assert.equal(rememberUnread(memory, { ...root, deviceId: 'remote' }, []).opened, null)
  assert.equal(rememberUnread(memory, null, []).opened, null)
})
