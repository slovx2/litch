// 手机的「最近」（src/shell/activity.ts）：前台 = 应用 active + 当前页是这个会话的详情页。
// 查看满 5 秒才记、记达标那一刻；后台、锁屏、离开会话页清零；主动操作立即记；点开清未读不进最近。
// 规则本身在核心的 SidebarActivity，这里守的是手机把前后台、导航接对了，以及接上 replica 后投影真的变。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createReplica, keys } from '@litch/core'
import { files } from 'expo-file-system'
import { recentRoute } from '../src/screens/devices/recent-route.ts'
import { readRecentSettings } from '../src/screens/devices/recent-settings.ts'
import { createMobileActivity, viewedSession, watchMobileActivity } from '../src/shell/activity.ts'
import { jsonFile } from '../src/shell/json-file.ts'
import { mockChannel, until } from './helpers.mjs'

const cleanup = []
afterEach(() => {
  for (const done of cleanup.splice(0).reverse()) done()
  files.clear()
})

/** 手动拨的钟：advance 走到点就触发到期的定时器 */
function fakeClock(start = 1_000_000) {
  let now = start
  let timers = []
  return {
    now: () => now,
    setTimer(callback, delayMs) {
      const timer = { at: now + delayMs, callback }
      timers.push(timer)
      return () => {
        timers = timers.filter((entry) => entry !== timer)
      }
    },
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((entry) => entry.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((entry) => entry !== due)
        now = due.at
        due.callback()
      }
      now = end
    },
  }
}

/** 假的 AppState：set 换状态并通知 */
function fakeApp(state = 'active') {
  const listeners = new Set()
  return {
    current: () => state,
    listen(changed) {
      listeners.add(changed)
      return () => listeners.delete(changed)
    },
    set(next) {
      state = next
      for (const listener of listeners) listener(next)
    },
  }
}

/** 假的导航：go 换当前页并发 state 事件 */
function fakeNavigation(route = { name: 'Devices' }) {
  const listeners = new Set()
  return {
    current: () => route,
    listen(changed) {
      listeners.add(changed)
      return () => listeners.delete(changed)
    },
    go(name, params) {
      route = { name, params }
      for (const listener of listeners) listener()
    },
  }
}

const detail = (sessionId, deviceId = 'local') => ['Detail', { deviceId, sessionId }]

/** 只记下发过的命令、一律成功的通道 */
function fakeChannel() {
  const sent = []
  return {
    sent,
    channel: {
      async command(name, params) {
        sent.push({ name, params })
        return {}
      },
      subscribe: () => () => {},
      close() {},
    },
  }
}

function setup({ app = 'active', managers } = {}) {
  const clock = fakeClock()
  const start = clock.now()
  const file = jsonFile('test-sidebar-activity.json')
  const { channel, sent } = fakeChannel()
  const activity = createMobileActivity(channel, clock, file)
  const appState = fakeApp(app)
  const navigation = fakeNavigation()
  const stop = watchMobileActivity(activity, appState, navigation, managers)
  cleanup.push(stop)
  return { clock, start, file, sent, activity, app: appState, navigation }
}

test('只有会话详情页、参数齐全才算在看会话', () => {
  assert.deepEqual(viewedSession({ name: 'Detail', params: { deviceId: 'd', sessionId: 's' } }), {
    deviceId: 'd',
    sessionId: 's',
  })
  assert.equal(viewedSession({ name: 'Sessions', params: { deviceId: 'd' } }), null)
  assert.equal(viewedSession({ name: 'Agent', params: { deviceId: 'd', sessionId: 's' } }), null)
  assert.equal(viewedSession({ name: 'Detail', params: { deviceId: 'd' } }), null)
  assert.equal(viewedSession(undefined), null)
})

test('最近经理与普通会话都进对话详情，不依赖经理目录', () => {
  const row = { deviceId: 'local', sessionId: 'manager-thread', workspaceId: null, at: 1 }
  assert.deepEqual(recentRoute(row, '经理'), [
    'Detail',
    { deviceId: 'local', sessionId: 'manager-thread', title: '经理' },
  ])
  assert.deepEqual(recentRoute({ ...row, sessionId: 'normal' }, '普通'), [
    'Detail',
    { deviceId: 'local', sessionId: 'normal', title: '普通' },
  ])
})

