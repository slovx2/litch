import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestPermission } from '../src/approvals.mjs'
import { declarationFor } from '../src/declaration.mjs'
import { AcpServer } from '../src/server.mjs'
import { client, dispose, isolate, text, turn, violations } from './client.mjs'

test('agy 默认仍按原生配置审批，完全访问与原生模式均可在回合内切换', () => {
  const fallback = declarationFor('agy', null).permissionPresets
  assert.ok(fallback)
  assert.equal(fallback.length, 2)
  assert.equal(fallback[0]?.id, 'acp:mode:default')
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
    [':danger-full-access', 'acp:mode:default', 'acp:mode:accept-edits', 'acp:mode:plan'],
  )
  assert.ok(configured.every((preset) => preset.switchInSession && preset.switchDuringTurn))
})

async function setup() {
  const isolated = await isolate({ CHA_ACP_AGENT: 'agy' })
  isolated.env.CHA_AGY_CLI = isolated.env.CHA_ACP_CLI
  isolated.env.CHA_AGY_ARGS = isolated.env.CHA_ACP_ARGS
  const server = new AcpServer(isolated.home, isolated.env)
  const desktop = client(server)
  const s = { ...isolated, server, desktop }
  await desktop.call('initialize', {
    capabilities: { litchExtensions: ['threadCapabilities'] },
  })
  return s
}

test('agy 完全访问只放行当前会话且零审批事件；默认权限不变，恢复后保留选择', async () => {
  const s = await setup()
  const { desktop, server } = s
  try {
    const started = await desktop.call('thread/start', {
      cwd: s.cwd,
      permissions: ':danger-full-access',
    })
    const id = started.thread.id
    assert.equal(started.activePermissionProfile.id, ':danger-full-access')
    assert.equal(started.approvalPolicy, 'never')
    assert.ok(
      started.thread.litchCapabilities.permissionPresets.every(
        (preset: any) => preset.switchInSession && preset.switchDuringTurn,
      ),
    )
    desktop.onRequest(() => ({ decision: 'accept' }))
    await turn(s, id, text('run'))
    assert.equal(desktop.requests.length, 0)
    assert.equal(
      desktop.notifications.some((n) =>
        n.params.status?.activeFlags?.includes('waitingOnApproval'),
      ),
      false,
    )
    assert.equal(
      (await s.received()).some((m) => m.result?.outcome?.optionId === 'always'),
      false,
    )
    assert.equal(server.store.getMeta('agyApproval', id), true)
    server.live.delete(id)
    assert.equal((await server.load(id)).agyAutoApprove, true)
    await server.attach(await server.load(id))
    const other = await desktop.call('thread/start', { cwd: s.cwd })
    assert.equal(other.activePermissionProfile.id, 'acp:mode:default')
    await turn(s, other.thread.id, text('run'))
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

test('agy 同一活动回合按最新权限处理下一次请求；没有 allow_once 不扩大为永久允许', async () => {
  const s = await setup()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    await s.desktop.call('turn/start', { threadId: thread.id, input: text('wait') })
    await s.desktop.until('item/agentMessage/delta', (p) => p.delta === '等着')
    const live = s.server.live.get(thread.id)
    assert.ok(live?.running)
    s.desktop.onRequest(() => ({ decision: 'accept' }))
    let sequence = 0
    const ask = (once = true) =>
      requestPermission(
        s.server,
        live,
        {
          toolCall: {
            toolCallId: `probe-${++sequence}`,
            title: 'echo hi',
            kind: 'execute',
            rawInput: { command: 'echo hi' },
          },
          options: [
            { optionId: 'always', kind: 'allow_always', name: 'Always' },
            ...(once ? [{ optionId: 'once', kind: 'allow_once', name: 'Once' }] : []),
          ],
        },
        new AbortController().signal,
      )
    for (const [permissions, expectedCards] of [
      [':danger-full-access', 0],
      ['acp:mode:default', 1],
      [':danger-full-access', 0],
    ] as const) {
      await s.desktop.call('thread/settings/update', { threadId: thread.id, permissions })
      const before = s.desktop.requests.length
      assert.deepEqual(await ask(), { outcome: { outcome: 'selected', optionId: 'once' } })
      assert.equal(s.desktop.requests.length - before, expectedCards)
    }
    s.desktop.onRequest(() => ({ decision: 'decline' }))
    const before = s.desktop.requests.length
    assert.deepEqual(await ask(false), { outcome: { outcome: 'cancelled' } })
    assert.equal(s.desktop.requests.length - before, 1)
    await s.desktop.call('turn/interrupt', { threadId: thread.id })
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})
