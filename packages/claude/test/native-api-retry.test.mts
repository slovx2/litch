import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apiRetryOf, retryTurnError } from '../src/api-retry.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 模型请求失败时用 CLI 自己的重试（apiRetry 扩展，api-retry.mts）：回合不失败，每条连接收到上游的 error
// （willRetry 为真），声明了的连接收到第几次、最多几次、原因，重试结束时收到空的；失败那次流出来的半截回答撤掉。
// 协议用例默认关着 CLI 的重试（protocol-client.mts），这里经 harness 环境打开，最多 2 次：也证实了用户设的值盖得住。

const RETRIES = { CLAUDE_CODE_MAX_RETRIES: '2' }

// 声明了 apiRetry 的连接多收的通知：校验上游结构时跳过
function standardView(method: string, _kind: string, payload: unknown): unknown {
  return method.startsWith('litch/') ? undefined : payload
}

const retryUpdates = (client: ProtocolClient): any[] =>
  client.trace
    .filter((message) => message.method === 'litch/turn/apiRetry/updated')
    .map((message) => message.params)

const retryErrors = (client: ProtocolClient): any[] =>
  client.trace
    .filter((message) => message.method === 'error' && message.params?.willRetry === true)
    .map((message) => message.params)

test('apiRetryOf：CLI 的 api_retry 读成第几次、最多几次和原因', () => {
  // 2.1.282 实测的连接中断：没有状态码，CLI 归成 unknown
  assert.deepEqual(
    apiRetryOf({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 608,
      error_status: null,
      error: 'unknown',
    }),
    { attempt: 1, maxRetries: 10, retryDelayMs: 608, httpStatus: null, reason: 'connection' },
  )
  const reason = (fields: Record<string, unknown>) =>
    apiRetryOf({ attempt: 2, max_retries: 10, retry_delay_ms: 1000, ...fields })?.reason
  assert.equal(reason({ error_status: 529, error: 'overloaded' }), 'overloaded')
  assert.equal(reason({ error_status: 429, error: 'rate_limit' }), 'rateLimit')
  assert.equal(reason({ error_status: 500, error: 'server_error' }), 'server')
  assert.equal(reason({ error_status: 408, error: 'server_error' }), 'server')
  assert.equal(reason({ error_status: 404, error: 'model_not_found' }), 'other')
  assert.equal(
    reason({
      error_status: null,
      error: 'unknown',
      no_response: { waited_ms: 1, retry_wait_ms: 2 },
    }),
    'noResponse',
  )
  // 不像样的不认
  assert.equal(apiRetryOf({ subtype: 'api_retry' }), null)
  assert.equal(apiRetryOf({ attempt: 1, max_retries: 0 })?.maxRetries, null)
})

test('retryTurnError：照上游 codex 重试时的写法', () => {
  assert.deepEqual(
    retryTurnError({
      attempt: 1,
      maxRetries: 10,
      retryDelayMs: 600,
      httpStatus: null,
      reason: 'connection',
    }),
    {
      message: 'Reconnecting... 1/10',
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } },
      additionalDetails: 'Connection error',
    },
  )
  assert.deepEqual(
    retryTurnError({
      attempt: 3,
      maxRetries: null,
      retryDelayMs: null,
      httpStatus: 529,
      reason: 'overloaded',
    }),
    {
      message: 'Reconnecting... 3',
      codexErrorInfo: 'serverOverloaded',
      additionalDetails: 'API overloaded (HTTP 529)',
    },
  )
  assert.equal(
    retryTurnError({
      attempt: 1,
      maxRetries: 2,
      retryDelayMs: 0,
      httpStatus: 500,
      reason: 'server',
    }).codexErrorInfo,
    'internalServerError',
  )
})