test('经理控制台的目录迟到后开始计时，离开和后台清零', () => {
  let thread
  const listeners = new Set()
  const env = setup({
    managers: {
      get: (deviceId, id) => (deviceId === 'local' && id === 'm' ? thread : undefined),
      subscribe: (_device, _manager, changed) => {
        listeners.add(changed)
        return () => listeners.delete(changed)
      },
    },
  })
  env.navigation.go('ManagerConsole', { deviceId: 'local', managerId: 'm' })
  env.clock.advance(10_000)
  assert.equal(env.activity.time('local', 'manager-thread'), 0)
  thread = 'manager-thread'
  for (const listener of listeners) listener()
  env.clock.advance(4999)
  assert.equal(env.activity.time('local', thread), 0)
  env.app.set('background')
  env.clock.advance(10_000)
  env.app.set('active')
  env.clock.advance(4999)
  assert.equal(env.activity.time('local', thread), 0)
  env.clock.advance(1)
  assert.equal(env.activity.time('local', thread), env.clock.now())
  env.navigation.go('Devices')
  assert.equal(listeners.size, 0)
  const at = env.activity.time('local', thread)
  env.clock.advance(10_000)
  assert.equal(env.activity.time('local', thread), at)
})

test('前台停留满 5 秒才记，时间是满 5 秒那一刻；同一段停留只记一次', () => {
  const env = setup()
  env.navigation.go(...detail('s1'))
  env.clock.advance(4999)
  assert.equal(env.activity.time('local', 's1'), 0, '不到 5 秒不记')
  env.clock.advance(1)
  assert.equal(env.activity.time('local', 's1'), env.start + 5000)
  env.clock.advance(60_000)
  assert.equal(env.activity.time('local', 's1'), env.start + 5000, '一直停着不重复刷新')
})

test('切到后台清零，回来要重新满 5 秒，不累计碎片时间', () => {
  const env = setup()
  env.navigation.go(...detail('s1'))
  env.clock.advance(4000)
  env.app.set('background')
  env.clock.advance(10_000)
  assert.equal(env.activity.time('local', 's1'), 0, '后台时不记')
  env.app.set('active')
  env.clock.advance(4000)
  assert.equal(env.activity.time('local', 's1'), 0, '4 秒 + 4 秒不算')
  env.clock.advance(1000)
  assert.equal(env.activity.time('local', 's1'), env.start + 14_000 + 5000)
})

test('锁屏清零：iOS 先 inactive 再 background，安卓直接 background；拉下通知中心也算离开前台', () => {
  for (const steps of [['inactive', 'background'], ['background'], ['inactive']]) {
    const env = setup()
    env.navigation.go(...detail('s1'))
    env.clock.advance(3000)
    for (const state of steps) env.app.set(state)
    env.clock.advance(5000)
    assert.equal(env.activity.time('local', 's1'), 0, `${steps.join(' → ')} 时不记`)
    env.app.set('active')
    env.clock.advance(5000)
    assert.equal(env.activity.time('local', 's1'), env.start + 8000 + 5000, '解锁后重新计满')
  }
})

test('启动时不在前台：不计时，到了前台才开始', () => {
  const env = setup({ app: 'background' })
  env.navigation.go(...detail('s1'))
  env.clock.advance(10_000)
  assert.equal(env.activity.time('local', 's1'), 0)
  env.app.set('active')
  env.clock.advance(5000)
  assert.equal(env.activity.time('local', 's1'), env.start + 15_000)
})

test('离开会话页清零；进子会话换成给子会话计时，回到父会话重新计', () => {
  const env = setup()
  env.navigation.go(...detail('s1'))
  env.clock.advance(4000)
  env.navigation.go('Terminal', { deviceId: 'local', root: '/w' })
  env.clock.advance(5000)
  assert.equal(env.activity.time('local', 's1'), 0, '终端页不算在看会话')
  env.navigation.go(...detail('s1'))
  env.clock.advance(3000)
  env.navigation.go(...detail('child'))
  env.clock.advance(5000)
  assert.equal(env.activity.time('local', 's1'), 0)
  assert.equal(env.activity.time('local', 'child'), env.start + 12_000 + 5000)
  env.navigation.go('Devices')
  env.clock.advance(10_000)
  env.navigation.go(...detail('s1'))
  env.clock.advance(5000)
  assert.equal(env.activity.time('local', 's1'), env.start + 27_000 + 5000)
})

