import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCancel } from '../src/channel/cancel.mjs'
import { firstInstallCommand, installBlocked } from '../src/device/remote-installer.mjs'
import { createRemoteSetup } from '../src/device/remote-setup.mjs'
import type { RemoteCheck, RemoteTarget } from '../src/model.mjs'

const target: RemoteTarget = { kind: 'alias', alias: 'workshop-remote' }
const ready: RemoteCheck = {
  ok: true,
  peer: 'service',
  version: '1.2.3',
  system: 'Linux',
  running: true,
  harnesses: [],
}
function world(blocked: 'system' | 'fetch' | null = null) {
  const calls: string[] = []
  let now = 0
  let check: RemoteCheck = ready
  let fail = ''
  const setup = createRemoteSetup({
    version: '1.2.3',
    now: () => now,
    platform: {
      prepare(wanted, version) {
        assert.deepEqual(wanted, target)
        assert.equal(version, '1.2.3')
        const run = async (step: string) => {
          calls.push(step)
          if (fail === step) throw new Error(`remote-${step}: failure`)
        }
        return {
          inspect: async () => {
            calls.push('inspect')
            return blocked
          },
          download: () => run('download'),
          install: () => run('install'),
          start: () => run('start'),
          clean: () => run('clean'),
        }
      },
    },
    check: async () => {
      calls.push('connect')
      return check
    },
    connected: () => calls.push('retry'),
  })
  return {
    setup,
    calls,
    fail(step: string) {
      fail = step
    },
    check(value: RemoteCheck) {
      check = value
    },
    expire() {
      now = 31 * 60_000
    },
  }
}
const signal = createCancel().signal

test('首次安装：检查只读；目标和应用版本固定，依次下载、安装、启动、握手，连上才重连已保存设备', async () => {
  const w = world()
  const plan = await w.setup.prepare(target, 'workshop-remote', signal)
  assert.deepEqual(w.calls, ['inspect'])
  assert.equal(plan.version, '1.2.3')
  assert.match(plan.command, /download\/v1\.2\.3\/install\.sh/)
  await assert.rejects(w.setup.step(plan.id, 'install', signal), /安装步骤无效/)
  for (const step of ['download', 'install', 'start'] as const)
    assert.equal(await w.setup.step(plan.id, step, signal), null)
  assert.deepEqual(await w.setup.step(plan.id, 'connect', signal), ready)
  assert.deepEqual(w.calls, [
    'inspect',
    'download',
    'install',
    'start',
    'connect',
    'retry',
    'clean',
  ])
  await assert.rejects(w.setup.step(plan.id, 'download', signal), /过期/)
})

for (const reason of ['system', 'fetch'] as const)
  test(`不支持安装：${reason}，只有手动命令，不执行任何安装步骤`, async () => {
    const w = world(reason)
    const plan = await w.setup.prepare(target, 'workshop-remote', signal)
    assert.equal(plan.blocked, reason)
    assert.ok(plan.command)
    await assert.rejects(w.setup.step(plan.id, 'download', signal), /步骤无效/)
    assert.deepEqual(w.calls, ['inspect'])
  })

for (const step of ['download', 'install', 'start'] as const)
  test(`${step}失败，保留远端原话、清理任务，不启动后续步骤`, async () => {
    const w = world()
    w.fail(step)
    const p = await w.setup.prepare(target, 'workshop-remote', signal)
    for (const prior of ['download', 'install', 'start'] as const) {
      if (prior === step) break
      await w.setup.step(p.id, prior, signal)
    }
    await assert.rejects(w.setup.step(p.id, step, signal), new RegExp(`remote-${step}`))
    assert.equal(w.calls.at(-1), 'clean')
    assert.equal(w.calls.includes('retry'), false)
  })

test('启动后握手失败或版本不符：不把设备当作安装并连接成功', async () => {
  for (const check of [
    { ...ready, harnesses: null } as RemoteCheck,
    { ...ready, version: '1.0.0' } as RemoteCheck,
    {
      ok: false,
      failure: {
        stage: 'unreachable',
        text: 'fixture-offline',
        detail: 'remote-closed',
        retrying: false,
      },
    } as RemoteCheck,
  ]) {
    const w = world()
    w.check(check)
    const p = await w.setup.prepare(target, 'workshop-remote', signal)
    for (const step of ['download', 'install', 'start'] as const)
      await w.setup.step(p.id, step, signal)
    if (check.ok) await assert.rejects(w.setup.step(p.id, 'connect', signal), /连接验证/)
    else assert.deepEqual(await w.setup.step(p.id, 'connect', signal), check)
    assert.equal(w.calls.includes('retry'), false)
  }
})

test('重复界面各有计划，同一目标只能有一个进行中的安装；关闭其他界面不影响它', async () => {
  const w = world()
  const a = await w.setup.prepare(target, 'workshop-remote', signal)
  const b = await w.setup.prepare(target, 'workshop-remote', signal)
  await w.setup.step(a.id, 'download', signal)
  await assert.rejects(w.setup.step(b.id, 'download', signal), /尚未完成/)
  await w.setup.drop(b.id)
  await w.setup.step(a.id, 'install', signal)
})

test('用户取消、计划过期都不继续安装', async () => {
  const w = world(),
    cancel = createCancel()
  const p = await w.setup.prepare(target, 'workshop-remote', signal)
  cancel.abort()
  await assert.rejects(w.setup.step(p.id, 'download', cancel.signal), /取消/)
  const q = await w.setup.prepare(target, 'workshop-remote', signal)
  w.expire()
  await assert.rejects(w.setup.step(q.id, 'download', signal), /过期/)
  assert.equal(w.calls.includes('download'), false)
})

test('平台条件按系统和下载工具判断，Windows 不提供一键安装；版本不允许 shell 注入', () => {
  assert.equal(installBlocked({ system: 'MINGW64_NT', downloader: 'yes' }), 'system')
  assert.equal(installBlocked({ system: 'Linux' }), 'fetch')
  assert.equal(installBlocked({ system: 'Darwin', downloader: 'yes' }), null)
  assert.throws(() => firstInstallCommand('1.2.3;touch /fixture'), /版本号/)
})

test('关闭正在下载的界面：等待该次调用结束再清理，不运行安装或回调连接成功', async () => {
  let finish: (() => void) | undefined
  const calls: string[] = []
  const setup = createRemoteSetup({
    version: '1.2.3',
    now: () => 0,
    platform: {
      prepare: () => ({
        inspect: async () => null,
        download: () =>
          new Promise<void>((resolve) => {
            finish = resolve
            calls.push('download')
          }),
        install: async () => {
          calls.push('install')
        },
        start: async () => {},
        clean: async () => {
          calls.push('clean')
        },
      }),
    },
    check: async () => ready,
    connected: () => calls.push('connected'),
  })
  const plan = await setup.prepare(target, 'workshop-remote', signal)
  const downloading = setup.step(plan.id, 'download', signal)
  await setup.drop(plan.id)
  assert.deepEqual(calls, ['download'])
  finish?.()
  await assert.rejects(downloading, /取消/)
  assert.deepEqual(calls, ['download', 'clean'])
})
