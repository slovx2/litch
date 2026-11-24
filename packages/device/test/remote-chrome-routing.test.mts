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
import { unattendedNotice } from '../src/unattended.mjs'
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

test('中断前 targets 的迟到结果仍属旧回合；下一回合重新列举恢复', async () => {
  let release: (reply: ClientToolCallResponse) => void = () => {}
  let calls = 0
  const pending = new Promise<ClientToolCallResponse>((resolve) => {
    release = resolve
  })
  const target = ok({
    targets: [{ targetId: 'chrome:instance', epoch: 'same-epoch', protocol: 1 }],
  })
  const controller: ChromeController = {
    id: 'controller',
    hostLabel: 'fixture',
    ready: () => true,
    async call(params) {
      calls++
      if (params.tool === 'targets') return calls === 1 ? pending : target
      return ok({ tabs: [] })
    },
  }
  const runtime = {
    status: { enabled: true, hostLabel: 'device', condition: 'waiting' },
    instances: [],
    endTurn() {},
  } as unknown as DeviceChromeRuntime
  const router = new RemoteChromeRouter(runtime)
  const context = {
    negotiated: true,
    controller,
    signal: new AbortController().signal,
    ask: async () => 'once' as const,
    fullAccess: async () => false,
  }
  const invoke = async (turnId: string, tool: string, args = {}) => {
    const scope = { harness: 'claude-code', threadId: 'thread', turnId }
    const result = router.route(
      scope,
      {
        ...scope,
        namespace: 'litch_browser',
        tool,
        arguments: args,
        callId: `${turnId}-${tool}`,
      },
      context,
    )
    assert.ok(result)
    return result
  }
  const late = invoke('interrupted', 'targets')
  router.endTurn('claude-code', 'interrupted')
  release(target)
  const old = body(await late).targets[0].targetId
  const failed = await invoke('next', 'tabs', { action: 'list', targetId: old })
  assert.equal(failed.success, false)
  assert.match(JSON.stringify(failed), /invalid or expired/)
  assert.equal(calls, 1, '旧句柄在路由本地拒绝，不触及 Chrome')
  const fresh = body(await invoke('next', 'targets')).targets[0].targetId
  assert.notEqual(fresh, old)
  assert.equal((await invoke('next', 'tabs', { action: 'list', targetId: fresh })).success, true)
})

