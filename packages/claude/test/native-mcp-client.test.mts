import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { NativeMcpClient } from '../src/native-mcp-client.mjs'
import { deferred } from './fixtures/deferred.mjs'

async function setup(t: TestContext) {
  const [transport, remote] = InMemoryTransport.createLinkedPair()
  const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } })
  const client = new NativeMcpClient({ name: 'test', version: '1.0.0' })
  const errors: Error[] = []
  client.onerror = (error) => errors.push(error)
  t.after(async () => {
    await client.close()
    await server.close()
    assert.deepEqual(errors, [])
  })
  await server.connect(remote)
  await client.connect(transport)
  return { client, server, transport, remote }
}

test('MCP 工具默认无计时器，等待一天仍能接收进度和有效结果', async (t) => {
  const { client, server } = await setup(t)
  const entered = deferred()
  const answer = deferred()
  server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    const progressToken = extra._meta?.progressToken
    assert.ok(progressToken !== undefined)
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: 1, total: 2 },
    })
    entered.resolve()
    await answer.promise
    return { content: [{ type: 'text', text: 'confirmed' }] }
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const progress: number[] = []
  const result = client.callTool({ name: 'wait' }, undefined, {
    onprogress: (event) => progress.push(event.progress),
  })
  await entered.promise
  t.mock.timers.tick(86_400_000)
  answer.resolve()
  assert.deepEqual((await result).content, [{ type: 'text', text: 'confirmed' }])
  assert.deepEqual(progress, [1])
})

test('MCP 长等待后取消只结束目标请求，取消和迟到响应不影响其他工具', async (t) => {
  const { client, server, remote } = await setup(t)
  const entered = deferred()
  const cancelled = deferred()
  const answer = deferred()
  let requestId: string | number = ''
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === 'cancel') {
      requestId = extra.requestId
      extra.signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
      entered.resolve()
    }
    await answer.promise
    return { content: [{ type: 'text', text: request.params.name }] }
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const abort = new AbortController()
  const rejected = assert.rejects(
    client.callTool({ name: 'cancel' }, undefined, { signal: abort.signal }),
    /用户取消/,
  )
  const unaffected = client.callTool({ name: 'keep' })
  await entered.promise
  t.mock.timers.tick(86_400_000)
  abort.abort(new Error('用户取消'))
  await rejected
  await cancelled.promise
  await remote.send({ jsonrpc: '2.0', id: requestId, result: { content: [] } })
  answer.resolve()
  assert.deepEqual((await unaffected).content, [{ type: 'text', text: 'keep' }])
})

test('MCP 断线、发送失败和预先取消均结束等待', async (t) => {
  const { client, server, transport } = await setup(t)
  const abort = new AbortController()
  abort.abort(new Error('已经取消'))
  await assert.rejects(
    client.callTool({ name: 'wait' }, undefined, { signal: abort.signal }),
    /已经取消/,
  )
  const send = transport.send.bind(transport)
  transport.send = async () => {
    throw new Error('发送失败')
  }
  await assert.rejects(client.callTool({ name: 'wait' }), /发送失败/)
  transport.send = () => {
    throw new Error('同步发送失败')
  }
  await assert.rejects(client.callTool({ name: 'wait' }), /同步发送失败/)
  transport.send = send
  const entered = deferred()
  const answer = deferred()
  server.setRequestHandler(CallToolRequestSchema, async () => {
    entered.resolve()
    await answer.promise
    return { content: [] }
  })
  const disconnected = assert.rejects(client.callTool({ name: 'wait' }), /连接已关闭/)
  await entered.promise
  await server.close()
  await disconnected
  answer.resolve()
})

test('MCP 用户明确设置的工具执行超时仍生效', async (t) => {
  const { client, server } = await setup(t)
  const entered = deferred()
  const answer = deferred()
  server.setRequestHandler(CallToolRequestSchema, async () => {
    entered.resolve()
    await answer.promise
    return { content: [] }
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rejected = assert.rejects(
    client.callTool({ name: 'wait' }, undefined, { timeout: 1000 }),
    /Request timed out/,
  )
  await entered.promise
  t.mock.timers.tick(1001)
  await rejected
  answer.resolve()
})

test('MCP 无计时器调用继续执行 SDK 结果和结构化输出校验', async (t) => {
  const { client, server } = await setup(t)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'schema',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
        },
      },
    ],
  }))
  await client.listTools()
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [],
    structuredContent: { count: 'invalid' },
  }))
  await assert.rejects(client.callTool({ name: 'schema' }), /output schema/)
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [],
    structuredContent: { count: 3 },
  }))
  assert.deepEqual((await client.callTool({ name: 'schema' })).structuredContent, { count: 3 })
  server.setRequestHandler(CallToolRequestSchema, async () => {
    throw new Error('服务端拒绝')
  })
  await assert.rejects(client.callTool({ name: 'schema' }), /服务端拒绝/)
})
