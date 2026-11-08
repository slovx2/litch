import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeExecutor, fakeBrowserDriver } from '../examples/fake-host.mjs'
import {
  type ApprovalAnswer,
  type ApprovalRequest,
  approvalDecision,
  type InvocationContext,
  type InvocationScope,
  type RegistrationPolicy,
  type ToolInvocation,
  validateChromeIdentity,
} from '../src/index.mjs'

const scope: InvocationScope = {
  hostId: 'example',
  deviceId: 'local',
  sessionId: 's',
  turnId: 't',
  callId: 'c',
}
const call: ToolInvocation = {
  scope,
  namespace: 'example_browser',
  tool: 'navigate',
  arguments: { url: 'https://example.test' },
}
const request: ApprovalRequest = {
  id: 'a',
  nonce: 'n',
  scope,
  subject: {
    kind: 'site',
    origin: 'https://example.test',
    url: 'https://example.test',
    browser: 'example',
  },
  choices: ['once', 'decline'],
  expiresAt: 100,
}
const answer: ApprovalAnswer = { requestId: 'a', nonce: 'n', scope, decision: 'once' }

test('批准绑定完整调用来源，过期、未知选项和取消都拒绝', () => {
  const abort = new AbortController()
  assert.equal(approvalDecision(request, answer, 99, abort.signal), 'once')
  for (const key of Object.keys(scope) as (keyof InvocationScope)[]) {
    assert.equal(
      approvalDecision(
        request,
        { ...answer, scope: { ...scope, [key]: 'other' } },
        99,
        abort.signal,
      ),
      'decline',
    )
  }
  for (const changed of [
    { nonce: 'wrong' },
    { requestId: 'wrong' },
    { decision: 'always' as const },
  ]) {
    assert.equal(approvalDecision(request, { ...answer, ...changed }, 99, abort.signal), 'decline')
  }
  assert.equal(approvalDecision(request, answer, 100, abort.signal), 'decline')
  assert.equal(approvalDecision(request, null, 99, abort.signal), 'decline')
  abort.abort()
  assert.equal(approvalDecision(request, answer, 99, abort.signal), 'decline')
})

test('Node fake host 的批准/拒绝/取消与停表配对，不读取任何宿主产品状态', async () => {
  for (const outcome of ['approve', 'decline', 'cancel', 'error'] as const) {
    const abort = new AbortController(),
      driver = fakeBrowserDriver()
    const executor = createFakeExecutor(driver, () => 1)
    let held = 0,
      resumed = 0,
      navigated = 0
    const navigate = driver.navigate
    driver.navigate = async (...args) => {
      navigated++
      return navigate(...args)
    }
    const context: InvocationContext = {
      signal: abort.signal,
      hold: () => {
        held++
        return () => {
          resumed++
        }
      },
      approvals: {
        dismiss: async () => {},
        request: async (r) => {
          if (outcome === 'error') throw new Error('可信 UI 已断开')
          if (outcome === 'cancel') abort.abort()
          return {
            requestId: r.id,
            nonce: r.nonce,
            scope: r.scope,
            decision: outcome === 'decline' ? 'decline' : 'once',
          }
        },
      },
    }
    const result = await executor.execute(call, context)
    assert.equal(result.success, outcome === 'approve')
    assert.equal(navigated, outcome === 'approve' ? 1 : 0)
    assert.equal(held, 1)
    assert.equal(resumed, 1)
    await executor.endTurn(scope)
    await executor.endSession(scope)
    await executor.dispose()
  }
})

test('语义驱动示例拒绝冻结观察和导航后过期引用', async () => {
  const driver = fakeBrowserDriver(),
    op = { scope, signal: new AbortController().signal }
  const snapshot = await driver.snapshot('page', false, op)
  await driver.navigate('page', 'https://example.test', 1000, op)
  await assert.rejects(
    driver.act(snapshot.observation, { kind: 'press', key: 'Enter' }, op),
    /过期/,
  )
  const token = await driver.freeze('page', op)
  await assert.rejects(driver.snapshot('page', false, op), /不可观察/)
  await driver.unfreeze('page', token, op)
  await driver.snapshot('page', false, op)
  await driver.dispose()
})

test('扩展身份与登记策略由宿主提供，不默认注册 Litch 名称', async () => {
  for (const hostName of ['ai.example.first', 'org.example.second']) {
    assert.doesNotThrow(() =>
      validateChromeIdentity({ hostName, extensionIds: ['a'.repeat(32)], productName: 'Example' }),
    )
  }
  assert.throws(() =>
    validateChromeIdentity({ hostName: 'bad..host', extensionIds: [], productName: '' }),
  )
  const policies: RegistrationPolicy[] = [
    { decide: async () => ({ decision: 'deny', reason: '由宿主交接' }) },
    {
      decide: async (current, desired) => ({
        decision: 'apply',
        plan: { desired, expectedRevision: current.revision },
      }),
    },
  ]
  const desired = {
    hostName: 'ai.example.first',
    ownerId: 'first',
    executable: '/fixture/host',
    extensionIds: ['a'.repeat(32)],
  }
  for (const policy of policies) {
    const result = await policy.decide(
      { registration: null, revision: '1' },
      desired,
      new AbortController().signal,
    )
    if (result.decision === 'apply') assert.equal(result.plan.expectedRevision, '1')
  }
})
