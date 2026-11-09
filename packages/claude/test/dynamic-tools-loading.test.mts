import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { dynamicToolName, dynamicToolServer } from '../src/dynamic-tools.mjs'

test('动态工具按各自声明延迟加载，搜索后的调用仍保留命名空间与参数校验', async (t) => {
  const definitions = [
    { name: 'default' },
    { name: 'pinned', deferLoading: false },
    { name: 'camel', deferLoading: true },
    { name: 'snake', defer_loading: true },
    { name: 'not_boolean', deferLoading: 'true' },
  ].map((fields) => ({
    type: 'function',
    description: '查询预算 budget',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    ...fields,
  }))
  const calls: unknown[] = []
  const server = dynamicToolServer(
    [{ type: 'namespace', name: 'budget', tools: definitions }],
    {
      onEvent: async () => {},
      onPermissionRequest: async () => ({ decision: 'decline' }),
      onDynamicToolCall: async (tool, args) => {
        calls.push([tool.namespace, tool.name, args])
        return { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] }
      },
    },
    () => 'call-1',
  )
  const client = new Client({ name: 'loading-test', version: '1.0.0' })
  t.after(async () => {
    await client.close()
    await server.instance.close()
  })
  const [local, remote] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(remote)
  await client.connect(local)
  const { tools } = await client.listTools()
  assert.deepEqual(
    tools.map((tool) => tool._meta?.['anthropic/alwaysLoad']),
    [true, true, undefined, undefined, true],
  )
  const name = dynamicToolName('budget', 'camel')
  assert.equal((await client.callTool({ name, arguments: { project: 'p1' } })).isError, false)
  await assert.rejects(client.callTool({ name, arguments: { project: 1 } }))
  assert.deepEqual(calls, [['budget', 'camel', { project: 'p1' }]])
})
