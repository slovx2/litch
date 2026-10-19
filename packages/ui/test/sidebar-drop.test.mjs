// 侧栏的拖放规则（sidebar/drop.ts）：拖的是什么、放到哪、放下去发什么命令。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。真拖一下的那一半在预览里验
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { dropCommands } = await import('../src/sidebar/drop.ts')

const session = (extra = {}) => ({
  deviceId: 'local',
  kind: 'session',
  id: 's1',
  workspaceId: 'app',
  pinned: false,
  sectionId: null,
  ...extra,
})
const workspace = (extra = {}) => ({
  deviceId: 'local',
  kind: 'workspace',
  id: 'app',
  workspaceId: 'app',
  pinned: false,
  sectionId: null,
  ...extra,
})
const PINNED = { kind: 'pinned' }
const SECTION = { kind: 'section', sectionId: 'sec-1' }

test('会话：拖进置顶、组；已经在那儿的不接', () => {
  assert.deepEqual(dropCommands(session(), PINNED, 'local'), [
    { name: 'session.place', params: { sessionId: 's1', place: 'pinned' } },
  ])
  assert.deepEqual(dropCommands(session(), SECTION, 'local'), [
    { name: 'session.place', params: { sessionId: 's1', place: { sectionId: 'sec-1' } } },
  ])
  assert.deepEqual(dropCommands(session({ pinned: true }), PINNED, 'local'), [])
  assert.deepEqual(dropCommands(session({ sectionId: 'sec-1' }), SECTION, 'local'), [])
  // 置顶的拖进组：放进组（置顶跟着取消，设备上一个会话只在一个分区里）
  assert.equal(dropCommands(session({ pinned: true }), SECTION, 'local').length, 1)
})

test('会话：只能拖回自己的项目（从置顶、组里拿出来），不能拖到别的项目', () => {
  const home = { kind: 'workspace', workspaceId: 'app' }
  const other = { kind: 'workspace', workspaceId: 'docs' }
  assert.deepEqual(dropCommands(session({ pinned: true }), home, 'local'), [
    { name: 'session.place', params: { sessionId: 's1', place: null } },
  ])
  assert.deepEqual(dropCommands(session({ sectionId: 'sec-1' }), home, 'local').length, 1)
  assert.deepEqual(dropCommands(session(), home, 'local'), [], '本来就在这儿')
  assert.deepEqual(dropCommands(session({ pinned: true }), other, 'local'), [])
  assert.deepEqual(dropCommands(session(), other, 'local'), [])
  // 无项目的会话拖回“无项目”
  const loose = session({ workspaceId: null, pinned: true })
  assert.equal(dropCommands(loose, { kind: 'loose' }, 'local').length, 1)
  assert.deepEqual(dropCommands(session({ pinned: true }), { kind: 'loose' }, 'local'), [])
})

test('工作区：拖进置顶、组；拖到外面的工作区上是放回列表、排在它前面', () => {
  assert.deepEqual(dropCommands(workspace(), PINNED, 'local'), [
    { name: 'workspace.update', params: { workspaceId: 'app', pinned: true } },
  ])
  assert.deepEqual(dropCommands(workspace(), SECTION, 'local'), [
    { name: 'workspace.update', params: { workspaceId: 'app', sectionId: 'sec-1' } },
  ])
  assert.deepEqual(dropCommands(workspace({ sectionId: 'sec-1' }), SECTION, 'local'), [])
  const before = { kind: 'workspace', workspaceId: 'docs' }
  assert.deepEqual(dropCommands(workspace({ sectionId: 'sec-1' }), before, 'local'), [
    { name: 'workspace.update', params: { workspaceId: 'app', sectionId: null } },
    { name: 'workspace.move', params: { workspaceId: 'app', before: 'docs' } },
  ])
  assert.deepEqual(dropCommands(workspace({ pinned: true }), before, 'local'), [
    { name: 'workspace.update', params: { workspaceId: 'app', pinned: false } },
    { name: 'workspace.move', params: { workspaceId: 'app', before: 'docs' } },
  ])
  assert.deepEqual(
    dropCommands(workspace(), { kind: 'workspace', workspaceId: 'app' }, 'local'),
    [],
  )
})

test('别的设备上拖来的一律不接', () => {
  assert.deepEqual(dropCommands(session(), PINNED, 'remote'), [])
  assert.deepEqual(dropCommands(workspace(), SECTION, 'remote'), [])
})
