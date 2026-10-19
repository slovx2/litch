// 给设备装 harness 的界面里的判断：比版本、给哪个按钮、标不标“未验证”、这一项眼下是什么情形。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { compareVersions, installChoice, phaseOf, logTail, runningJob } = await import(
  '../src/install/logic.ts'
)
const { translate } = await import('../src/i18n/index.ts')

const info = (fields = {}) => ({
  harness: 'claude',
  installable: true,
  method: 'script',
  installed: null,
  minimum: '2.1.200',
  verified: '2.1.282',
  latest: '2.1.303',
  latestError: null,
  docsUrl: 'https://example.com',
  manual: 'curl … | bash -s 2.1.282',
  ...fields,
})

const job = (fields = {}) => ({
  job: 'j1',
  harness: 'claude',
  version: 'verified',
  resolved: '2.1.282',
  state: 'running',
  command: 'curl',
  log: [],
  startedAt: 1,
  endedAt: null,
  installed: null,
  failure: null,
  ...fields,
})

const topic = (versions, jobs = []) => ({
  deviceId: 'local',
  available: true,
  versions,
  loading: null,
  error: null,
  jobs,
})

test('比版本：按数字段比，预发布版比同号的正式版旧', () => {
  assert.ok(compareVersions('2.1.303', '2.1.282') > 0)
  assert.ok(compareVersions('1.0.3', '0.99.1') > 0)
  assert.ok(compareVersions('0.99.1', '1.0.0') < 0)
  assert.equal(compareVersions('v2.1.0', '2.1'), 0)
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0') < 0)
  assert.ok(compareVersions('0.2.0-rc.3', '0.2.0-rc.2') > 0)
})

test('没装：默认装验证版，下拉里是最新版（未验证）；没有验证版的只给最新版并标未验证', () => {
  const choice = installChoice(info())
  assert.deepEqual(choice.primary, {
    target: 'verified',
    version: '2.1.282',
    update: false,
    unverified: false,
  })
  assert.deepEqual(choice.more, {
    target: 'latest',
    version: '2.1.303',
    update: false,
    unverified: true,
  })
  // 最新版就是验证版：下拉里不重复
  assert.equal(installChoice(info({ latest: '2.1.282' })).more, null)
  // 还没查最新版
  assert.equal(installChoice(info({ latest: null })).more, null)
  const gemini = installChoice(info({ verified: null, latest: '0.12.0' }))
  assert.deepEqual(gemini.primary, {
    target: 'latest',
    version: '0.12.0',
    update: false,
    unverified: true,
  })
  assert.equal(gemini.more, null)
  // 没有官方方式：一个按钮都不给
  assert.deepEqual(installChoice(info({ installable: false })), { primary: null, more: null })
})

test('装了：最新版更新给“更新到”；不主动降级；低于下限当没装、按钮是“更新”', () => {
  const update = installChoice(info({ installed: '2.1.286' }))
  assert.deepEqual(update.primary, {
    target: 'latest',
    version: '2.1.303',
    update: true,
    unverified: true,
  })
  // 装的比验证版新、也是最新：不给按钮（不提示降级）
  assert.deepEqual(installChoice(info({ installed: '2.1.303' })), { primary: null, more: null })
  // 跨大版本照给，标未验证
  const pi = installChoice(
    info({ installed: '0.99.1', verified: '0.99.1', latest: '1.0.3', minimum: '0.99.1' }),
  )
  assert.deepEqual(pi.primary, {
    target: 'latest',
    version: '1.0.3',
    update: true,
    unverified: true,
  })
  const old = installChoice(info({ installed: '2.1.100' }))
  assert.deepEqual(old.primary, {
    target: 'verified',
    version: '2.1.282',
    update: true,
    unverified: false,
  })
})

test('情形：正在装、别的在装、没装成（点过重新检测之后不再挡着）、刚装上、不用装、只能自己装', () => {
  assert.equal(phaseOf(undefined, 'claude'), 'unknown')
  assert.equal(phaseOf({ ...topic([info()]), available: false }, 'claude'), 'unknown')
  assert.equal(phaseOf(topic([info()]), 'claude'), 'offer')
  assert.equal(phaseOf(topic([info()], [job()]), 'claude'), 'running')
  assert.equal(phaseOf(topic([info(), info({ harness: 'pi' })], [job()]), 'pi'), 'waiting')
  const failed = topic(
    [info()],
    [job({ state: 'failed', failure: { 'zh-CN': '坏了', en: 'broken' } })],
  )
  assert.equal(phaseOf(failed, 'claude'), 'failed')
  assert.equal(phaseOf(failed, 'claude', 'j1'), 'offer')
  assert.equal(phaseOf(topic([info()], [job({ state: 'lost' })]), 'claude'), 'failed')
  assert.equal(
    phaseOf(
      topic([info({ installed: '2.1.282', latest: '2.1.282' })], [job({ state: 'succeeded' })]),
      'claude',
    ),
    'done',
  )
  assert.equal(phaseOf(topic([info({ installed: '2.1.303' })]), 'claude'), 'current')
  assert.equal(phaseOf(topic([info({ installable: false })]), 'claude'), 'manual')
  assert.deepEqual(logTail(['a', 'b', 'c'], 2), ['b', 'c'])
  assert.equal(runningJob(topic([info()], [job()]))?.job, 'j1')
  assert.equal(runningJob(topic([info()])), null)
})

test('文案：两种语言都说得出按钮和版本', () => {
  assert.equal(translate('zh-CN', 'install.update', { version: '2.1.303' }), '更新到 2.1.303')
  assert.equal(translate('en', 'install.update', { version: '2.1.303' }), 'Update to 2.1.303')
  assert.equal(translate('zh-CN', 'install.verifiedBtn', { version: '2.1.282' }), '安装 2.1.282')
  assert.equal(translate('en', 'install.unverified'), 'Unverified')
})
