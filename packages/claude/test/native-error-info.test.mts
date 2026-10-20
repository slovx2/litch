import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { codexErrorInfoFor } from '../src/codex-error-info.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 模型接口出错时，回合的 TurnError 带上和上游 codex 同名的 codexErrorInfo（codex-error-info.mts）。

test('codexErrorInfoFor：按状态码、CLI 归的类和错误文字归到 codex 的种类', () => {
  assert.equal(
    codexErrorInfoFor({ status: 529, text: 'API Error: 529 Overloaded' }),
    'serverOverloaded',
  )
  assert.equal(codexErrorInfoFor({ category: 'overloaded' }), 'serverOverloaded')
  assert.deepEqual(codexErrorInfoFor({ status: 429, category: 'rate_limit' }), {
    responseTooManyFailedAttempts: { httpStatusCode: 429 },
  })
  assert.equal(
    codexErrorInfoFor({
      status: 400,
      category: 'billing_error',
      text: 'credit balance is too low',
    }),
    'usageLimitExceeded',
  )
  assert.equal(
    codexErrorInfoFor({ status: 400, text: 'API Error: 400 prompt is too long: 250000 tokens' }),
    'contextWindowExceeded',
  )
  assert.equal(
    codexErrorInfoFor({ status: 401, category: 'authentication_failed' }),
    'unauthorized',
  )
  assert.equal(codexErrorInfoFor({ status: 500 }), 'internalServerError')
  assert.equal(codexErrorInfoFor({ status: 400, category: 'invalid_request' }), 'other')
  assert.deepEqual(codexErrorInfoFor({ status: 503 }), {
    httpConnectionFailed: { httpStatusCode: 503 },
  })
  assert.deepEqual(codexErrorInfoFor({ text: 'API Error: Connection error.' }), {
    httpConnectionFailed: { httpStatusCode: null },
  })
  // 不是模型接口的失败不给
  assert.equal(codexErrorInfoFor({ text: '工具执行失败' }), null)
})

for (const [label, reply, expected] of [
  [
    '529 过载',
    { status: 529, message: 'Overloaded', errorType: 'overloaded_error' },
    'serverOverloaded',
  ],
  [
    '429 限流',
    { status: 429, message: 'Rate limited', errorType: 'rate_limit_error' },
    { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
  ],
  [
    '400 上下文超长',
    {
      status: 400,
      message: 'prompt is too long: 250000 tokens > 200000 maximum',
      errorType: 'invalid_request_error',
    },
    'contextWindowExceeded',
  ],
  [
    '500',
    { status: 500, message: 'Internal error', errorType: 'api_error' },
    'internalServerError',
  ],
] as const)
  test(`ERROR-INFO-001：模型接口回 ${label} 时回合失败、TurnError 带 codexErrorInfo`, {
    timeout: 100_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-error-info-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    try {
      model.fallback = () => reply
      const { thread } = await client.request('thread/start', { cwd: home })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '你好' }],
      })
      const completed = await client.completed(turn.id)
      assert.equal(completed.status, 'failed', JSON.stringify(completed))
      assert.deepEqual(completed.error.codexErrorInfo, expected, JSON.stringify(completed.error))
      const notified = await client.notification('error', (params) => params.turnId === turn.id)
      assert.deepEqual(notified.error.codexErrorInfo, expected)
      const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
      assert.deepEqual(read.thread.turns.at(-1).error.codexErrorInfo, expected, '历史里也有')
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
