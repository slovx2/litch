// 远程设备操作这台电脑的界面里的判断：顶栏标记出不出、按设备分组、倒计时、长命令折不折、
// 自定义禁止位置的增删、记录结果的颜色，以及两种语言的文案。不起浏览器：logic.ts 只有判断。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  addPath,
  byDevice,
  countdown,
  FOLD_CHARS,
  FOLD_LINES,
  foldOf,
  markerFacts,
  removePath,
  resultTone,
  soonestFirst,
  tidyPath,
} = await import('../src/machine/logic.ts')
const { translate } = await import('../src/i18n/index.ts')

const proc = (id, deviceId, startedAt) => ({
  id,
  deviceId,
  deviceName: deviceId,
  sessionId: null,
  harness: null,
  command: 'sleep 1',
  cwd: '~',
  startedAt,
})
const pend = (id, expiresAt) => ({
  id,
  deviceId: 'build',
  deviceName: 'build',
  host: 'dev@build',
  harness: null,
  ask: {
    kind: 'machine',
    action: 'read',
    command: null,
    cwd: null,
    path: '~/a',
    copy: null,
    flagged: [],
  },
  options: [],
  expiresAt,
})

test('顶栏标记：什么都没有不出；有进程、有待处理、有设备设了“不确认”都出', () => {
  assert.equal(markerFacts(undefined, []), null)
  assert.equal(markerFacts({ running: [], pending: [] }, []), null)
  // 关着的设备设了“不确认”不算；开着的、逐条确认的也不算
  assert.equal(
    markerFacts({ running: [], pending: [] }, [
      { deviceId: 'a', enabled: false, approval: 'never' },
      { deviceId: 'b', enabled: true, approval: 'each' },
    ]),
    null,
  )
  const facts = markerFacts(
    { running: [proc('1', 'a', 1), proc('2', 'b', 2), proc('3', 'a', 3)], pending: [pend('p', 9)] },
    [{ deviceId: 'c', enabled: true, approval: 'never' }],
  )
  assert.deepEqual(facts, { running: 3, pending: 1, devices: ['a', 'b'], never: ['c'] })
  assert.deepEqual(
    markerFacts({ running: [], pending: [] }, [
      { deviceId: 'c', enabled: true, approval: 'never' },
    ]),
    { running: 0, pending: 0, devices: [], never: ['c'] },
  )
})

test('弹层：进程按设备分开、同一台里新的在前；待处理快作废的在前', () => {
  const groups = byDevice([proc('1', 'a', 1), proc('2', 'b', 2), proc('3', 'a', 3)])
  assert.deepEqual(
    groups.map((group) => group.map((entry) => entry.id)),
    [['3', '1'], ['2']],
  )
  assert.deepEqual(
    soonestFirst([pend('x', 30), pend('y', 10), pend('z', 20)]).map((entry) => entry.id),
    ['y', 'z', 'x'],
  )
})

test('倒计时写成分:秒，过了是 0:00', () => {
  assert.equal(countdown(10 * 60_000, 0), '10:00')
  assert.equal(countdown(61_500, 0), '1:02')
  assert.equal(countdown(9_000, 0), '0:09')
  assert.equal(countdown(0, 5_000), '0:00')
})

test('长命令才折：行数或字数超过上限', () => {
  assert.deepEqual(foldOf('ls -la'), { folded: false, lines: 1 })
  const lines = Array.from({ length: FOLD_LINES + 1 }, (_, index) => `echo ${index}`).join('\n')
  assert.deepEqual(foldOf(lines), { folded: true, lines: FOLD_LINES + 1 })
  assert.equal(foldOf('x'.repeat(FOLD_CHARS)).folded, false)
  assert.equal(foldOf('x'.repeat(FOLD_CHARS + 1)).folded, true)
})

test('自定义禁止位置：去掉首尾空白和结尾的斜杠，空的、重复的不加；删掉一条', () => {
  assert.equal(tidyPath('  ~/.aws/ '), '~/.aws')
  assert.equal(tidyPath('/'), '/')
  assert.equal(tidyPath('///'), '/')
  assert.deepEqual(addPath(['~/.ssh'], '  '), { problem: 'empty' })
  assert.deepEqual(addPath(['~/.ssh'], '~/.ssh/'), { problem: 'dup' })
  assert.deepEqual(addPath(['~/.ssh'], ' ~/secrets '), { list: ['~/.ssh', '~/secrets'] })
  assert.deepEqual(removePath(['~/.ssh', '~/secrets'], '~/.ssh'), ['~/secrets'])
})

test('记录结果的颜色：完成是 ok，失败是 err，拦下、拒绝、没人答、开关关着是 wait', () => {
  assert.equal(resultTone('ok'), 'ok')
  assert.equal(resultTone('failed'), 'err')
  for (const result of ['declined', 'blocked', 'expired', 'disabled']) {
    assert.equal(resultTone(result), 'wait')
  }
})

test('文案：全部停的问话只说有的那一样；英文的复数', () => {
  assert.equal(
    translate('zh-CN', 'machine.pop.stopAll.ask', { running: 2, pending: 0 }),
    '结束 2 个命令？',
  )
  assert.equal(
    translate('zh-CN', 'machine.pop.stopAll.ask', { running: 1, pending: 3 }),
    '结束 1 个命令、拒绝 3 项待处理？',
  )
  assert.equal(
    translate('en', 'machine.pop.stopAll.ask', { running: 0, pending: 2 }),
    'Decline 2 pending?',
  )
  assert.equal(
    translate('en', 'machine.pop.stopAll.ask', { running: 1, pending: 1 }),
    'End 1 command and decline 1 pending?',
  )
  assert.equal(translate('en', 'machine.mark.running', { count: 1 }), '1 command')
  assert.equal(
    translate('en', 'machine.mark.runningBy', { device: 'build-01', count: 2 }),
    'build-01 is running 2 commands on this computer',
  )
  assert.equal(translate('en', 'machine.ask.more', { lines: 9 }), 'Show all (9 lines)')
})
