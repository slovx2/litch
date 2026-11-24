import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { TIMED_APPROVAL, TIMED_APPROVALS_EXTENSION } from '../../protocol/src/timed-approvals.mjs'
import { TimedApprovals, type TimedApprovalsClock } from '../src/timed-approvals.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig, settle, type TestClient } from './helpers.mjs'
import { text, until } from './tree-kit.mjs'

const HOUR = 3_600_000
const revoked = (value: unknown) => (value as { revoked: number }).revoked

/** 可以拨的假时钟：定时器到点由 advance 触发 */
function fakeClock(start = 1_000_000) {
  let now = start
  const timers = new Set<{ at: number; run: () => void }>()
  const clock: TimedApprovalsClock & { advance(ms: number): void } = {
    now: () => now,
    setTimeout(run, ms) {
      const timer = { at: now + ms, run }
      timers.add(timer)
      return timer
    },
    clearTimeout(handle) {
      timers.delete(handle as never)
    },
    advance(ms) {
      now += ms
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.delete(timer)
          timer.run()
        }
    },
  }
  return clock
}

test('授予后在到期前生效、到期后失效并通知；跨会话、跨类别不生效', () => {
  const db = new DatabaseSync(':memory:')
  const clock = fakeClock()
  const said: unknown[] = []
  const store = new TimedApprovals(db, (method, params) => said.push([method, params]), clock)
  const grant = store.grant('t1', 'command', 2)
  assert.equal(grant.expiresAt - grant.grantedAt, 2 * HOUR)
  assert.ok(store.active('t1', 'command'))
  assert.equal(store.active('t2', 'command'), null, '别的会话不生效')
  assert.equal(store.active('t1', 'fileChange'), null, '别的类别不生效')
  assert.deepEqual(store.answer('item/commandExecution/requestApproval', { threadId: 't1' }), {
    decision: 'accept',
  })
  assert.equal(store.answer('item/commandExecution/requestApproval', { threadId: 't2' }), null)
  assert.equal(store.answer('item/fileChange/requestApproval', { threadId: 't1' }), null)
  assert.equal(said.length, 1)
  clock.advance(2 * HOUR - 1)
  assert.ok(store.active('t1', 'command'), '到期前一毫秒仍生效')
  clock.advance(1)
  assert.equal(store.active('t1', 'command'), null, '到期后恢复询问')
  assert.equal(store.answer('item/commandExecution/requestApproval', { threadId: 't1' }), null)
  assert.deepEqual(said.at(-1), [TIMED_APPROVAL.changed, { grants: [] }], '到期时通知一次')
  assert.equal(db.prepare('SELECT count(*) AS n FROM timed_approval_grants').get()?.n, 0)
  store.close()
})

test('撤销立即生效；再授予按新时长重算；会话删除时一并删掉', () => {
  const db = new DatabaseSync(':memory:')
  const clock = fakeClock()
  const store = new TimedApprovals(db, () => {}, clock)
  const first = store.grant('t1', 'machine', 8)
  store.grant('t1', 'chrome', 8)
  assert.equal(revoked(store.call(TIMED_APPROVAL.revoke, { id: first.id })), 1)
  assert.equal(store.active('t1', 'machine'), null)
  assert.ok(store.active('t1', 'chrome'))
  store.grant('t1', 'chrome', 1)
  assert.equal(store.list().length, 1, '同一会话同一类只留一条')
  assert.equal(store.list()[0]?.expiresAt, clock.now() + HOUR)
  store.grant('t1', 'browser', 1)
  assert.equal(
    revoked(store.call(TIMED_APPROVAL.revoke, { threadId: 't1', category: 'browser' })),
    1,
  )
  store.threadDeleted('t1')
  assert.deepEqual(store.list(), [])
  store.close()
})