test('双端模式的快照标题只显示可再次调用的设备句柄，保留网页正文', async () => {
  const raw = 'chrome:physical-tab'
  const wait = `Found.\nTab ${raw}: "Fixture" https://fixture.invalid`
  const observation = `Tab ${raw}: "Fixture" https://fixture.invalid\n{"observation":{"generation":1}}\nTab ${raw}: 网页正文`
  const scope = { harness: 'codex', threadId: 'thread', turnId: 'turn' }
  const runtime = {
    status: { enabled: true, hostLabel: 'device', condition: 'connected' },
    instances: [{ id: 'device', epoch: 'epoch', protocol: 1 }],
    async call(_scope: unknown, params: ClientToolCallParams) {
      if (params.tool === 'run_actions') {
        assert.deepEqual(params.arguments, {
          actions: [
            { tool: 'wait', arguments: { tabId: raw, for: 'text', text: 'Fixture' } },
            { tool: 'wait', arguments: { tabId: raw, for: 'text', text: 'Missing' } },
          ],
        })
        return {
          success: false,
          contentItems: [
            {
              type: 'inputText',
              text: JSON.stringify({
                steps: [
                  { tool: 'wait', success: true, text: wait },
                  { tool: 'wait', success: false, text: 'Timed out' },
                ],
                observationStatus: 'completed',
              }),
            },
            { type: 'inputText', text: 'Final snapshot:' },
            { type: 'inputText', text: observation },
          ],
        }
      }
      if (params.tool === 'snapshot') {
        assert.deepEqual(params.arguments, { tabId: raw })
        return { success: true, contentItems: [{ type: 'inputText', text: observation }] }
      }
      return {
        success: true,
        contentItems: [
          { type: 'inputText', text: JSON.stringify({ tabId: raw, status: 'ready' }) },
          { type: 'inputText', text: observation },
        ],
      }
    },
  } as unknown as DeviceChromeRuntime
  const router = new RemoteChromeRouter(runtime)
  const call = (tool: string, args = {}) => {
    const reply = router.route(
      scope,
      { ...scope, namespace: 'litch_browser', tool, arguments: args, callId: tool },
      {
        negotiated: true,
        controller: null,
        signal: new AbortController().signal,
        ask: async () => 'once',
        fullAccess: async () => false,
      },
    )
    assert.ok(reply)
    return reply
  }
  const targetId = body(await call('targets')).targets[0].targetId
  const claimed = await call('ensure_claimed', { targetId })
  const tabId = body(claimed).tabId
  const expected = observation.replace(`Tab ${raw}:`, `Tab ${tabId}:`)
  assert.deepEqual(claimed.contentItems[1], { type: 'inputText', text: expected })
  const snapshot = await call('snapshot', { tabId })
  assert.deepEqual(snapshot.contentItems[0], { type: 'inputText', text: expected })
  const batch = await call('run_actions', {
    actions: [
      { tool: 'wait', arguments: { tabId, for: 'text', text: 'Fixture' } },
      { tool: 'wait', arguments: { tabId, for: 'text', text: 'Missing' } },
    ],
  })
  assert.equal(batch.success, false)
  const summary = batch.contentItems[0]
  assert.equal(summary?.type, 'inputText')
  assert.equal(JSON.parse(summary.text).steps[0].text, wait.replace(raw, tabId))
  assert.deepEqual(batch.contentItems[2], { type: 'inputText', text: expected })
})

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
    ['claim', { claimToken: 'builtin:fixture-user-tab' }],
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

test('设备站点审批：这个会话的 Chrome 在限时授权内时不发审批卡直接放行，别的会话照常发卡', async () => {
  const asked: string[] = []
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
      return { success: decision === 'once', contentItems: [] }
    },
  } as unknown as DeviceChromeRuntime
  const router = new ClientToolRouter({
    log() {},
    graceMs: 1,
    remoteChrome: new RemoteChromeRouter(runtime),
    timedApproval: (threadId, category) => threadId === 'granted' && category === 'chrome',
  })
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
        const prompt = frame.params as { id: string; nonce: string; threadId: string }
        asked.push(prompt.threadId)
        queueMicrotask(() => answer({ result: { ...prompt, decision: 'decline' } }))
      } else queueMicrotask(() => answer({ result: ok({ targets: [] }) }))
      return frame.id as string
    },
  }
  router.join(peer)
  let next = 0
  const call = (threadId: string, tool: string, args = {}) =>
    new Promise<ClientToolCallResponse>((resolve) => {
      const id = ++next
      const scope = { harness: 'codex', threadId, turnId: `turn-${threadId}` }
      router.turnStarted(peer, scope.harness, scope.turnId)
      router.offer(
        peer,
        {
          harness: scope.harness,
          available: true,
          reply: (raw) => resolve(JSON.parse(raw).result),
        },
        {
          id,
          method: 'item/tool/call',
          params: { ...scope, namespace: 'litch_browser', tool, arguments: args, callId: `c${id}` },
        },
        id,
      )
    })
  for (const threadId of ['granted', 'other']) {
    const targetId = body(await call(threadId, 'targets')).targets[0].targetId
    const reply = await call(threadId, 'navigate', { targetId, url: 'https://fixture.invalid' })
    assert.equal(reply.success, threadId === 'granted')
  }
  assert.deepEqual(asked, ['other'], '只有授权外的会话发了审批卡')
})

