// 侧栏的拖放规则（sidebar/drop.ts）：拖的是什么、放到哪、放下去发什么命令。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。真拖一下的那一半在预览里验
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { dropCommands, slotOf } = await import('../src/sidebar/drop.ts')

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

// 设备上的顺序：置顶的 top，组 sec-1 里的 s1、s2，其余（“项目”里）的 app、docs、web
const ORDER = [
  { id: 'app', pinned: false, sectionId: null },
  { id: 's1', pinned: false, sectionId: 'sec-1' },
  { id: 'docs', pinned: false, sectionId: null },
  { id: 'top', pinned: true, sectionId: null },
  { id: 's2', pinned: false, sectionId: 'sec-1' },
  { id: 'web', pinned: false, sectionId: null },
]
const PROJECTS = { kind: 'projects' }
const slot = (band, before) => ({ kind: 'slot', band, before })
const update = (params) => ({ name: 'workspace.update', params: { workspaceId: 'app', ...params } })
const move = (before) => ({ name: 'workspace.move', params: { workspaceId: 'app', before } })

test('工作区：放进置顶、组是排到那一组的最后（整张表里那一组最后一个的下一个前面）', () => {
  assert.deepEqual(dropCommands(workspace(), PINNED, 'local', ORDER), [
    update({ pinned: true }),
    move('s2'),
  ])
  assert.deepEqual(dropCommands(workspace(), SECTION, 'local', ORDER), [
    update({ sectionId: 'sec-1' }),
    move('web'),
  ])
  // 空的组：只换组，不用挪
  assert.deepEqual(
    dropCommands(workspace(), { kind: 'section', sectionId: 'empty' }, 'local', ORDER),
    [update({ sectionId: 'empty' })],
  )
  // 已经是那一组的最后一个：什么都不做
  const last = workspace({ id: 's2', workspaceId: 's2', sectionId: 'sec-1' })
  assert.deepEqual(dropCommands(last, SECTION, 'local', ORDER), [])
})

test('工作区：拖回“项目”就是从置顶、组里拿出来，排到“项目”的最后', () => {
  assert.deepEqual(dropCommands(workspace({ sectionId: 'sec-1' }), PROJECTS, 'local', ORDER), [
    update({ sectionId: null }),
    move(null),
  ])
  assert.deepEqual(dropCommands(workspace({ pinned: true }), PROJECTS, 'local', ORDER), [
    update({ pinned: false }),
    move(null),
  ])
  // 插到“项目”里两个之间
  assert.deepEqual(
    dropCommands(workspace({ sectionId: 'sec-1' }), slot(PROJECTS, 'web'), 'local', ORDER),
    [update({ sectionId: null }), move('web')],
  )
  // 本来就在“项目”里、也是最后一个
  const web = workspace({ id: 'web', workspaceId: 'web' })
  assert.deepEqual(dropCommands(web, PROJECTS, 'local', ORDER), [])
})

test('工作区：同一组里插到两个之间；落下去还是原处的不接', () => {
  assert.deepEqual(dropCommands(workspace(), slot(PROJECTS, 'web'), 'local', ORDER), [move('web')])
  assert.deepEqual(dropCommands(workspace(), slot(PROJECTS, null), 'local', ORDER), [move(null)])
  // 插到自己前面、插到自己后面那一个的前面：都还是原处
  assert.deepEqual(dropCommands(workspace(), slot(PROJECTS, 'app'), 'local', ORDER), [])
  assert.deepEqual(dropCommands(workspace(), slot(PROJECTS, 'docs'), 'local', ORDER), [])
  // 往前挪：web 插到 app 前面
  const web = workspace({ id: 'web', workspaceId: 'web' })
  assert.deepEqual(dropCommands(web, slot(PROJECTS, 'app'), 'local', ORDER), [
    { name: 'workspace.move', params: { workspaceId: 'web', before: 'app' } },
  ])
  // 从“项目”插进组里两个之间
  assert.deepEqual(dropCommands(workspace(), slot(SECTION, 's2'), 'local', ORDER), [
    update({ sectionId: 'sec-1' }),
    move('s2'),
  ])
})

test('停在一组里的工作区上：上半截插到它前面，下半截插到下一个前面，最后一个的下半截是组的末尾', () => {
  const siblings = ['app', 'docs', 'web']
  assert.deepEqual(slotOf(PROJECTS, 'docs', false, siblings), slot(PROJECTS, 'docs'))
  assert.deepEqual(slotOf(PROJECTS, 'docs', true, siblings), slot(PROJECTS, 'web'))
  assert.deepEqual(slotOf(PROJECTS, 'web', true, siblings), slot(PROJECTS, null))
})

test('工作区不往工作区那一行、“无项目”里放；会话不往“项目”、两个工作区之间放', () => {
  assert.deepEqual(
    dropCommands(workspace(), { kind: 'workspace', workspaceId: 'docs' }, 'local', ORDER),
    [],
  )
  assert.deepEqual(dropCommands(workspace({ pinned: true }), { kind: 'loose' }, 'local', ORDER), [])
  assert.deepEqual(dropCommands(session({ pinned: true }), PROJECTS, 'local', ORDER), [])
  assert.deepEqual(dropCommands(session(), slot(PROJECTS, 'docs'), 'local', ORDER), [])
})

test('别的设备上拖来的一律不接', () => {
  assert.deepEqual(dropCommands(session(), PINNED, 'remote'), [])
  assert.deepEqual(dropCommands(workspace(), SECTION, 'remote'), [])
})

test('组的先后：记着的照记着的，删掉的组不算，新建的组按设备给的先后接在后面', async () => {
  const { orderBands } = await import('../src/sidebar/drop.ts')
  const present = [':section:a', ':section:b', ':projects']
  assert.deepEqual(orderBands(undefined, present), present)
  assert.deepEqual(orderBands([':projects', ':section:gone', ':section:a'], present), [
    ':projects',
    ':section:a',
    ':section:b',
  ])
})

test('拖一整组：插到另一组前面、后面；停在自己上、落下去还是原处的不接；组不经设备', async () => {
  const { bandsAfter } = await import('../src/sidebar/drop.ts')
  const order = [':section:a', ':section:b', ':projects']
  assert.deepEqual(bandsAfter(order, ':projects', ':section:a', false), [
    ':projects',
    ':section:a',
    ':section:b',
  ])
  assert.deepEqual(bandsAfter(order, ':section:a', ':projects', true), [
    ':section:b',
    ':projects',
    ':section:a',
  ])
  assert.equal(bandsAfter(order, ':projects', ':projects', false), null)
  assert.equal(bandsAfter(order, ':projects', ':section:b', true), null, '本来就在它后面')
  assert.equal(bandsAfter(order, ':section:a', ':section:b', false), null, '本来就在它前面')
  assert.equal(bandsAfter(order, ':pinned', ':section:a', false), null, '置顶不参与排')
  const band = {
    deviceId: 'local',
    kind: 'band',
    id: ':projects',
    workspaceId: null,
    pinned: false,
    sectionId: null,
  }
  assert.deepEqual(dropCommands(band, { kind: 'section', sectionId: 'a' }, 'local', ORDER), [])
  assert.deepEqual(
    dropCommands(workspace(), { kind: 'band', key: ':projects', after: false }, 'local', ORDER),
    [],
  )
})