test('时长、类别、会话参数校验', () => {
  const store = new TimedApprovals(new DatabaseSync(':memory:'), () => {}, fakeClock())
  for (const hours of [0, 0.1, 169, Number.NaN, '4'])
    assert.throws(
      () => store.call(TIMED_APPROVAL.grant, { threadId: 't', category: 'command', hours }),
      /时长/,
    )
  assert.throws(
    () => store.call(TIMED_APPROVAL.grant, { threadId: 't', category: 'question', hours: 1 }),
    /类别/,
  )
  assert.throws(
    () => store.call(TIMED_APPROVAL.grant, { category: 'command', hours: 1 }),
    /threadId/,
  )
  assert.throws(() => store.call(TIMED_APPROVAL.revoke, {}), /id 或 threadId/)
  assert.ok(store.call(TIMED_APPROVAL.grant, { threadId: 't', category: 'chrome', hours: 0.25 }))
  assert.ok(store.call(TIMED_APPROVAL.grant, { threadId: 't', category: 'browser', hours: 168 }))
  store.close()
})

test('代答的形状：命令与改文件答 accept，没列 accept 的不代答；追加权限按请求的范围答这一回合', () => {
  const store = new TimedApprovals(new DatabaseSync(':memory:'), () => {}, fakeClock())
  for (const category of ['command', 'fileChange', 'permissions'] as const)
    store.grant('t', category, 1)
  assert.equal(
    store.answer('item/commandExecution/requestApproval', {
      threadId: 't',
      availableDecisions: ['decline', 'cancel'],
    }),
    null,
  )
  assert.deepEqual(
    store.answer('item/commandExecution/requestApproval', {
      threadId: 't',
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
    }),
    { decision: 'accept' },
  )
  assert.deepEqual(store.answer('item/fileChange/requestApproval', { threadId: 't' }), {
    decision: 'accept',
  })
  const permissions = { network: { enabled: true }, fileSystem: { write: ['/w'] } }
  assert.deepEqual(
    store.answer('item/permissions/requestApproval', { threadId: 't', permissions }),
    {
      permissions,
      scope: 'turn',
    },
  )
  // 提问不在限时授权里；没给 MCP 授权时征询照常问
  assert.equal(store.answer('item/tool/requestUserInput', { threadId: 't' }), null)
  assert.equal(store.answer('mcpServer/elicitation/request', mcpTool('t', 'docs')), null)
  store.close()
})

const mcpTool = (threadId: string, serverName: string, fields: Record<string, unknown> = {}) => ({
  threadId,
  turnId: 'turn',
  serverName,
  mode: 'form',
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' },
  message: '允许运行工具吗？',
  requestedSchema: { type: 'object', properties: {} },
  ...fields,
})

test('MCP：按会话加服务名授予；只代答审批性质的征询，答这一次允许、不记住', () => {
  const store = new TimedApprovals(new DatabaseSync(':memory:'), () => {}, fakeClock())
  const grant = store.grant('t', 'mcp', 1, 'docs')
  assert.equal(grant.scope, 'docs')
  const method = 'mcpServer/elicitation/request'
  const accepted = { action: 'accept', content: {}, _meta: null }
  assert.deepEqual(store.answer(method, mcpTool('t', 'docs')), accepted)
  assert.equal(store.answer(method, mcpTool('t', 'mail')), null, '别的 MCP 服务照常问')
  assert.equal(store.answer(method, mcpTool('u', 'docs')), null, '别的会话照常问')
  // 不带特权标记、也不要填栏目的普通征询只有允许、拒绝，同样代答
  assert.deepEqual(store.answer(method, mcpTool('t', 'docs', { _meta: null })), accepted)
  // 要填内容的表单、网页上办的事、别的特权征询都照旧每次问
  const asking = [
    mcpTool('t', 'docs', {
      _meta: null,
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
    }),
    mcpTool('t', 'docs', { mode: 'url', url: 'https://example.com', elicitationId: 'e' }),
    mcpTool('t', 'docs', { mode: 'openai/form' }),
    mcpTool('t', 'docs', { _meta: { codex_approval_kind: 'tool_suggestion' } }),
  ]
  for (const params of asking) assert.equal(store.answer(method, params), null)
  // 命令类授权不放行 MCP，MCP 授权也不放行命令
  assert.equal(store.answer('item/commandExecution/requestApproval', { threadId: 't' }), null)
  store.grant('t', 'command', 1)
  assert.equal(store.answer(method, mcpTool('t', 'mail')), null)
  // 同会话同服务再授予只留一条；按类别撤销撤掉全部服务
  store.grant('t', 'mcp', 2, 'docs')
  store.grant('t', 'mcp', 2, 'mail')
  assert.equal(store.list().filter((entry) => entry.category === 'mcp').length, 2)
  assert.equal(revoked(store.call(TIMED_APPROVAL.revoke, { threadId: 't', category: 'mcp' })), 2)
  assert.equal(store.answer(method, mcpTool('t', 'docs')), null)
  store.close()
})

