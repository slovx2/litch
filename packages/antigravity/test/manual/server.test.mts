import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspect } from '../../../shared/test/strict-wire.mjs'
import { modelEndpoint } from '../../src/config.mjs'
import { LocalHarness, type RuntimeOptions, type WireEvent } from '../../src/runtime.mjs'
import { fixture } from './fixture.mjs'

class Fake extends LocalHarness {
  readonly sent: WireEvent[] = []
  readonly optionsForTest: RuntimeOptions
  constructor(options: RuntimeOptions) {
    super(options)
    this.optionsForTest = options
  }
  override async start(): Promise<WireEvent> {
    return { cascadeId: this.optionsForTest.config.cascadeId }
  }
  override send(event: WireEvent): void {
    this.sent.push(event)
    if (event.haltRequest)
      setImmediate(() => this.event({ trajectoryStateUpdate: { state: 'STATE_FULLY_IDLE' } }))
  }
  event(event: WireEvent): void {
    this.optionsForTest.event(event)
  }
  override async close(): Promise<void> {}
}
async function setup() {
  let runtime: Fake | undefined
  const f = await fixture({
    executable: async () => 'fake',
    runtime(options) {
      runtime = new Fake(options)
      return runtime
    },
  })
  const created = await f.call('thread/start', { cwd: f.home })
  const id = created.thread.id
  await f.call('turn/start', { threadId: id, input: [{ type: 'text', text: 'test' }] })
  await f.wait('turn/started')
  assert.ok(runtime)
  return { ...f, id, runtime }
}
for (const decision of ['accept', 'decline', 'cancel'])
  test(`工具审批 ${decision}，取消不误报 completed`, async () => {
    const f = await setup()
    try {
      f.runtime.event({
        policyDecisionRequest: {
          requestId: '1',
          toolArgs: {
            callId: 'call',
            toolName: 'run_command',
            argumentsJson: JSON.stringify({ CommandLine: 'printf mock', Cwd: f.home }),
          },
        },
      })
      const request = await f.wait('item/commandExecution/requestApproval')
      await f.server.handle(f.peer, { jsonrpc: '2.0', id: request.id, result: { decision } })
      await new Promise((resolve) => setImmediate(resolve))
      if (decision === 'cancel') {
        assert.ok(f.runtime.sent.some((event) => event.haltRequest))
        assert.equal((await f.wait('turn/completed')).params.turn.status, 'interrupted')
        assert.equal((await f.wait('turn/completed')).params.turn.error, null)
      } else {
        const response = f.runtime.sent.find(
          (event) => event.policyDecisionResponse,
        )?.policyDecisionResponse
        assert.equal(
          response.outcome,
          `POLICY_EVALUATION_OUTCOME_${decision === 'accept' ? 'ALLOW' : 'DENY'}`,
        )
        f.runtime.event({ trajectoryStateUpdate: { state: 'STATE_FULLY_IDLE' } })
        assert.equal((await f.wait('turn/completed')).params.turn.status, 'completed')
      }
      assert.equal(
        f.messages.filter((message) => message.method === 'serverRequest/resolved').length,
        1,
      )
      assert.deepEqual(
        f.messages.flatMap(({ jsonrpc: _jsonrpc, ...message }) =>
          inspect(message, (id) => f.methods.get(id as number)),
        ),
        [],
      )
    } finally {
      await f.close()
    }
  })
test('断连拒绝审批，其他连接不能代答', async () => {
  const f = await setup()
  try {
    f.runtime.event({
      policyDecisionRequest: {
        requestId: '1',
        toolArgs: { callId: 'call', toolName: 'view_file', argumentsJson: '{}' },
      },
    })
    const request = await f.wait('item/commandExecution/requestApproval')
    await f.server.handle(
      { ...f.peer, id: 'stranger' },
      { jsonrpc: '2.0', id: request.id, result: { decision: 'accept' } },
    )
    assert.equal(f.runtime.sent.filter((event) => event.policyDecisionResponse).length, 0)
    f.server.closePeer(f.peer)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      f.runtime.sent.at(-1)?.policyDecisionResponse.outcome,
      'POLICY_EVALUATION_OUTCOME_DENY',
    )
  } finally {
    await f.close()
  }
})
test('缺少 key、未开放订阅及过期鉴权给出可操作错误且不回显凭据', async () => {
  assert.throws(() => modelEndpoint({ kind: 'subscription' }, 'https://example.test'), /订阅/)
  const missing = await fixture({
    env: {},
    executable: async () => {
      throw new Error('不应下载安装')
    },
  })
  try {
    await assert.rejects(missing.call('thread/start', { cwd: missing.home }), /缺少 Gemini API key/)
  } finally {
    await missing.close()
  }
  const f = await setup()
  try {
    f.runtime.event({
      stepUpdate: { error: { httpCode: 401, errorMessage: 'fake-key secret raw response' } },
    })
    f.runtime.event({ trajectoryStateUpdate: { state: 'STATE_FULLY_IDLE' } })
    const done = (await f.wait('turn/completed')).params.turn
    assert.equal(done.status, 'failed')
    assert.match(done.error.message, /无效、已过期/)
    assert.ok(!JSON.stringify(f.messages).includes('fake-key'))
  } finally {
    await f.close()
  }
})
test('逐连接扩展与通知退订，拒绝未实现的权限和输入', async () => {
  const f = await setup()
  try {
    await assert.rejects(
      f.call('thread/start', { cwd: f.home, permissions: ':read-only' }),
      /仅支持/,
    )
    await assert.rejects(f.call('thread/fork', { threadId: f.id }), /尚不支持/)
    assert.equal((await f.call('runtime/info')).features.fork, false)
    const config = await f.call('litch/harness/config/read')
    await f.call('litch/harness/config/write', {
      expectedVersion: config.version,
      edits: [{ key: 'model', value: 'gemini-test' }],
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(!f.messages.some((message) => message.method === 'litch/harness/config/changed'))
    assert.equal(
      (await f.call('litch/harness/providers/read')).providers[0].methods[0].envName,
      'GEMINI_API_KEY',
    )
  } finally {
    await f.close()
  }
})
