import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ClientToolCallParams,
  ClientToolCallResponse,
} from '../../protocol/src/client-tools.mjs'
import { DeclaredClientTools } from '../../shared/src/client-tool-executor.mjs'
import { type ClientToolPeer, ClientToolRouter } from '../src/client-tools.mjs'
import { type ChromeController, RemoteChromeRouter } from '../src/remote-chrome-routing.mjs'
import type { DeviceChromeRuntime } from '../src/remote-chrome-runtime.mjs'
import type { Frame } from '../src/wire.mjs'

const ok = (body: unknown): ClientToolCallResponse => ({
  success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(body) }],
})
const body = (reply: ClientToolCallResponse) => {
  assert.equal(reply.success, true, JSON.stringify(reply))
  const first = reply.contentItems[0]
  assert.equal(first?.type, 'inputText')
  return JSON.parse(first.text.split('\n')[0] ?? '')
}

test('控制端重连后安全恢复原标签，后续调用使用新代次而非旧租约', async () => {
  let epoch = 'first'
  let reconnectDuringRecovery = false
  let sequence = 0
  const checked: string[] = []
  const controller: ChromeController = {
    id: 'desktop',
    hostLabel: 'desktop',
    ready: () => true,
    async call(params) {
      if (params.tool === 'targets')
        return ok({ targets: [{ targetId: 'chrome:instance', epoch, protocol: 1 }] })
      if (params.tool === 'ensure_claimed' && reconnectDuringRecovery) epoch = 'changed-again'
      for (const binding of params.litchChromeTargets ?? []) {
        if (!binding.recover && binding.epoch !== epoch)
          return { success: false, contentItems: [{ type: 'inputText', text: 'stale epoch' }] }
        checked.push(binding.epoch)
      }
      return ok({ tabId: 'chrome:original-tab' })
    },
  }
  const runtime = {
    status: { enabled: true, hostLabel: 'device', condition: 'waiting' },
    instances: [],
  } as unknown as DeviceChromeRuntime
  const router = new RemoteChromeRouter(runtime)
  const scope = { harness: 'codex', threadId: 'thread', turnId: 'turn' }
  const call = async (tool: string, args = {}) => {
    const params: ClientToolCallParams = {
      ...scope,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      callId: `call-${++sequence}`,
    }
    const result = router.route(scope, params, {
      negotiated: true,
      controller,
      signal: new AbortController().signal,
      ask: async () => 'once',
      fullAccess: async () => false,
    })
    assert.ok(result)
    return result
  }
  const targetId = body(await call('targets')).targets[0].targetId
  const tabId = body(await call('navigate', { targetId, url: 'https://fixture.invalid' })).tabId
  epoch = 'reconnected'
  const recovered = body(await call('ensure_claimed', { tabId })).tabId
  assert.equal((await call('snapshot', { tabId: recovered })).success, true)
  assert.equal(checked.at(-1), 'reconnected')
  assert.equal((await call('snapshot', { tabId })).success, false)
  reconnectDuringRecovery = true
  assert.equal((await call('ensure_claimed', { tabId: recovered })).success, false)
})

test('双端模式不截获无 Chrome 句柄的内置浏览器认领与释放', () => {
  const router = new RemoteChromeRouter({
    status: { enabled: true },
  } as unknown as DeviceChromeRuntime)
  const scope = { harness: 'codex', threadId: 'thread', turnId: 'turn' }
  for (const [tool, args] of [
    ['ensure_claimed', { url: 'https://fixture.invalid' }],
    ['ensure_claimed', { tabId: 'builtin-tab' }],
    ['release', { tabId: 'builtin-tab' }],
  ] as const) {
    assert.equal(
      router.route(
        scope,
        {
          ...scope,
          namespace: 'litch_browser',
          tool,
          arguments: args,
          callId: tool,
        },
        {
          negotiated: true,
          controller: null,
          signal: new AbortController().signal,
          ask: async () => 'once',
          fullAccess: async () => false,
        },
      ),
      null,
    )
  }
})

test('未协商双端能力的旧客户端继续使用控制端，不收到设备目标', () => {
  const router = new RemoteChromeRouter({ status: { enabled: true } } as DeviceChromeRuntime)
  const scope = { harness: 'codex', threadId: 'legacy', turnId: 'turn' }
  assert.equal(
    router.route(
      scope,
      {
        ...scope,
        namespace: 'litch_browser',
        tool: 'targets',
        arguments: {},
        callId: 'legacy-call',
      },
      {
        negotiated: false,
        controller: null,
        signal: new AbortController().signal,
        ask: async () => 'once',
        fullAccess: async () => false,
      },
    ),
    null,
  )
})

test('等待设备站点审批时关闭 harness 浏览器开关，迟到的批准不得继续执行', async () => {
  let enabled = true
  let executed = 0
  const runtime = {
    status: { enabled: true, hostLabel: 'device' },
    instances: [{ id: 'local', epoch: 'epoch', protocol: 1 }],
    async call(
      _scope: unknown,
      _params: unknown,
      _instances: unknown,
      signal: AbortSignal,
      ask: (prompt: unknown, signal: AbortSignal) => Promise<unknown>,
    ) {
      const decision = await ask({ kind: 'site', origin: 'https://fixture.invalid' }, signal)
      if (decision) executed++
      return { success: !!decision, contentItems: [] }
    },
  } as unknown as DeviceChromeRuntime
  const router = new ClientToolRouter({
    log() {},
    graceMs: 1,
    enabled: () => enabled,
    remoteChrome: new RemoteChromeRouter(runtime),
  })
  const scope = { harness: 'codex', threadId: 'thread', turnId: 'turn' }
  const peer: ClientToolPeer = {
    id: 'desktop',
    ready: true,
    remoteChrome: true,
    chromeTargetRouting: true,
    desktop: null,
    clientToolNamespaces: new DeclaredClientTools(['litch_browser']),
    upstream: () => null,
    withdrawClientTool() {},
    deliverClientTool(_harness, frame, answer) {
      if (frame.method === 'litch/remoteChrome/approval') {
        enabled = false
        const prompt = frame.params as { id: string; nonce: string }
        queueMicrotask(() => answer({ result: { ...prompt, decision: 'once' } }))
      } else queueMicrotask(() => answer({ result: ok({ targets: [] }) }))
      return frame.id as string
    },
  }
  router.join(peer)
  router.turnStarted(peer, scope.harness, scope.turnId)
  let next = 0
  const call = (tool: string, args = {}) =>
    new Promise<ClientToolCallResponse>((resolve) => {
      const id = ++next
      const frame: Frame = {
        id,
        method: 'item/tool/call',
        params: {
          ...scope,
          namespace: 'litch_browser',
          tool,
          arguments: args,
          callId: `call-${id}`,
        },
      }
      router.offer(
        peer,
        {
          harness: scope.harness,
          available: true,
          reply: (raw) => resolve(JSON.parse(raw).result),
        },
        frame,
        id,
      )
    })
  const targetId = body(await call('targets')).targets[0].targetId
  assert.equal(
    (await call('navigate', { targetId, url: 'https://fixture.invalid' })).success,
    false,
  )
  assert.equal(executed, 0)
})
