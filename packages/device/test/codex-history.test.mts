import assert from 'node:assert/strict'
import test from 'node:test'
import { readCodexHistory } from '../src/codex-history.mjs'
import { UpstreamRpcError } from '../src/wire.mjs'
import { codexRig, sentTo } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import { RpcFailure } from './fake-upstream.mjs'

const pending = () =>
  new UpstreamRpcError({ code: -32601, message: 'list_turns is not supported yet' })
const rpcPending = () => new RpcFailure(-32601, 'list_turns is not supported yet')

test('原生历史：临时元数据缺失后返回原页，不改变排序、itemsView 或双向游标', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(['harness'])
    const threadId = (await client.call('thread/start', { harness: 'codex' })).thread.id
    const params = {
      threadId,
      cursor: 'native-opaque-cursor',
      limit: 3,
      sortDirection: 'asc',
      itemsView: 'full',
    }
    const page = {
      data: [{ id: 'turn', items: [{ type: 'agentMessage', text: '完整历史' }] }],
      nextCursor: 'native-next',
      backwardsCursor: 'native-backwards',
    }
    let calls = 0
    env.codex.handlers['thread/turns/list'] = () => {
      if (++calls < 3) throw rpcPending()
      return page
    }
    assert.deepEqual(await client.call('thread/turns/list', params), page)
    assert.equal(calls, 3)
    assert.deepEqual(sentTo(env.codex, 'thread/turns/list'), [params, params, params])
    assert.equal(client.raw.filter((raw) => raw.includes('list_turns is not supported')).length, 0)
  } finally {
    await env.close()
  }
})

test('原生历史：客户端 read/resume 与设备自有连接都恢复，成功后仍登记归属', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(['harness'])
    const threadId = codexThread(1, 400).id
    await client.call('thread/read', { threadId })
    for (const method of ['thread/read', 'thread/resume']) {
      const original = env.codex.handlers[method]
      assert.ok(original)
      let calls = 0
      env.codex.handlers[method] = (params, connection) => {
        if (++calls % 2 === 1) throw rpcPending()
        return original(params, connection)
      }
      const params = { threadId, ...(method === 'thread/read' ? { includeTurns: true } : {}) }
      assert.equal((await client.call(method, params)).thread.id, threadId)
      const engine = await env.device.openEngineLink('codex')
      try {
        assert.equal((await engine.request(method, params)).thread.id, threadId)
      } finally {
        engine.close()
      }
      assert.equal(calls, 4)
      env.codex.handlers[method] = original
    }
    // 成功的 resume 仍沿用 relay 的会话归属处理。
    assert.equal((await client.call('thread/read', { threadId })).thread.harness, 'codex')
  } finally {
    await env.close()
  }
})

test('原生历史：永久不支持有上限，最后的错误与 data 原样返回', async () => {
  const final = new UpstreamRpcError({
    code: -32601,
    message: 'list_turns is not supported yet',
    data: { reason: 'no-state-db' },
  })
  let calls = 0
  await assert.rejects(
    readCodexHistory('thread/turns/list', {}, 2_000, async () => {
      calls++
      throw final
    }),
    (error) => error === final,
  )
  assert.equal(calls, 4)
})

test('原生历史：请求期限不因重试延长', async () => {
  let calls = 0
  const error = pending()
  await assert.rejects(
    readCodexHistory('thread/turns/list', {}, 25, async (remaining) => {
      assert.ok(remaining <= 25)
      calls++
      throw error
    }),
    (actual) => actual === error,
  )
  assert.equal(calls, 1)
})

test('原生历史：客户端大会话读取不受设备探测时限限制', async () => {
  const env = codexRig({ device: { timing: { probeTimeoutMs: 50 } } })
  try {
    const client = env.connect()
    await client.initialize(['harness'])
    const threadId = (await client.call('thread/start', { harness: 'codex' })).thread.id
    const page = { data: [], nextCursor: null, backwardsCursor: null }
    env.codex.handlers['thread/turns/list'] = (_params, connection) => {
      const id = env.codex.seen.at(-1)?.id
      setTimeout(() => connection.send({ id, result: page }), 100)
      return undefined
    }
    assert.deepEqual(await client.call('thread/turns/list', { threadId }), page)
  } finally {
    await env.close()
  }
})

test('原生历史：不吞参数、权限、断线及其他不支持错误，也不重放写操作', async () => {
  for (const error of [
    new UpstreamRpcError({ code: -32602, message: 'invalid cursor' }),
    new UpstreamRpcError({ code: -32603, message: 'permission denied' }),
    new UpstreamRpcError({ code: -32601, message: 'method not found' }),
    new Error('连接断开了'),
  ]) {
    let calls = 0
    await assert.rejects(
      readCodexHistory('thread/turns/list', {}, 2_000, async () => {
        calls++
        throw error
      }),
      (actual) => actual === error,
    )
    assert.equal(calls, 1)
  }
  for (const method of [
    'thread/start',
    'thread/fork',
    'thread/revert',
    'turn/start',
    'thread/read',
  ]) {
    let calls = 0
    await assert.rejects(
      readCodexHistory(method, {}, 2_000, async () => {
        calls++
        throw pending()
      }),
    )
    assert.equal(calls, 1, method)
  }
})

test('原生历史：适配器引擎不重试；原生连接在退避中关闭后不重发', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(['harness'])
    env.pi.handlers['thread/turns/list'] = () => {
      throw rpcPending()
    }
    await assert.rejects(client.call('thread/turns/list', { threadId: 'p1' }))
    assert.equal(sentTo(env.pi, 'thread/turns/list').length, 1)

    const engine = await env.device.openEngineLink('codex')
    let calls = 0
    env.codex.handlers['thread/turns/list'] = () => {
      calls++
      setTimeout(() => engine.close(), 5)
      throw rpcPending()
    }
    await assert.rejects(engine.request('thread/turns/list', { threadId: 'anything' }))
    assert.equal(calls, 1)
  } finally {
    await env.close()
  }
})