test('MCP 授权的参数：必须给服务名，别的类别不许带范围', () => {
  const store = new TimedApprovals(new DatabaseSync(':memory:'), () => {}, fakeClock())
  const grant = (params: Record<string, unknown>) =>
    store.call(TIMED_APPROVAL.grant, { threadId: 't', hours: 1, ...params })
  for (const scope of [undefined, '', 3, 'x'.repeat(257)])
    assert.throws(() => grant({ category: 'mcp', scope }), /服务名/)
  assert.throws(() => grant({ category: 'command', scope: 'docs' }), /不分范围/)
  assert.equal((grant({ category: 'mcp', scope: 'docs' }) as { scope: string }).scope, 'docs')
  assert.equal((grant({ category: 'command' }) as { scope: string }).scope, '')
  store.close()
})

test('设备重启后授权仍在，按绝对到期时间算；重启期间到期的不再加载', () => {
  const path = `${process.env.TMPDIR ?? '/tmp'}/timed-approvals-${process.pid}-${Date.now()}.sqlite`
  const clock = fakeClock()
  let store = new TimedApprovals(new DatabaseSync(path), () => {}, clock)
  const long = store.grant('t1', 'machine', 4)
  store.grant('t1', 'command', 1)
  store.close()
  clock.advance(2 * HOUR)
  store = new TimedApprovals(new DatabaseSync(path), () => {}, clock)
  assert.deepEqual(store.list(), [long], '只剩未到期的那条，到期时间不变')
  assert.equal(store.active('t1', 'command'), null)
  store.close()
})

// ---------- 经聚合面 ----------

async function client(env: ReturnType<typeof rig>, extensions: string[]): Promise<TestClient> {
  const one = env.connect()
  await one.initialize(extensions)
  return one
}

const approvalAnswers = (engine: FakeEngine, id: string) =>
  [...engine.live].flatMap((connection) => connection.answers).filter((frame) => frame.id === id)

async function startThread(litch: TestClient): Promise<string> {
  const started = await litch.call('thread/start', { harness: 'pi', cwd: '/work/app' })
  const threadId = started.thread.id as string
  await litch.call('turn/start', { threadId, input: text('跑一下') })
  return threadId
}

test('经聚合面：授权内设备代答不转给客户端；别的会话照常询问；撤销后恢复询问', async () => {
  const pi = new FakeEngine('pi')
  const env = rig({ pi })
  try {
    const litch = await client(env, ['harness', TIMED_APPROVALS_EXTENSION])
    const other = await client(env, ['harness'])
    const info = await litch.call('runtime/info', {})
    assert.ok(info.device.extensions.includes(TIMED_APPROVALS_EXTENSION))
    const threadId = await startThread(litch)
    const second = await startThread(litch)
    // 没声明扩展的连接不能授予，也收不到名单变化
    assert.match(
      JSON.stringify(
        await other.fails(TIMED_APPROVAL.grant, { threadId, category: 'command', hours: 1 }),
      ),
      /extensionRequired/,
    )
    const grant = await litch.call(TIMED_APPROVAL.grant, {
      threadId,
      category: 'command',
      hours: 4,
    })
    await litch.waitFor((frame) => frame.method === TIMED_APPROVAL.changed)
    assert.equal(other.notifications.filter((f) => f.method === TIMED_APPROVAL.changed).length, 0)
    assert.deepEqual((await litch.call(TIMED_APPROVAL.list, {})).grants, [grant])

    const asked = litch.requests.length
    const id = pi.approval(threadId)
    await until(() => approvalAnswers(pi, id).length > 0, '设备代答')
    assert.deepEqual(approvalAnswers(pi, id)[0]?.result, { decision: 'accept' })
    await settle()
    assert.equal(litch.requests.length, asked, '授权内的审批不转给客户端')

    const elsewhere = pi.approval(second)
    await litch.waitFor((frame) => frame.id === elsewhere)
    assert.equal(approvalAnswers(pi, elsewhere).length, 0, '别的会话照常询问')

    await litch.call(TIMED_APPROVAL.revoke, { id: grant.id })
    const after = pi.approval(threadId)
    await litch.waitFor((frame) => frame.id === after)
    await settle()
    assert.equal(approvalAnswers(pi, after).length, 0, '撤销后恢复询问')
  } finally {
    await env.close()
  }
})

