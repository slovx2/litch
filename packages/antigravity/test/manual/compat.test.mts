import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inspect } from '../../../shared/test/strict-wire.mjs'
import { LocalHarness } from '../../src/runtime.mjs'
import { fixture } from './fixture.mjs'

test('新引擎的无扩展流式会话严格符合上游 schema，不扩大基线', async () => {
  const f = await fixture({
    executable: async () => process.execPath,
    runtime(options) {
      return new LocalHarness({
        ...options,
        args: [fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url))],
      })
    },
  })
  try {
    await f.call('model/list')
    await f.call('config/read')
    const { thread } = await f.call('thread/start', { cwd: f.home })
    await f.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hello' }] })
    await f.wait('turn/completed')
    await f.call('thread/list')
    await f.call('thread/read', { threadId: thread.id, includeTurns: true })
    await f.call('thread/resume', { threadId: thread.id })
    await f.call('thread/turns/list', { threadId: thread.id })
    // 所有现有入口共用 JSON-RPC 2.0 外壳；本用例严格检查 payload，不为新引擎扩大旧外壳基线。
    const findings = f.messages.flatMap(({ jsonrpc: _jsonrpc, ...message }) =>
      inspect(message, (id) => f.methods.get(id as number)),
    )
    assert.deepEqual(findings, [])
  } finally {
    await f.close()
  }
})
