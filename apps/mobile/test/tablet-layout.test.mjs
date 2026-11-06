import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tabletLayout } from '../src/nav/tablet-layout.ts'

const devices = { key: 'devices', name: 'Devices' }
const sessions = { key: 'sessions', name: 'Sessions' }
const chat = { key: 'chat', name: 'Detail' }
const terminal = { key: 'terminal', name: 'Terminal' }
const routes = Object.freeze([devices, sessions, chat])

test('平板断点为侧栏 240 加正文 600，宽窗口侧栏最多 300', () => {
  assert.equal(tabletLayout(839, routes, 2).split, false)
  assert.equal(tabletLayout(840, routes, 2).sidebar, 240)
  assert.equal(tabletLayout(899, routes, 2).sidebar, 299)
  assert.equal(tabletLayout(900, routes, 2).sidebar, 300)
  assert.equal(tabletLayout(1600, routes, 2).sidebar, 300)
})

test('旋转、分屏反复收窄和展开只换可见栏，不更改路由实例或选中会话', () => {
  for (const width of [1024, 1366, 700, 500, 840, 1024]) {
    const result = tabletLayout(width, routes, 2)
    assert.equal(result.panes.content, chat.key)
    assert.equal(routes[2], chat)
    assert.equal(result.panes.navigation, width >= 840 ? sessions.key : undefined)
  }
})

test('打开工具才占第三栏；收窄后工具占正文，返回恢复对话', () => {
  const stack = [...routes, terminal]
  assert.deepEqual(tabletLayout(1279, stack, 3).panes, {
    navigation: 'sessions',
    content: 'terminal',
  })
  assert.deepEqual(tabletLayout(1280, stack, 3).panes, {
    navigation: 'sessions',
    content: 'chat',
    tool: 'terminal',
  })
  assert.equal(tabletLayout(1280, stack, 3).tool, 380)
  assert.deepEqual(tabletLayout(500, stack, 3).panes, { content: 'terminal' })
  assert.equal(tabletLayout(1366, stack, 2).panes.content, 'chat')
  assert.equal(tabletLayout(1366, routes, 2).tool, 0)
})

test('经理目录和工作台进入各自栏；没有会话时工具不凭空补一栏', () => {
  const managers = { key: 'managers', name: 'Managers' }
  const board = { key: 'board', name: 'ManagerConsole' }
  assert.deepEqual(tabletLayout(1024, [devices, managers, board], 2).panes, {
    navigation: 'managers',
    content: 'board',
  })
  assert.equal(tabletLayout(1366, [devices, terminal], 1).tool, 0)
  assert.equal(tabletLayout(1024, [devices], 0).panes.content, undefined)
})

test('宽屏浏览另一份目录时保留右侧当前会话，单栏显示当前目录', () => {
  const managers = { key: 'managers', name: 'Managers' }
  const stack = [...routes, managers]
  assert.deepEqual(tabletLayout(1024, stack, 3).panes, { navigation: 'managers', content: 'chat' })
  assert.deepEqual(tabletLayout(700, stack, 3).panes, { content: 'managers' })
})

test('侧栏浏览不改变返回的对话，目录和会话对象都保留', async () => {
  const { orderTabletRoutes } = await import('../src/nav/tablet-layout.ts')
  const ordered = orderTabletRoutes([sessions, chat, devices])
  assert.deepEqual(ordered, [sessions, devices, chat])
  assert.equal(ordered.at(-1), chat)
  assert.equal(tabletLayout(600, ordered, ordered.length - 1).panes.content, chat.key)
})

test('本机分组详情是左栏的目录页：切组只换左栏，右栏留着当前会话', () => {
  const group = { key: 'group', name: 'LocalGroup' }
  const stack = [devices, chat, group]
  assert.deepEqual(tabletLayout(1024, stack, 2).panes, { navigation: 'group', content: 'chat' })
  assert.deepEqual(tabletLayout(700, stack, 2).panes, { content: 'group' })
})
