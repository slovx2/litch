// 设备详情里远程设备一键升级的判断：什么时候提示、按钮叫什么、什么时候不给按钮只给命令、没做成时给哪几步。
// 不起浏览器：service.ts 只有判断。跑法：npm run test --prefix packages/ui。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  installCommand,
  remoteButtonOf,
  remoteDoneLine,
  remoteNoticeOf,
  remoteOlderLine,
  remotePillOf,
  remoteSteps,
  STOP_IF_IDLE,
  serviceFlagOf,
  staleRemote,
} = await import('../src/devices/service.ts')
const { translate } = await import('../src/i18n/index.ts')

const view = (patch = {}) => ({
  target: '0.16.0',
  running: '0.15.0',
  installed: '0.15.0',
  method: 'script',
  managed: false,
  action: 'upgrade',
  capable: true,
  phase: { step: 'idle' },
  ...patch,
})
const device = (remoteUpgrade, connection = 'online') => ({ connection, remoteUpgrade })
const texts = (steps) => steps.map((entry) => entry.text)

test('比应用旧还没动手：提示“比应用旧”，按钮是“升级”；装着的已经不旧：按钮是“换上新版”', () => {
  assert.equal(remoteNoticeOf(null), null)
  assert.equal(remoteNoticeOf(view()), 'older')
  assert.equal(remoteButtonOf(view()), 'upgrade')
  assert.equal(remoteButtonOf(view({ action: 'swap', installed: '0.16.0' })), 'swap')
  assert.deepEqual(remotePillOf(view()), {
    tone: 'wait',
    key: 'service.remote.sum.stale',
    args: {},
  })
  assert.deepEqual(remoteOlderLine(view()), {
    key: 'service.remote.older',
    args: { from: '0.15.0', to: '0.16.0' },
  })
  assert.deepEqual(remoteOlderLine(view({ running: null })), {
    key: 'service.remote.older.unknown',
    args: { to: '0.16.0' },
  })
  assert.equal(
    translate('zh-CN', 'service.remote.older', { from: '0.15.0', to: '0.16.0' }),
    '正在运行的设备服务为 0.15.0，比应用的 0.16.0 旧。',
  )
})

test('不给按钮的几种：手机端、认不出安装方式（只给命令）、只差换上而有别的东西管着（只给重启的办法）、正在做', () => {
  assert.equal(remoteButtonOf(view({ capable: false })), null)
  assert.deepEqual(remoteSteps(view({ capable: false }), null), [], '手机端只说比应用旧')

  const odd = view({ method: null })
  assert.equal(remoteButtonOf(odd), null)
  assert.deepEqual(texts(remoteSteps(odd, null)), [
    'service.remote.step.script',
    'service.remote.step.brew',
    'service.remote.step.stop',
    'service.remote.step.after',
  ])
  assert.equal(remoteSteps(odd, null)[0].command, installCommand('script', '0.16.0'))

  const managed = view({ action: 'swap', managed: true, installed: '0.16.0' })
  assert.equal(remoteButtonOf(managed), null)
  assert.ok(texts(remoteSteps(managed, null)).includes('service.foreground.brew.restart'))

  // 只装不换的“升级”还是给按钮：装完停在“请用原来的方式重启”
  assert.equal(remoteButtonOf(view({ managed: true })), 'upgrade')

  for (const step of ['installing', 'reconnecting', 'restart']) {
    assert.equal(remoteButtonOf(view({ phase: { step } })), null, step)
  }
  assert.equal(
    remoteButtonOf(view({ phase: { step: 'waiting', busy: [], checking: false } })),
    null,
  )
  assert.equal(remoteButtonOf(view({ phase: { step: 'stopping', force: false } })), null)
})

test('进行中的各步：stopping 里不等闲的那种是 forcing；等空闲时小标说在等', () => {
  assert.equal(remoteNoticeOf(view({ phase: { step: 'stopping', force: false } })), 'stopping')
  assert.equal(remoteNoticeOf(view({ phase: { step: 'stopping', force: true } })), 'forcing')
  const waiting = view({ phase: { step: 'waiting', busy: [], checking: false } })
  assert.equal(remoteNoticeOf(waiting), 'waiting')
  assert.equal(remotePillOf(waiting)?.key, 'service.remote.sum.waiting')
})