test('RETRY-001：529 之后 CLI 重试成功，回合完成；没声明的连接只看到上游的 error', {
  timeout: 100_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-api-retry-529-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', RETRIES)
  try {
    model.enqueue(() => ({ status: 529, message: 'Overloaded', errorType: 'overloaded_error' }))
    model.enqueue(() => [{ type: 'text', text: '重试之后的回答。' }])
    const { thread } = await client.request('thread/start', { cwd: home })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '你好' }],
    })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.equal(model.requests.length, 2, 'CLI 重发了一次')
    const [error] = retryErrors(client)
    assert.deepEqual(error, {
      threadId: thread.id,
      turnId: turn.id,
      willRetry: true,
      error: {
        message: 'Reconnecting... 1/2',
        codexErrorInfo: 'serverOverloaded',
        additionalDetails: 'API overloaded (HTTP 529)',
      },
    })
    assert.equal(retryErrors(client).length, 1)
    assert.deepEqual(retryUpdates(client), [], '没声明 apiRetry 的连接不发扩展通知')
    const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.deepEqual(
      read.thread.turns[0].items.map((item: any) => [item.type, item.text ?? null]),
      [
        ['userMessage', null],
        ['agentMessage', '重试之后的回答。'],
      ],
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('RETRY-002：流出半截正文后断开，CLI 重试；半截回答撤掉，声明了的连接收到重试的起止', {
  timeout: 100_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-api-retry-partial-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', RETRIES, {
    litchExtensions: ['apiRetry'],
  })
  client.standardView = standardView
  const partial = 'HALF_ANSWER_BEFORE_DROP'
  try {
    model.enqueue(() => ({
      disconnectAfterText: partial,
      afterDelta: async () => {
        await client.notification('item/agentMessage/delta', (params) =>
          params.delta.includes(partial),
        )
      },
    }))
    model.enqueue(() => [{ type: 'text', text: '完整的回答。' }])
    const { thread } = await client.request('thread/start', { cwd: home })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '说一段话' }],
    })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    assert.equal(model.requests.length, 2)
    // 半截回答那一条：先出字，重试时收到一次正文为空的完成，从回合里删掉
    const delta = client.trace.find(
      (message) =>
        message.method === 'item/agentMessage/delta' && message.params.delta.includes(partial),
    )
    const halfId = delta.params.itemId
    const halfDone = client.trace.filter(
      (message) => message.method === 'item/completed' && message.params.item.id === halfId,
    )
    assert.equal(halfDone.length, 1)
    assert.equal(halfDone[0].params.item.text, '')
    const updates = retryUpdates(client)
    assert.deepEqual(updates, [
      {
        threadId: thread.id,
        turnId: turn.id,
        retry: {
          attempt: 1,
          maxRetries: 2,
          retryDelayMs: updates[0]?.retry?.retryDelayMs,
          httpStatus: null,
          reason: 'connection',
        },
        discardedItemIds: [halfId],
      },
      { threadId: thread.id, turnId: turn.id, retry: null },
    ])
    assert.equal(typeof updates[0]?.retry?.retryDelayMs, 'number')
    assert.deepEqual(retryErrors(client)[0].error.codexErrorInfo, {
      httpConnectionFailed: { httpStatusCode: null },
    })
    // 重试结束的通知先于新一次的正文
    const resolvedAt = client.trace.findIndex(
      (message) =>
        message.method === 'litch/turn/apiRetry/updated' && message.params.retry === null,
    )
    const answerAt = client.trace.findIndex(
      (message) =>
        message.method === 'item/agentMessage/delta' && message.params.delta.includes('完整'),
    )
    assert.ok(resolvedAt >= 0 && resolvedAt < answerAt)
    const read = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const items = read.thread.turns[0].items
    assert.deepEqual(
      items.map((item: any) => [item.type, item.text ?? null]),
      [
        ['userMessage', null],
        ['agentMessage', '完整的回答。'],
      ],
    )
    assert.doesNotMatch(JSON.stringify(items), new RegExp(partial))
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
