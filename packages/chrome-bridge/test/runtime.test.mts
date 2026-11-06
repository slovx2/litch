import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ApprovalRequest,
  InvocationContext,
  ToolInvocation,
} from '../../automation-contracts/src/runtime.mjs'
import type { ClientToolExecutor, ClientToolInvocation } from '../../browser/src/tool-port.mjs'
import type { ChromeBridge } from '../src/bridge.mjs'
import { createBrowserDispatcher } from '../src/dispatcher.mjs'
import { createChromeExecutor } from '../src/runtime.mjs'

const scope = {
  hostId: 'example',
  deviceId: 'device',
  sessionId: 'session',
  turnId: 'turn',
  callId: 'call',
}
const invocation: ToolInvocation = {
  scope,
  namespace: 'example_browser',
  tool: 'tabs',
  arguments: { action: 'list', targetId: 'chrome:instance' },
}
function fixture() {
  let calls = 0
  const bridge = {
    onEvent: () => () => {},
    instances: () => [
      { id: 'instance', epoch: 'epoch', name: 'Chrome', protocol: 1, incompatible: null },
    ],
    call: async () => {
      calls++
      return []
    },
  } as unknown as ChromeBridge
  const executor = createChromeExecutor({
    bridge,
    hostId: 'example',
    namespace: 'example_browser',
    productName: 'Example',
    allowed: () => true,
  })
  let held = 0,
    dismissed = 0
  const context: InvocationContext = {
    signal: new AbortController().signal,
    hold: () => {
      held++
      return () => {
        held--
      }
    },
    approvals: {
      request: async (request) => ({
        requestId: request.id,
        nonce: request.nonce,
        scope: request.scope,
        decision: 'once',
      }),
      dismiss: async () => {
        dismissed++
      },
    },
  }
  return { executor, context, calls: () => calls, held: () => held, dismissed: () => dismissed }
}

test('SDK 使用同源工具，拒绝伪造 host、未知工具与错绑定批准', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  assert.equal(f.executor.definitions[0]?.name, 'example_browser')
  assert.ok(!f.executor.definitions[0]?.tools.some((tool) => tool.name === 'upload'))
  assert.equal(
    (await f.executor.execute({ ...invocation, scope: { ...scope, hostId: 'another' } }, f.context))
      .success,
    false,
  )
  assert.equal(
    (await f.executor.execute({ ...invocation, tool: 'unknown' }, f.context)).success,
    false,
  )
  f.context.approvals.request = async (request) => ({
    requestId: request.id,
    nonce: 'wrong',
    scope,
    decision: 'once',
  })
  assert.equal((await f.executor.execute(invocation, f.context)).success, false)
  assert.equal(f.calls(), 0)
  assert.equal(f.held(), 0)
})

test('SDK 批准后执行，回合结束撤审批并禁止原回合重入', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  assert.equal((await f.executor.execute(invocation, f.context)).success, true)
  assert.equal(f.calls(), 1)
  await f.executor.endTurn(scope)
  assert.equal(f.dismissed(), 1)
  assert.equal((await f.executor.execute(invocation, f.context)).success, false)
  assert.equal(f.held(), 0)
})

test('审批不响应取消时，endTurn 仍立即结束调用与 hold', async (t) => {
  const f = fixture()
  t.after(() => f.executor.dispose())
  let asked!: (request: ApprovalRequest) => void
  const ready = new Promise<ApprovalRequest>((resolve) => {
    asked = resolve
  })
  f.context.approvals.request = (request) => {
    asked(request)
    return new Promise(() => {})
  }
  const result = f.executor.execute(invocation, f.context)
  await ready
  await f.executor.endTurn(scope)
  assert.equal((await result).success, false)
  assert.equal(f.calls(), 0)
  assert.equal(f.held(), 0)
  assert.equal(f.dismissed(), 1)
})

test('分流只按显式目标，内置浏览器拒绝后不自动改走 Chrome', async () => {
  let builtinCalls = 0,
    chromeCalls = 0
  const response = { success: false, contentItems: [] }
  const builtin: ClientToolExecutor = {
    namespace: 'browser',
    call: async () => {
      builtinCalls++
      return response
    },
  }
  const chrome: ClientToolExecutor = {
    namespace: 'browser',
    call: async () => {
      chromeCalls++
      return response
    },
  }
  const dispatcher = createBrowserDispatcher({ namespace: 'browser', builtin, chrome })
  const call = {
    tool: 'navigate',
    arguments: { url: 'https://example.test' },
  } as ClientToolInvocation
  const context = { signal: new AbortController().signal, ask: async () => null }
  await dispatcher.call(call, context)
  assert.equal(builtinCalls, 1)
  assert.equal(chromeCalls, 0)
  await dispatcher.call({ ...call, arguments: { targetId: 'chrome:instance' } }, context)
  assert.equal(chromeCalls, 1)
})
