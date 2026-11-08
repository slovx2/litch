import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { agentSpec } from '../src/agent.mjs'
import { capabilitiesOf } from '../src/declaration.mjs'
import { promptContent } from '../src/turn.mjs'
import { client, dispose, scene, text, turn, violations } from './client.mjs'

const full = {
  loadSession: true,
  sessionCapabilities: {
    list: {},
    resume: {},
    close: {},
    delete: {},
    title: {},
    archive: {},
    additionalDirectories: {},
  },
  auth: { logout: {} },
}
const initialize = { capabilities: { litchExtensions: ['threadCapabilities', 'acpControls'] } }

test('agent 撤回征询时撤销卡片；未知对象决定绝不能被解释成允许', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    s.desktop.onRequest(() => undefined)
    const done = await turn(s, thread.id, text('ask-cancel'))
    assert.match(done.items.at(-1).text, /cancel/)
    assert.ok(
      s.desktop.notifications.some(
        (n) =>
          n.method === 'thread/status/changed' &&
          n.params.status.activeFlags?.includes('waitingOnUserInput'),
      ),
    )
    assert.ok(s.desktop.notifications.some((n) => n.method === 'serverRequest/resolved'))
    s.desktop.onRequest(() => ({ decision: { declineWithNote: { note: '拒绝' } } }))
    const denied = await turn(s, thread.id, text('run'))
    assert.equal(denied.status, 'interrupted')
    assert.equal(
      (await s.received()).some((m) => m.method === 'terminal/create'),
      false,
    )
  } finally {
    await dispose(s)
  }
})

test('always 的持久范围必须明确确认，不能把会话内同意直接扩大', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    s.desktop.onRequest((r) =>
      r.method === 'mcpServer/elicitation/request'
        ? { action: 'accept', content: { confirm: true }, _meta: null }
        : { decision: 'acceptForSession' },
    )
    await turn(s, thread.id, text('run'))
    assert.ok(s.desktop.requests.some((r) => r.params.message?.includes('可能超出当前会话')))
    assert.ok((await s.received()).some((m) => m.result?.outcome?.optionId === 'always'))
    s.desktop.onRequest((r) =>
      r.method === 'mcpServer/elicitation/request'
        ? { action: 'decline', content: null, _meta: null }
        : { decision: 'acceptForSession' },
    )
    const denied = await turn(s, thread.id, text('run'))
    assert.equal(denied.status, 'interrupted')
  } finally {
    await dispose(s)
  }
})

test('握手只认对象能力标记；agy 使用独立状态与官方参数', () => {
  for (const value of [true, false, 1, '', [], null, undefined])
    assert.equal(
      capabilitiesOf({ agentCapabilities: { sessionCapabilities: { close: value } } }).close,
      false,
    )
  const spec = agentSpec({
    CHA_ACP_AGENT: 'agy',
    CHA_ACP_HOME: '/tmp/acp-state',
    CHA_AGY_HOME: '/tmp/sdk-state',
  })
  assert.deepEqual(spec.args, ['acp'])
  assert.equal(spec.home, '/tmp/acp-state')
  assert.equal(spec.displayName, 'Antigravity')
})

test('生命周期按声明开放；关闭等待最后一个订阅；删除移除本地与远端记录', async () => {
  const s = await scene({ FAKE_ACP_CAPS: JSON.stringify(full) })
  try {
    await s.desktop.call('initialize', initialize)
    const { thread } = await s.desktop.call('thread/start', {
      cwd: s.cwd,
      litchAcp: { additionalDirectories: [s.root] },
    })
    await turn(s, thread.id, text('hello'))
    const other = client(s.server)
    await other.call('initialize', {})
    await other.call('thread/resume', { threadId: thread.id })
    await s.desktop.call('thread/unsubscribe', { threadId: thread.id })
    assert.equal(
      (await s.received()).some((m) => m.method === 'session/close'),
      false,
    )
    await other.call('thread/unsubscribe', { threadId: thread.id })
    assert.equal((await s.received()).filter((m) => m.method === 'session/close').length, 1)
    await turn(s, thread.id, text('hello'))
    assert.ok((await s.received()).some((m) => m.method === 'session/resume'))
    await s.desktop.call('thread/name/set', { threadId: thread.id, name: '自定标题' })
    await s.desktop.call('thread/archive', { threadId: thread.id })
    await s.desktop.call('thread/unarchive', { threadId: thread.id })
    for (const method of ['session/set_title', 'session/archive', 'session/unarchive'])
      assert.ok(
        (await s.received()).some((m) => m.method === method),
        method,
      )
    await s.desktop.call('thread/delete', { threadId: thread.id })
    await s.desktop.call('thread/delete', { threadId: thread.id })
    assert.equal(s.server.record(thread.id), null)
    assert.equal((await s.desktop.call('thread/list')).data.length, 0)
  } finally {
    await dispose(s)
  }
})

