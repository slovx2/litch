// 验证已经存在的经理按设备熟悉的重置入口升级，仍保留原线程。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DeviceServer } from '../packages/device/dist/packages/device/src/device.mjs'
import { FakeEngine } from '../packages/device/dist/packages/device/test/fake-engine.mjs'
import { TestClient } from '../packages/device/dist/packages/device/test/helpers.mjs'
import { until } from '../packages/device/dist/packages/device/test/tree-kit.mjs'

test('旧 Claude 经理先显示能力落后，原地刷新才启用外部工具', { timeout: 15_000 }, async (t) => {
  const state = mkdtempSync('/tmp/lg-old-manager-')
  const claude = new FakeEngine('claude-code')
  const options = {
    stateDir: state,
    upstreams: [{ id: 'claude-code', connect: claude.connector }],
    importExisting: false,
    wrapUpReminder: false,
  }
  let device = new DeviceServer(options)
  t.after(async () => {
    await device.close()
    rmSync(state, { recursive: true, force: true })
  })
  const names = ['harness', 'clientTools', 'litchManager', 'litchManagerIssues']
  const old = new TestClient(device)
  await old.initialize(names)
  const { manager } = await old.call('litch/manager/create', {
    cwd: state,
    harness: 'claude-code',
    model: null,
    effort: null,
    name: 'Old manager',
    scope: '',
    rules: '',
    firstTask: '',
    template: 'blank',
    permission: null,
    dispatch: {
      harness: 'claude-code',
      model: null,
      effort: null,
      worktree: false,
      merge: 'manager',
      maxRunningLines: 2,
    },
    contact: { desktopNotification: false, unanswered: 'wait' },
  })
  await until(() => claude.running(manager.threadId), '旧经理首回合')
  claude.end(manager.threadId, 'completed', 'Done')
  await until(() => !device.sessionTree.activeTurn(manager.threadId), '旧回合已结束')
  assert.equal(device.managers.manager(manager.id).reset.outdated, false)
  await device.close()

  device = new DeviceServer({ ...options, external: { runtimeRoot: join(state, 'test-runtime') } })
  const readyManager = () => device.managers.manager(manager.id)
  assert.equal(readyManager().reset.outdated, true)
  assert.deepEqual(device.managers.externalReady(readyManager()), {
    ready: false,
    reason: 'manager_tools_outdated',
    action: 'refresh',
  })
  const next = new TestClient(device)
  await next.initialize([...names, 'litchExternalSources'])
  await next.call('litch/manager/reset', { managerId: manager.id })
  await until(() => readyManager().reset.phase === 'ready', '原地刷新，工具已安装', 5000)
  assert.equal(readyManager().threadId, manager.threadId)
  assert.deepEqual(device.managers.externalReady(readyManager()), { ready: true })
  const tools = claude.threads
    .find(({ id }) => id === manager.threadId)
    .dynamicTools.find(({ name }) => name === 'litch_manager')
    .tools.map(({ name }) => name)
  for (const required of ['external_read', 'external_write', 'external_accept', 'external_link'])
    assert.ok(tools.includes(required), required)
})