test('经聚合面：授予时同一会话里还在等的同类审批一并代答', async () => {
  const pi = new FakeEngine('pi')
  const env = rig({ pi })
  try {
    const litch = await client(env, ['harness', TIMED_APPROVALS_EXTENSION])
    const threadId = await startThread(litch)
    const waiting = pi.approval(threadId)
    await litch.waitFor((frame) => frame.id === waiting)
    await litch.call(TIMED_APPROVAL.grant, { threadId, category: 'command', hours: 1 })
    await until(() => approvalAnswers(pi, waiting).length > 0, '在等的一并代答')
    assert.deepEqual(approvalAnswers(pi, waiting)[0]?.result, { decision: 'accept' })
  } finally {
    await env.close()
  }
})

test('经聚合面：MCP 工具审批按服务名代答，授予时还在等的同服务征询一并代答', async () => {
  const pi = new FakeEngine('pi')
  const env = rig({ pi })
  try {
    const litch = await client(env, ['harness', TIMED_APPROVALS_EXTENSION])
    const threadId = await startThread(litch)
    const waiting = pi.elicitation(threadId)
    const otherServer = pi.elicitation(threadId, { serverName: 'mail' })
    const form = pi.elicitation(threadId, {
      _meta: null,
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
    })
    await litch.waitFor((frame) => frame.id === form)
    await litch.call(TIMED_APPROVAL.grant, { threadId, category: 'mcp', scope: 'docs', hours: 1 })
    await until(() => approvalAnswers(pi, waiting).length > 0, '在等的同服务征询一并代答')
    assert.deepEqual(approvalAnswers(pi, waiting)[0]?.result, {
      action: 'accept',
      content: {},
      _meta: null,
    })
    const asked = litch.requests.length
    const next = pi.elicitation(threadId)
    await until(() => approvalAnswers(pi, next).length > 0, '授权内的新征询直接代答')
    await settle()
    assert.equal(litch.requests.length, asked, '授权内的征询不转给客户端')
    assert.equal(approvalAnswers(pi, otherServer).length, 0, '别的 MCP 服务照常问')
    assert.equal(approvalAnswers(pi, form).length, 0, '要填内容的表单照常问')
  } finally {
    await env.close()
  }
})

test('经聚合面：设备重启后授权仍在并继续代答', async () => {
  const pi = new FakeEngine('pi')
  const first = rig({ pi })
  const { stateDir } = first
  let threadId: string
  try {
    const litch = await client(first, ['harness', TIMED_APPROVALS_EXTENSION])
    threadId = await startThread(litch)
    await litch.call(TIMED_APPROVAL.grant, { threadId, category: 'command', hours: 1 })
  } finally {
    await first.device.close()
  }
  // 引擎照常在跑，只有设备进程重启
  const again = pi
  const env = rig({ pi: again }, {}, { stateDir })
  try {
    const litch = await client(env, ['harness', TIMED_APPROVALS_EXTENSION])
    const { grants } = await litch.call(TIMED_APPROVAL.list, {})
    assert.equal(grants.length, 1)
    assert.equal(grants[0].threadId, threadId)
    await litch.call('thread/resume', { threadId })
    const id = again.approval(threadId)
    await until(() => approvalAnswers(again, id).length > 0, '重启后代答')
  } finally {
    await env.close()
  }
})