test('逐会话声明、模型、模式只给声明过的连接；模式按目录设置', async () => {
  const s = await scene()
  try {
    const plain = client(s.server)
    await plain.call('initialize', {})
    await s.desktop.call('initialize', initialize)
    const started = await s.desktop.call('thread/start', { cwd: s.cwd })
    const id = started.thread.id
    assert.equal(started.thread.litchCapabilities.models.length, 2)
    assert.equal(started.thread.litchCapabilities.planMode, true)
    const read = await plain.call('thread/read', { threadId: id })
    assert.equal(read.thread.litchCapabilities, undefined)
    await s.desktop.call('thread/settings/update', { threadId: id, permissions: 'acp:mode:plan' })
    assert.equal(s.server.live.get(id)?.projection.modes?.currentModeId, 'plan')
    await s.desktop.until('thread/settings/updated')
    assert.ok(
      s.desktop.notifications.some((n) => n.params.threadSettings?.thread.litchCapabilities),
    )
    assert.equal(
      plain.notifications.some(
        (n) =>
          n.params.thread?.litchCapabilities || n.params.threadSettings?.thread.litchCapabilities,
      ),
      false,
    )
    await assert.rejects(
      s.desktop.call('thread/settings/update', { threadId: id, permissions: 'acp:mode:unknown' }),
    )
  } finally {
    await dispose(s)
  }
})

test('表单征询保留类型；子代理审批由父订阅接收；未知会话取消', async () => {
  const s = await scene()
  try {
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    s.desktop.onRequest((r) =>
      r.method === 'mcpServer/elicitation/request'
        ? { action: 'accept', content: { count: 2, enabled: true }, _meta: null }
        : { decision: 'accept' },
    )
    const asked = await turn(s, thread.id, text('ask'))
    assert.match(asked.items.at(-1).text, /"count":2,"enabled":true/)
    await turn(s, thread.id, text('child'))
    assert.ok(s.desktop.requests.some((r) => r.params.threadId === `${thread.id}-child`))
    assert.equal(s.server.live.get(`${thread.id}-child`)?.projection.active, null)
    await assert.rejects(
      s.desktop.call('turn/start', { threadId: `${thread.id}-child`, input: text('禁止') }),
    )
    const before = s.desktop.requests.length
    const unknown = await turn(s, thread.id, text('unknown-permission'))
    assert.equal(s.desktop.requests.length, before)
    assert.equal(unknown.items.at(-1).text, 'cancelled')
    assert.deepEqual([...violations], [])
  } finally {
    await dispose(s)
  }
})