test('换上了：说从哪版到哪版，小标是“已更新”，设备行上不再留记号', () => {
  const done = view({ running: '0.16.0', phase: { step: 'done', from: '0.15.0', to: '0.16.0' } })
  assert.deepEqual(remoteDoneLine(done), {
    key: 'service.remote.done',
    args: { from: '0.15.0', to: '0.16.0' },
  })
  assert.equal(remotePillOf(done)?.tone, 'ok')
  assert.equal(staleRemote(device(done)), false)
  assert.equal(
    remoteDoneLine(view({ phase: { step: 'done', from: null, to: '0.16.0' } })).key,
    'service.remote.done.plain',
  )
})

test('设备行的记号：连着、比应用旧（包括正在升级、等着换）才有', () => {
  assert.equal(staleRemote(device(view())), true)
  assert.equal(
    staleRemote(device(view({ phase: { step: 'waiting', busy: [], checking: false } }))),
    true,
  )
  assert.equal(staleRemote(device(view(), 'offline')), false)
  assert.equal(staleRemote(device(null)), false)
})

test('设备列表和侧栏的记号是同一个判断：本机旧而没换成、远程比应用旧，各给各的提示', () => {
  assert.equal(serviceFlagOf({ ...device(view()), upgrade: null }), 'service.remote.flag')
  assert.equal(serviceFlagOf({ ...device(view(), 'offline'), upgrade: null }), null)
  assert.equal(serviceFlagOf({ ...device(null), upgrade: null }), null)
  const busy = { action: 'kept', reason: 'busy' }
  assert.equal(serviceFlagOf({ ...device(null), upgrade: busy }), 'service.flag')
})

test('没做成：按停在哪一步给办法，按钮变成“重试”', () => {
  const failed = (at, patch = {}) =>
    view({ phase: { step: 'failed', at, text: null, detail: 'x' }, ...patch })
  assert.equal(remoteButtonOf(failed('download')), 'upgrade', '没做成可以再来一次')
  assert.deepEqual(texts(remoteSteps(failed('download'), null)), [
    'service.remote.step.script',
    'service.remote.step.from',
    'service.remote.step.stop',
    'service.remote.step.after',
  ])
  const brew = remoteSteps(failed('behind', { method: 'brew' }), null)
  assert.equal(brew[0].command, 'brew upgrade codex-harness-adapter')
  assert.deepEqual(texts(remoteSteps(failed('stop'), null)), [
    'service.remote.step.stop',
    'service.remote.step.after',
  ])
  assert.equal(remoteSteps(failed('stop'), null)[0].command, STOP_IF_IDLE)
  // 太旧停不了：照手工结束的几步，进程号是在跑的服务报的；不知道就不给命令
  assert.ok(texts(remoteSteps(failed('unsupported'), 1203)).includes('service.unsupported.end'))
  assert.deepEqual(remoteSteps(failed('unsupported'), null), [])
  assert.deepEqual(texts(remoteSteps(failed('legacy'), null)), [
    'devices.guide.restartService',
    'devices.guide.restartService.manual',
  ])
})

test('确认卡和可复制的命令：装的是应用的这一版，安装脚本从这一版的发布页取', () => {
  assert.equal(
    installCommand('script', '0.16.0'),
    'curl -fsSL https://github.com/slovx2/litch/releases/download/v0.16.0/install.sh | sh -s -- --version 0.16.0',
  )
  assert.equal(installCommand('brew', '0.16.0'), 'brew upgrade codex-harness-adapter')
  assert.equal(
    translate('en', 'service.remote.confirm.title', { name: 'build-01' }),
    'Upgrade the device service on build-01',
  )
  // 每一种没做成的原因两种语言都有
  for (const at of [
    'connect',
    'fetch',
    'download',
    'install',
    'brew',
    'behind',
    'verify',
    'unsupported',
    'legacy',
    'stop',
    'stale',
  ]) {
    for (const lang of ['zh-CN', 'en']) {
      assert.notEqual(
        translate(lang, `service.remote.failed.${at}`, { to: '0.16.0', installed: '0.15.1' }),
        '',
      )
    }
  }
})
