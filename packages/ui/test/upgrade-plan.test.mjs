import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_UPGRADE_CHOICE,
  upgradeCandidate,
  upgradeChoices,
} from '../src/devices/upgrade-plan.ts'

const local = {
  kind: 'local',
  connection: 'online',
  mode: 'full',
  upgrade: { bundled: { version: '1.0.0' }, action: 'kept', reason: 'busy' },
  restart: { blocked: null, phase: { step: 'idle' } },
}
const remote = {
  kind: 'ssh',
  connection: 'online',
  mode: 'full',
  remoteUpgrade: {
    target: '1.0.0',
    capable: true,
    managed: false,
    action: 'upgrade',
    method: 'script',
    phase: { step: 'idle' },
  },
}

test('默认空闲升级；远程可安装或已安装新版都提供强制，不受忙闲能力位影响', () => {
  assert.equal(DEFAULT_UPGRADE_CHOICE, 'idle')
  assert.equal(upgradeCandidate(local, '1.0.0'), true)
  assert.deepEqual(upgradeChoices(local), ['none', 'idle', 'force'])
  assert.equal(
    upgradeCandidate(
      { ...local, upgrade: { ...local.upgrade, action: 'replaced', reason: null } },
      '1.0.0',
    ),
    false,
  )
  assert.equal(upgradeCandidate(remote, '1.0.0'), true)
  assert.deepEqual(upgradeChoices(remote), ['none', 'idle', 'force'])
  assert.deepEqual(
    upgradeChoices({ ...remote, remoteUpgrade: { ...remote.remoteUpgrade, method: null } }),
    ['none', 'idle'],
  )
  const installed = { ...remote, remoteUpgrade: { ...remote.remoteUpgrade, action: 'swap' } }
  assert.deepEqual(upgradeChoices(installed), ['none', 'idle', 'force'])
  for (const patch of [{ capable: false }, { managed: true }, { phase: { step: 'installing' } }])
    assert.deepEqual(
      upgradeChoices({ ...installed, remoteUpgrade: { ...installed.remoteUpgrade, ...patch } }),
      ['none', 'idle'],
    )
  assert.deepEqual(upgradeChoices({ ...installed, connection: 'error' }), ['none', 'idle'])
})

test('离线、最新版本、等待中、不能自动管理的设备不列', () => {
  assert.equal(upgradeCandidate({ ...remote, connection: 'error' }, '1.0.0'), false)
  assert.equal(upgradeCandidate({ ...remote, remoteUpgrade: null }, '1.0.0'), false)
  assert.equal(
    upgradeCandidate({ ...local, restart: { ...local.restart, autoUpgrade: true } }, '1.0.0'),
    false,
  )
  assert.equal(
    upgradeCandidate(
      { ...remote, remoteUpgrade: { ...remote.remoteUpgrade, managed: true } },
      '1.0.0',
    ),
    false,
  )
  assert.equal(upgradeCandidate(remote, '2.0.0'), false)
})

test('忙碌文案区分后台任务与定时任务，保留命令摘要', async () => {
  const { busyLine } = await import('../src/devices/service.ts')
  assert.deepEqual(
    busyLine(
      { reason: 'backgroundTasks', harnesses: [], count: 1, details: ['npm run dev'] },
      (id) => id,
      '、',
    ),
    {
      key: 'service.busy.backgroundTasks',
      args: { count: 1, names: 'npm run dev' },
    },
  )
  assert.equal(
    busyLine({ reason: 'tasks', harnesses: [], count: 1 }, (id) => id, '、').key,
    'service.busy.tasks',
  )
})