test('鉴权与通用配置显式调用、按声明限制；布尔配置保留原始类型', async () => {
  const s = await scene({ FAKE_ACP_CAPS: JSON.stringify(full) })
  try {
    await assert.rejects(s.desktop.call('litch/acp/auth/read'), /acpControls/)
    await s.desktop.call('initialize', initialize)
    const auth = await s.desktop.call('litch/acp/auth/read')
    assert.equal(auth.methods.length, 2)
    await assert.rejects(
      s.desktop.call('litch/acp/auth/authenticate', { methodId: 'terminal-login' }),
    )
    await assert.rejects(s.desktop.call('litch/acp/auth/authenticate', { methodId: 'unknown' }))
    await s.desktop.call('litch/acp/auth/authenticate', {
      methodId: 'agent-login',
      token: 'must-not-forward',
    })
    assert.deepEqual((await s.received()).find((m) => m.method === 'authenticate').params, {
      methodId: 'agent-login',
    })
    await s.desktop.call('litch/acp/auth/logout')
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    const config = await s.desktop.call('litch/acp/config/set', {
      threadId: thread.id,
      configId: 'enabled',
      value: true,
    })
    assert.equal(config.configOptions.find((o: any) => o.id === 'enabled').currentValue, true)
    await assert.rejects(
      s.desktop.call('litch/acp/config/set', {
        threadId: thread.id,
        configId: 'enabled',
        value: 'true',
      }),
    )
  } finally {
    await dispose(s)
  }
})

test('不声明生命周期与 MCP transport 时拒绝，资源只有声明 embeddedContext 才内嵌', async () => {
  const s = await scene({ FAKE_ACP_CAPS: '{}' })
  try {
    await s.desktop.call('initialize', initialize)
    for (const method of ['thread/delete', 'litch/acp/auth/logout'])
      await assert.rejects(s.desktop.call(method, { threadId: 'anything' }))
    await assert.rejects(
      s.desktop.call('thread/start', { cwd: s.cwd, litchAcp: { additionalDirectories: [s.root] } }),
    )
    await assert.rejects(
      s.desktop.call('thread/start', {
        cwd: s.cwd,
        litchAcp: { mcpServers: [{ name: 'x', type: 'http', url: 'https://example.com' }] },
      }),
    )
    const path = join(s.cwd, 'context.txt')
    await writeFile(path, '上下文')
    const input = [{ type: 'mention', path, name: 'context' }]
    assert.equal((await promptContent(input, capabilitiesOf({}))).blocks[0].type, 'resource_link')
    assert.equal(
      (
        await promptContent(
          input,
          capabilitiesOf({ agentCapabilities: { promptCapabilities: { embeddedContext: true } } }),
        )
      ).blocks[0].resource.text,
      '上下文',
    )
  } finally {
    await dispose(s)
  }
})

test('agy 登录状态来自只读验证；不创建会话或读令牌', async () => {
  const { FAKE_AGENT } = await import('./client.mjs')
  const s = await scene({
    CHA_ACP_AGENT: 'agy',
    CHA_AGY_CLI: process.execPath,
    CHA_AGY_ARGS: `"${FAKE_AGENT}"`,
    FAKE_ACP_CAPS: JSON.stringify(full),
    FAKE_ACP_AUTH_REQUIRED: '1',
  })
  try {
    await s.desktop.call('initialize', initialize)
    assert.equal((await s.desktop.call('litch/acp/auth/read')).status, 'signedOut')
    await s.desktop.call('litch/acp/auth/logout')
    const loggedOut = await s.desktop.call('litch/acp/auth/read')
    assert.equal(loggedOut.status, 'signedOut')
    assert.equal(loggedOut.instruction, 'agy acp --login')
    assert.equal(
      (await s.received()).some((m) => m.method === 'session/new'),
      false,
    )
  } finally {
    await dispose(s)
  }
})

test('agy 查询故障不得当作未登录；没有 list 的 agent 保持未知', async () => {
  const { FAKE_AGENT } = await import('./client.mjs')
  for (const listing of [true, false]) {
    const s = await scene({
      CHA_ACP_AGENT: 'agy',
      CHA_AGY_CLI: process.execPath,
      CHA_AGY_ARGS: `"${FAKE_AGENT}"`,
      FAKE_ACP_CAPS: JSON.stringify(listing ? full : {}),
      FAKE_ACP_LIST_ERROR: '1',
      FAKE_ACP_AUTH_ERROR: '1',
    })
    try {
      await s.desktop.call('initialize', initialize)
      if (listing) await assert.rejects(s.desktop.call('litch/acp/auth/read'), /connection failed/)
      else assert.equal((await s.desktop.call('litch/acp/auth/read')).status, 'unknown')
    } finally {
      await dispose(s)
    }
  }
})
