import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedStore, keys, sessionDestination } from '@litch/core'
import { resolvedSessionRoute } from '../src/nav/session-route.ts'
import { recentRoute } from '../src/screens/devices/recent-route.ts'
import { managerRouteBelow } from '../src/screens/managers/origin.ts'
import { viewedSession } from '../src/shell/activity.ts'
import { handleDevLink } from '../src/shell/dev-links.ts'
import { navigated } from './stubs/react-navigation-native.mjs'

const store = new KeyedStore()
store.set(keys.managerIds('local'), ['manager'])
store.set(keys.manager('local', 'manager'), { id: 'manager', threadId: 'manager-thread' })
store.set(keys.managersAvailable('local'), true)
const params = { deviceId: 'local', sessionId: 'manager-thread' }
const expected = ['ManagerConsole', { deviceId: 'local', managerId: 'manager' }]
const resolve = (input) =>
  resolvedSessionRoute(input, sessionDestination(store, input.deviceId, input.sessionId))

test('最近的经理与经理目录落到同一工作台，不携带普通详情参数', () => {
  const [, input] = recentRoute(params, '经理')
  assert.deepEqual(resolve(input), expected)
  assert.deepEqual(resolve({ ...params, permissionNotice: '普通对话提示' }), expected)
})

test('开发深链经正式导航入口打开经理，普通会话仍进详情', () => {
  navigated.length = 0
  const services = { replica: { store }, channel: {}, booted: { mode: 'mock' } }
  handleDevLink('litch://open?device=local&session=manager-thread', services)
  assert.equal(navigated[0].name, 'Detail')
  assert.deepEqual(resolve(navigated[0].params), expected)
  store.set(keys.summary('local', 'ordinary'), { id: 'ordinary' })
  handleDevLink('litch://open?device=local&session=ordinary', services)
  assert.equal(resolve(navigated[1].params)[0], 'Detail')
})

for (const entry of [
  '设备会话列表与搜索',
  '@ 会话',
  '父会话与同伴消息来源',
  '子会话回报与子会话行',
  '后台任务会话链接',
  '定时任务运行记录',
  '看板关联与工作线',
  '恢复归档后的会话',
]) {
  test(`${entry}的会话路由统一替换为工作台，返回栈可识别经理`, () => {
    const target = resolve(params)
    assert.deepEqual(target, expected)
    const routes = [
      { key: 'source', name: 'Devices' },
      { key: 'manager', name: target[0], params: target[1] },
      { key: 'line', name: 'Detail', params: { ...params, sessionId: 'line' } },
    ]
    assert.equal(managerRouteBelow(routes, 2, 'local', 'manager')?.key, 'manager')
    assert.equal(routes[0].name, 'Devices', '替换当前路由不增加中间详情层')
  })
}

test('身份未到不呈现普通详情，也不开始最近查看计时；普通子会话不变', () => {
  assert.equal(resolvedSessionRoute(params, undefined), undefined)
  const managers = { get: () => 'manager-thread', destination: () => undefined }
  assert.equal(viewedSession({ name: 'Detail', params }, managers), null)
  managers.destination = () => 'manager'
  assert.equal(viewedSession({ name: 'Detail', params }, managers), null)
  assert.deepEqual(viewedSession({ name: expected[0], params: expected[1] }, managers), params)
  for (const sessionId of ['ordinary', 'child', 'line']) {
    const input = { ...params, sessionId, title: sessionId }
    assert.deepEqual(resolvedSessionRoute(input, null), ['Detail', input])
  }
})