test('UNATTENDED-CHROME-001：无人值守的会话要设备站点审批时不送审批卡，ask 当场以无人值守的说明失败', async () => {
  let asked: unknown = null
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
      try {
        await ask({ kind: 'site', origin: 'https://fixture.invalid' }, signal)
        return { success: true, contentItems: [] }
      } catch (error) {
        asked = error instanceof Error ? error.message : String(error)
        return { success: false, contentItems: [{ type: 'inputText', text: String(asked) }] }
      }
    },
  } as unknown as DeviceChromeRuntime
  const router = new ClientToolRouter({
    log() {},
    graceMs: 1,
    remoteChrome: new RemoteChromeRouter(runtime),
    unattended: () => 'line',
  })
  const scope = { harness: 'codex', threadId: 'thread', turnId: 'turn' }
  const delivered: string[] = []
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
      delivered.push(String(frame.method))
      if ((frame.params as { tool?: string }).tool === 'targets')
        assert.deepEqual((frame.params as { litchUnattended?: unknown }).litchUnattended, {
          notice: unattendedNotice('line'),
        })
      queueMicrotask(() => answer({ result: ok({ targets: [] }) }))
      return frame.id as string
    },
  }
  router.join(peer)
  router.turnStarted(peer, scope.harness, scope.turnId)
  let next = 0
  const call = (tool: string, args = {}) =>
    new Promise<ClientToolCallResponse>((resolve) => {
      const id = ++next
      router.offer(
        peer,
        {
          harness: scope.harness,
          available: true,
          reply: (raw) => resolve(JSON.parse(raw).result),
        },
        {
          id,
          method: 'item/tool/call',
          params: {
            ...scope,
            namespace: 'litch_browser',
            tool,
            arguments: args,
            callId: `c-${id}`,
          },
        },
        id,
      )
    })
  const targetId = body(await call('targets')).targets[0].targetId
  const result = await call('navigate', { targetId, url: 'https://fixture.invalid' })
  assert.equal(result.success, false)
  assert.equal(asked, unattendedNotice('line'))
  assert.equal(delivered.includes('litch/remoteChrome/approval'), false)
})

test('UNATTENDED-CHROME-002：无人值守时 Chrome 限时授权内的站点照常放行，不送审批卡', async () => {
  let asked: unknown = null
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
      try {
        await ask({ kind: 'site', origin: 'https://fixture.invalid' }, signal)
        return { success: true, contentItems: [] }
      } catch (error) {
        asked = error instanceof Error ? error.message : String(error)
        return { success: false, contentItems: [{ type: 'inputText', text: String(asked) }] }
      }
    },
  } as unknown as DeviceChromeRuntime
  const router = new ClientToolRouter({
    log() {},
    graceMs: 1,
    remoteChrome: new RemoteChromeRouter(runtime),
    unattended: () => 'line',
    timedApproval: (threadId, category) => threadId === 'thread' && category === 'chrome',
  })
  const scope = { harness: 'codex', threadId: 'thread', turnId: 'turn' }
  const delivered: string[] = []
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
      delivered.push(String(frame.method))
      if ((frame.params as { tool?: string }).tool === 'targets')
        assert.deepEqual((frame.params as { litchUnattended?: unknown }).litchUnattended, {
          notice: unattendedNotice('line'),
        })
      queueMicrotask(() => answer({ result: ok({ targets: [] }) }))
      return frame.id as string
    },
  }
  router.join(peer)
  router.turnStarted(peer, scope.harness, scope.turnId)
  let next = 0
  const call = (tool: string, args = {}) =>
    new Promise<ClientToolCallResponse>((resolve) => {
      const id = ++next
      router.offer(
        peer,
        {
          harness: scope.harness,
          available: true,
          reply: (raw) => resolve(JSON.parse(raw).result),
        },
        {
          id,
          method: 'item/tool/call',
          params: {
            ...scope,
            namespace: 'litch_browser',
            tool,
            arguments: args,
            callId: `c-${id}`,
          },
        },
        id,
      )
    })
  const targetId = body(await call('targets')).targets[0].targetId
  const result = await call('navigate', { targetId, url: 'https://fixture.invalid' })
  assert.equal(result.success, true)
  assert.equal(asked, null)
  assert.equal(delivered.includes('litch/remoteChrome/approval'), false)
})
