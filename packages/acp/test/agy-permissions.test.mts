import assert from 'node:assert/strict'
import { test } from 'node:test'
import { declarationFor } from '../src/declaration.mjs'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, isolate, text, turn, violations } from './client.mjs'

test('agy 未获原生模式前明确按配置审批，原生模式到达后移除无效的完全访问选项', () => {
  const fallback = declarationFor('agy', null).permissionPresets
  assert.ok(fallback)
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0]?.id, ':danger-full-access')
  assert.equal(fallback[0]?.title['zh-CN'], '按 agy 配置审批')
  const configured = declarationFor('agy', null, {
    models: null,
    modes: null,
    configOptions: [
      {
        id: 'mode',
        type: 'select',
        category: 'mode',
        currentValue: 'default',
        options: ['default', 'accept-edits', 'plan'].map((value) => ({ value, name: value })),
      },
    ],
  }).permissionPresets
  assert.ok(configured)
  assert.deepEqual(
    configured.map((preset) => preset.id),
    ['acp:mode:default', 'acp:mode:accept-edits', 'acp:mode:plan'],
  )
  assert.ok(configured.every((preset) => preset.switchInSession && !preset.switchDuringTurn))
})

test('agy 按原生模式回显、空闲时立即切换；完全访问兜底不等于跳过审批', async () => {
  const isolated = await isolate({ CHA_ACP_AGENT: 'agy' })
  isolated.env.CHA_AGY_CLI = isolated.env.CHA_ACP_CLI
  isolated.env.CHA_AGY_ARGS = isolated.env.CHA_ACP_ARGS
  const server = new AcpServer(isolated.home, isolated.env)
  const desktop = client(server)
  const s = { ...isolated, server, desktop }
  try {
    await desktop.call('initialize', {
      capabilities: { litchExtensions: ['threadCapabilities'] },
    })
    const started = await desktop.call('thread/start', {
      cwd: s.cwd,
      permissions: ':danger-full-access',
    })
    const id = started.thread.id
    assert.equal(started.activePermissionProfile.id, 'acp:mode:default')
    assert.equal(started.approvalPolicy, 'on-request')
    assert.ok(
      started.thread.litchCapabilities.permissionPresets.every(
        (preset: any) => preset.id !== ':danger-full-access' && preset.switchInSession,
      ),
    )
    desktop.onRequest(() => ({ decision: 'accept' }))
    await turn(s, id, text('run'))
    assert.ok(
      desktop.requests.some(
        (request) => request.method === 'item/commandExecution/requestApproval',
      ),
    )
    for (const mode of ['plan', 'default']) {
      await desktop.call('thread/settings/update', {
        threadId: id,
        permissions: `acp:mode:${mode}`,
      })
      const updated = desktop.notifications
        .filter((n) => n.method === 'thread/settings/updated')
        .at(-1)
      assert.equal(updated.params.threadSettings.activePermissionProfile.id, `acp:mode:${mode}`)
      assert.ok(
        (await s.received()).some(
          (message) => message.method === 'session/set_mode' && message.params.modeId === mode,
        ),
      )
    }
    for (const permissions of [':read-only', ':workspace'])
      await assert.rejects(
        desktop.call('thread/settings/update', { threadId: id, permissions }),
        /不提供此沙箱权限档/,
      )
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})
