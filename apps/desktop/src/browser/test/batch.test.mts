import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientToolContext, ClientToolInvocation } from '../../client-tools/types.mjs'
import { runBrowserActions } from '../batch.mjs'

const invocation: ClientToolInvocation = {
  id: 'batch',
  callId: 'batch',
  threadId: 't',
  turnId: 'turn',
  namespace: 'litch_browser',
  tool: 'run_actions',
  arguments: {
    actions: [
      { tool: 'press', arguments: { tabId: 'page', key: 'Tab' } },
      { tool: 'press', arguments: { tabId: 'page', key: 'Enter' } },
    ],
  },
  device: { id: 'local', name: 'test', kind: 'local', target: null },
  harness: null,
  cwd: null,
}
const context: ClientToolContext = { signal: new AbortController().signal, ask: async () => 'once' }
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('批量总体60秒与最终观察10秒均停止等待；迟到结果不能触发后续步骤', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const seen: string[] = []
  const signals: AbortSignal[] = []
  const pending = runBrowserActions(
    invocation,
    context,
    async (call, ctx) => {
      seen.push(call.tool)
      signals.push(ctx.signal)
      return new Promise(() => {})
    },
    false,
  )
  await tick()
  t.mock.timers.tick(60_000)
  await tick()
  assert.deepEqual(seen, ['press', 'snapshot'])
  assert.equal(signals[0]?.aborted, true)
  t.mock.timers.tick(10_000)
  const result = await pending
  assert.equal(signals[1]?.aborted, true)
  assert.equal(result.success, false)
  assert.match(JSON.stringify(result), /timed out/)
  assert.equal(seen.filter((tool) => tool === 'press').length, 1)
})

test('批量每步重新传入信号与独立调用号，取消后不取快照', async () => {
  const cancel = new AbortController()
  const seen: string[] = []
  const result = await runBrowserActions(
    invocation,
    { ...context, signal: cancel.signal },
    async (call) => {
      seen.push(call.callId)
      cancel.abort()
      return { success: false, contentItems: [{ type: 'inputText', text: 'cancelled' }] }
    },
    false,
  )
  assert.equal(result.success, false)
  assert.equal(seen.length, 1)
  assert.notEqual(seen[0], invocation.callId)
})
