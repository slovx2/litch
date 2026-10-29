import assert from 'node:assert/strict'
import { until } from '../chrome-m0/cdp.mjs'

export async function remoteCheck({
  createCore,
  reduceSession,
  sshOpener,
  createClientToolHost,
  executor,
  origin,
}) {
  const alias = process.env.LITCH_CHROME_REMOTE_ALIAS
  if (!alias || !process.env.LITCH_SSH_CONFIG || !process.env.LITCH_REMOTE_ADAPTER)
    throw new Error(
      'Remote check requires an explicitly isolated SSH config, alias and adapter wrapper.',
    )
  const deviceId = 'chrome-remote-fixture'
  const target = { kind: 'alias', alias }
  let toCore
  const calls = []
  const execution = {
    namespace: 'litch_browser',
    async call(invocation, context) {
      calls.push({ tool: invocation.tool, device: invocation.device })
      assert.equal(invocation.device.id, deviceId)
      assert.equal(invocation.device.kind, 'ssh')
      return executor.call(invocation, context)
    },
    turnEnded: (turn) => executor.turnEnded(turn),
  }
  const tools = createClientToolHost([execution], (message) =>
    queueMicrotask(() => toCore?.(structuredClone(message))),
  )
  const clock = {
    now: () => Date.now(),
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    },
  }
  const core = createCore({
    clock,
    version: '0.25.0',
    log: (message) => {
      if (process.env.LITCH_CHECK_DEBUG) console.error(message)
    },
    clientTools: {
      namespaces: () => tools.namespaces(),
      post: (message) => queueMicrotask(() => tools.handle(structuredClone(message))),
      listen(handler) {
        toCore = handler
      },
    },
    devices: [
      {
        id: deviceId,
        name: alias,
        host: alias,
        kind: 'ssh',
        target,
        wire: 'orange',
        open: sshOpener(target),
      },
    ],
  })
  let device, view, sessionId
  const answered = new Set()
  const approvals = []
  const respond = () => {
    for (const request of view?.requests ?? []) {
      if (answered.has(request.id)) continue
      assert.equal(request.kind, 'clientAsk')
      assert.equal(request.device.kind, 'ssh')
      assert.ok(
        request.ask.kind === 'chromeInstance' ||
          (request.ask.kind === 'site' && request.ask.browser === 'chrome'),
      )
      const option = request.options.find((option) => option.role === 'accept')
      assert.ok(option)
      answered.add(request.id)
      if (request.ask.kind === 'site') approvals.push(request.ask.origin)
      void core.command(
        'session.respond',
        { deviceId, sessionId, requestId: request.id, optionId: option.id },
        new AbortController().signal,
      )
    }
  }
  try {
    core.subscribe(
      { kind: 'app' },
      {
        snapshot(data) {
          device = data.devices.find((one) => one.id === deviceId)
        },
        delta(ops) {
          for (const op of ops)
            if (op.op === 'device.upsert' && op.device.id === deviceId) device = op.device
        },
        error(error) {
          console.error('Remote app', error)
        },
      },
    )
    core.start()
    await until(() => device?.connection === 'online', 'Remote device online', 120000)
    assert.equal(device.mode, 'full')
    const steps = [
      { tool: 'targets' },
      { tool: 'navigate', args: { targetId: '$targetId', url: origin } },
      { tool: 'snapshot', args: { tabId: '$tabId' } },
    ]
    ;({ sessionId } = await core.command(
      'session.create',
      {
        deviceId,
        harness: 'pi',
        cwd: '/opt/litch-chrome/home',
        text: `LITCH_TOOL_PLAN ${JSON.stringify(steps)}`,
      },
      new AbortController().signal,
    ))
    core.subscribe(
      { kind: 'session', deviceId, sessionId },
      {
        snapshot(data) {
          view = structuredClone(data)
          respond()
        },
        delta(ops) {
          for (const op of ops) if (view) reduceSession(view, structuredClone(op))
          respond()
        },
        error(error) {
          console.error('Remote session', error)
        },
      },
    )
    const reply = await until(
      () => {
        if (!view?.turns.length || view.turns.some((turn) => turn.status === 'running'))
          return false
        return Object.values(view.items)
          .filter((item) => item.kind === 'agentMessage')
          .map((item) => item.text)
          .find((text) => text.includes('LITCH_REMOTE_DONE'))
      },
      'Remote tools complete',
      120000,
    )
    assert.match(reply, /Chrome acceptance/)
    assert.match(reply, /localhost are on the controller/)
    assert.deepEqual(
      calls.map((call) => call.tool),
      ['targets', 'navigate', 'snapshot'],
    )
    assert.deepEqual(approvals, [origin])
    return {
      alias,
      sessionId,
      remoteAdapter: '0.25.0 release',
      harness: 'isolated Pi 0.99.1',
      calls,
      approvals,
      reply,
    }
  } finally {
    core.stop()
    tools.reset()
  }
}
