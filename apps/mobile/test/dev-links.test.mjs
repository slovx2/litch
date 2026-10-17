// 测试链接（src/shell/dev-links.ts）接在模拟核心上：e2e 和测量全靠它驱动，参数认错了整套用例都会走偏。
// 导航是替身（test/stubs/react-navigation-native.mjs），只记下去了哪一页、带什么参数。
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { createReplica, keys } from '@litch/core'
import { navigated } from '@react-navigation/native'
import { experiment } from '../src/experiment.ts'
import { handleDevLink, navigationRef } from '../src/shell/dev-links.ts'
import { mockChannel, until } from './helpers.mjs'

const mock = mockChannel()
const replica = createReplica(mock.channel)
const stopReplica = replica.start()
after(() => {
  stopReplica?.()
  mock.close()
})
const services = { channel: mock.channel, replica, booted: { mode: 'mock', work: null } }

beforeEach(() => {
  navigated.length = 0
  navigationRef.ready = true
  navigationRef.back = false
})

test('换装法：只认三种，换装法不需要核心已经装好', () => {
  assert.equal(handleDevLink('litch://boot?mode=fixture', null), 'fixture')
  assert.equal(handleDevLink('litch://boot?mode=stored', null), 'stored')
  assert.equal(handleDevLink('litch://boot?mode=mock', null), 'mock')
  assert.equal(handleDevLink('litch://boot?mode=bogus', null), null)
})

test('核心没装好、页面栈没就绪：过一会儿再交', () => {
  assert.equal(handleDevLink('litch://new?prompt=x', null), 'later')
  navigationRef.ready = false
  assert.equal(handleDevLink('litch://home', services), 'later')
})

test('new：在第一台设备上建会话并打开；open=last、send 跟着它走', async () => {
  await until(() => replica.store.get(keys.devices)?.length, { what: '设备列表' })
  assert.equal(handleDevLink('litch://new?prompt=你好', services), null)
  const opened = await until(() => navigated.find((entry) => entry.name === 'Detail'), {
    what: '打开详情页',
  })
  const { deviceId, sessionId, title } = opened.params
  assert.equal(deviceId, replica.store.get(keys.devices)[0])
  assert.equal(title, '你好')
  navigated.length = 0
  handleDevLink('litch://open?session=last&title=再看', services)
  assert.deepEqual(navigated, [{ name: 'Detail', params: { deviceId, sessionId, title: '再看' } }])
  handleDevLink('litch://send?text=第二句', services)
  // 回合不进复制品（没打开会话）：直接向核心要一份会话的快照看
  const snapshot = () =>
    new Promise((resolve) => {
      const stop = mock.channel.subscribe(
        { kind: 'session', deviceId, sessionId },
        { snapshot: (data) => resolve(data) || queueMicrotask(stop), delta() {} },
      )
    })
  for (let tries = 0; (await snapshot()).turns.length < 2; tries++) {
    assert.ok(tries < 100, '第二句发出去了')
    await new Promise((done) => setTimeout(done, 20))
  }
})

test('terminal、diff：带上设备的第一个工作区的根；diff 的范围不认的按 all', async () => {
  const deviceId = replica.store.get(keys.devices)[0]
  const root = await until(() => replica.store.get(keys.workspaces(deviceId))?.[0]?.roots[0], {
    what: '工作区',
  })
  handleDevLink('litch://terminal?terminal=t9', services)
  handleDevLink('litch://diff?scope=staged&session=s1', services)
  handleDevLink('litch://diff?scope=nope&root=/x', services)
  assert.deepEqual(navigated, [
    { name: 'Terminal', params: { deviceId, root, terminalId: 't9' } },
    { name: 'Diff', params: { deviceId, root, scope: 'staged', sessionId: 's1' } },
    { name: 'Diff', params: { deviceId, root: '/x', scope: 'all', sessionId: null } },
  ])
})

test('home：能退就退到最上面；测量开关跟着任何链接一起认', () => {
  handleDevLink('litch://home', services)
  assert.deepEqual(navigated, [])
  navigationRef.back = true
  handleDevLink('litch://home?seal=120&tail=open&markers=1', services)
  assert.deepEqual(navigated, [{ action: { type: 'POP_TO_TOP' } }])
  assert.deepEqual([experiment.seal, experiment.tail, experiment.markers], [120, 'open', true])
})
