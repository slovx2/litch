// 侧栏设备行“⋯”里的“重启设备服务”：那一项出不出、能不能点、点不了时写哪句原因；行上什么时候写“重启中”；
// 没做成的原因说成哪一句。不起浏览器：service.ts 只有判断。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { restartFailureKey, restarting, restartItemOf } = await import('../src/devices/service.ts')
const { translate } = await import('../src/i18n/index.ts')

const device = (restart) => ({ connection: 'online', restart })
const idle = { step: 'idle' }
/** 一句话两种语言都说得出来，里面要填的值都填上了 */
const both = (key, args = {}) =>
  ['zh-CN', 'en'].map((lang) => {
    const text = translate(lang, key, args)
    assert.doesNotMatch(text, /\{\w+\}/, `${key} 里有没填上的值`)
    assert.notEqual(text, key, `${lang} 里没有 ${key}`)
    return text
  })

test('这一端做不了（另外指定了入口、手机端）：没有这一项', () => {
  assert.equal(restartItemOf(device(null)), null)
})

test('能做：能点，不带原因', () => {
  assert.deepEqual(restartItemOf(device({ blocked: null, phase: idle })), {
    title: 'restart.menu',
    enabled: true,
    note: null,
  })
  // 上一次的结果还挂着也照样能点
  for (const phase of [
    { step: 'done', at: 1, interrupted: 2 },
    { step: 'failed', at: 1, reason: 'stop', text: null, detail: null },
    { step: 'busy', busy: [] },
  ]) {
    assert.equal(restartItemOf(device({ blocked: null, phase }))?.enabled, true, phase.step)
  }
})

test('做不了：点不了，下面一行写原因，两种语言都有', () => {
  const seen = {}
  for (const blocked of ['offline', 'single', 'managed', 'upgrading']) {
    const item = restartItemOf(device({ blocked, phase: idle }))
    assert.equal(item?.enabled, false)
    assert.equal(item?.title, 'restart.menu')
    seen[blocked] = both(item.note)[0]
  }
  assert.deepEqual(seen, {
    offline: '设备未连接',
    single: '只连接了单个 harness，没有设备服务',
    managed: '服务由前台或服务管理器启动，请用原来的方式重启',
    upgrading: '正在升级设备服务',
  })
})

test('正在做：写“正在重启…”、点不了；行上写“重启中”只在停和等重连时', () => {
  for (const step of ['stopping', 'starting']) {
    const view = device({ blocked: null, phase: { step } })
    assert.deepEqual(restartItemOf(view), {
      title: 'restart.menu.busy',
      enabled: false,
      note: null,
    })
    assert.equal(restarting(view), true)
  }
  for (const phase of [idle, { step: 'busy', busy: [] }, { step: 'done', at: 1, interrupted: 0 }]) {
    assert.equal(restarting(device({ blocked: null, phase })), false, phase.step)
  }
  assert.equal(restarting(device(null)), false)
  assert.deepEqual(both('restart.menu.busy'), ['正在重启…', 'Restarting…'])
})

test('没做成的原因：每一种都有两种语言的说法，接上连接的原因时也填得满', () => {
  for (const reason of ['connect', 'unsupported', 'legacy', 'stop', 'start', 'stale']) {
    const [zh] = both(restartFailureKey(reason))
    both('restart.failed', { name: '本机', reason: zh })
    both('restart.failed.because', { reason: zh, said: '连不上' })
  }
  assert.equal(
    translate('zh-CN', 'restart.failed', {
      name: 'build-01',
      reason: translate('zh-CN', 'restart.failed.stop'),
    }),
    'build-01 的设备服务未能重启：设备服务未能停止',
  )
})

test('做完的提示：英文按个数说单复数', () => {
  assert.equal(
    translate('en', 'restart.done.interrupted', { name: 'build-01', count: 1 }),
    'Restarted the device service on build-01. 1 conversation was interrupted.',
  )
  assert.equal(
    translate('en', 'restart.done.interrupted', { name: 'build-01', count: 3 }),
    'Restarted the device service on build-01. 3 conversations were interrupted.',
  )
  assert.equal(
    translate('zh-CN', 'restart.done.interrupted', { name: 'build-01', count: 3 }),
    '已重启 build-01 的设备服务，3 个会话被打断',
  )
})