test('主动操作立即记，不看前台和当前页；点开清未读不算', async () => {
  const env = setup({ app: 'background' })
  await env.activity.channel.command('session.markRead', { deviceId: 'local', sessionId: 's1' })
  assert.equal(env.activity.time('local', 's1'), 0)
  env.clock.advance(100)
  await env.activity.channel.command('session.respond', {
    deviceId: 'local',
    sessionId: 's1',
    requestId: 'r',
    decision: 'approve',
  })
  assert.equal(env.activity.time('local', 's1'), env.start + 100, '通知栏里批准也立即记')
  await env.activity.channel.command('session.interrupt', { deviceId: 'local', sessionId: 's2' })
  assert.ok(env.activity.time('local', 's2') > env.start + 100, '停止也算，排在后面')
  assert.deepEqual(
    env.sent.map((entry) => entry.name),
    ['session.markRead', 'session.respond', 'session.interrupt'],
    '命令照样发给核心',
  )
})

test('记录存在本机：一秒内合并写一次，退到后台立即写，下次启动读回来', () => {
  const env = setup()
  env.navigation.go(...detail('s1'))
  env.clock.advance(5000)
  assert.equal(env.file.read(), null, '还没到合并写的时间')
  env.app.set('background')
  assert.deepEqual(env.file.read(), [{ deviceId: 'local', sessionId: 's1', at: env.start + 5000 }])
  const again = createMobileActivity(fakeChannel().channel, fakeClock(), env.file)
  assert.equal(again.time('local', 's1'), env.start + 5000)
})

test('停止监听后不再计时', () => {
  const env = setup()
  env.navigation.go(...detail('s1'))
  env.clock.advance(1000)
  cleanup.pop()()
  env.clock.advance(10_000)
  assert.equal(env.activity.time('local', 's1'), 0)
})

test('接上 replica：主动操作（改名）立即进「最近」投影，点开清未读不进', async () => {
  const mock = mockChannel()
  const clock = fakeClock(Date.now())
  const activity = createMobileActivity(mock.channel, clock, jsonFile('replica-activity.json'))
  const replica = createReplica(activity.channel, activity)
  const stopReplica = replica.start()
  const app = fakeApp('background')
  const stopWatch = watchMobileActivity(activity, app, fakeNavigation())
  cleanup.push(() => {
    stopWatch()
    stopReplica()
    mock.close()
  })
  const recent = () =>
    replica.store.get(keys.sidebarProjections('local'))?.recent.map((row) => row.sessionId) ?? []
  await until(() => replica.store.get(keys.summary('local', 's3')), { what: '侧栏' })
  assert.deepEqual(recent(), [], '没有记录时为空，不拿更新时间回填')
  await activity.channel.command('session.markRead', { deviceId: 'local', sessionId: 's3' })
  assert.deepEqual(recent(), [], '清未读不进最近')
  await activity.channel.command('session.rename', {
    deviceId: 'local',
    sessionId: 's3',
    title: '改个名',
  })
  await until(() => recent().includes('s3'), { what: '改名后进最近' })
  await until(() => replica.store.get(keys.manager('local', 'm1')), { what: '经理目录' })
  await activity.channel.command('managers.update', {
    deviceId: 'local',
    managerId: 'm1',
    patch: { name: '经理操作' },
  })
  await until(() => recent()[0] === 'm1', { what: '经理操作立即进最近' })
  await activity.channel.command('session.rename', {
    deviceId: 'local',
    sessionId: 'manager-k2',
    title: '工作线操作',
  })
  assert.equal(recent()[0], 'm1')
  assert.equal(recent().includes('manager-k2'), false)
  assert.ok(replica.store.get(keys.children('local')).m1.includes('manager-k2'))
  await activity.channel.command('session.markRead', {
    deviceId: 'local',
    sessionId: 'manager-k2',
  })
  await until(() => !replica.store.get(keys.summary('local', 'manager-k2')).unread, {
    what: '工作线清未读',
  })
  assert.equal(recent()[0], 'm1', '清掉最后一个工作线未读不移除最近中的经理主项')
  assert.ok(recent().includes('s3'), '普通已读会话也仍在最近')
})

test('快捷设置：默认不聚合、显示 5 条，只认 5/10/20', () => {
  assert.deepEqual(readRecentSettings(null), { collapsed: false, byProject: false, first: 5 })
  assert.deepEqual(readRecentSettings({ collapsed: true, byProject: true, first: 20 }), {
    collapsed: true,
    byProject: true,
    first: 20,
  })
  assert.equal(readRecentSettings({ first: 7 }).first, 5)
})
