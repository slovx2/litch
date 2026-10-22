// 设置页“按 harness 开关”那棵树和设备详情摘要的判断（src/settings/harness-switches-logic.ts）：
// 设备那一格的三态、点它之后设成什么、哪一列出、离线时任务卡只读、摘要。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { columnShown, deviceCell, editable, harnessRows, hiddenRows, nextForDevice, summaryOf } =
  await import('../src/settings/harness-switches-logic.ts')

const sw = (taskCards, browser, computer) => ({ taskCards, browser, computer })
const device = (harnesses, extra = {}) => ({
  id: 'd',
  connection: 'online',
  harnesses: Object.keys(harnesses).map((id) => ({ id, name: id.toUpperCase() })),
  tools: { browser: true, computer: false, harnesses },
  ...extra,
})

test('设备那一格：全开打勾、全关空、有开有关半选；不知道的不算', () => {
  const d = device({
    cc: sw(true, true, false),
    pi: sw(false, true, false),
    x: sw(null, true, true),
  })
  assert.equal(deviceCell(d, 'taskCards'), 'mixed')
  assert.equal(deviceCell(d, 'browser'), 'on')
  assert.equal(deviceCell(d, 'computer'), 'mixed')
  assert.equal(deviceCell(device({ cc: sw(null, true, false) }), 'taskCards'), 'unknown')
  assert.equal(deviceCell(device({ cc: sw(false, false, false) }), 'browser'), 'off')
  // 一个 harness 都没有：浏览器、Computer Use 看设备一级
  assert.equal(deviceCell(device({}), 'browser'), 'on')
  assert.equal(deviceCell(device({}), 'taskCards'), 'unknown')
  // 半选、全关点了都是整列打开，全开点了整列关掉
  assert.deepEqual(['on', 'off', 'mixed'].map(nextForDevice), [false, true, true])
})

test('按设备声明的顺序列 harness；这台桌面执行不了的那一列不出；离线时任务卡只读，浏览器、Computer Use 照改', () => {
  const d = device({ pi: sw(true, true, false), cc: sw(true, true, false) })
  d.harnesses = [
    { id: 'cc', name: 'Claude Code' },
    { id: 'pi', name: 'Pi' },
    { id: 'gone', name: 'Gone' },
  ]
  assert.deepEqual(
    harnessRows(d).map((row) => row.name),
    ['Claude Code', 'Pi'],
  )
  const bare = device({}, { tools: { browser: null, computer: null, harnesses: {} } })
  assert.equal(columnShown([bare], 'browser'), false)
  assert.equal(columnShown([bare], 'taskCards'), true)
  assert.equal(columnShown([bare, d], 'computer'), true)
  const offline = { ...d, connection: 'offline' }
  assert.equal(editable(offline, 'taskCards', 'on'), false)
  assert.equal(editable(offline, 'browser', 'on'), true)
  assert.equal(editable(d, 'taskCards', 'unknown'), false)
  assert.equal(editable(d, 'taskCards', 'mixed'), true)
})

test('摘要：全开、全关、只对哪几个开着；不知道是 null', () => {
  const d = device({ cc: sw(true, true, true), pi: sw(null, false, false) })
  assert.deepEqual(summaryOf(d, 'taskCards'), { kind: 'all' })
  assert.deepEqual(summaryOf(d, 'browser'), { kind: 'some', names: ['CC'] })
  assert.deepEqual(summaryOf(device({ cc: sw(null, false, false) }), 'browser'), { kind: 'none' })
  assert.equal(summaryOf(device({ cc: sw(null, false, false) }), 'taskCards'), null)
})

test('设置里停用的 harness 不列，设备那一格不算它；启用后照旧列出，值没丢', () => {
  const d = device({ cc: sw(true, true, false), pi: sw(false, false, true) })
  d.harnesses = [
    { id: 'cc', name: 'Claude Code', state: 'ready' },
    { id: 'pi', name: 'Pi', state: 'disabled' },
  ]
  assert.deepEqual(
    harnessRows(d).map((row) => row.id),
    ['cc'],
  )
  assert.deepEqual(
    hiddenRows(d).map((row) => row.id),
    ['pi'],
  )
  assert.equal(deviceCell(d, 'taskCards'), 'on')
  assert.equal(deviceCell(d, 'browser'), 'on')
  assert.equal(deviceCell(d, 'computer'), 'off')
  assert.deepEqual(summaryOf(d, 'computer'), { kind: 'none' })
  // 不可用（比如没装）的照列，只有停用的不列
  d.harnesses[1].state = 'unavailable'
  assert.deepEqual(
    harnessRows(d).map((row) => [row.id, row.switches.computer]),
    [
      ['cc', false],
      ['pi', true],
    ],
  )
  assert.equal(deviceCell(d, 'computer'), 'mixed')
})
