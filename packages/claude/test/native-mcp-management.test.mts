import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('MCP-006：真实管理 RPC 分页、线程隔离、资源、元数据和工具副作用', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-mcp-management-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  const file = join(home, 'effects.txt')
  const config = (marker: string) => ({
    command: process.execPath,
    args: [resolve('packages/claude/test/fixtures/mcp-management-server.mjs')],
    env: { FIXTURE_MARKER: marker, FIXTURE_EFFECT_PATH: file },
  })
  try {
    const a = (
      await client.request('thread/start', {
        cwd: home,
        permissions: ':danger-full-access',
        config: { mcp_servers: { first: config('A'), second: config('A2') } },
      })
    ).thread.id
    const b = (
      await client.request('thread/start', {
        cwd: home,
        permissions: ':danger-full-access',
        config: { mcp_servers: { first: config('B') } },
      })
    ).thread.id
    const first = await client.request('mcpServerStatus/list', { threadId: a, limit: 1 })
    assert.equal(first.data.length, 1)
    assert.ok(first.nextCursor)
    assert.deepEqual(Object.keys(first.data[0].tools).sort(), ['append', 'fail'])
    assert.deepEqual(
      first.data[0].resources.map((x: any) => x.uri),
      ['fixture://first', 'fixture://second'],
    )
    assert.equal(first.data[0].resourceTemplates.length, 1)
    const second = await client.request('mcpServerStatus/list', {
      threadId: a,
      cursor: first.nextCursor,
      limit: 1,
    })
    assert.equal(second.data[0].name, 'second')
    assert.equal(second.nextCursor, null)
    await client.raw('mcpServerStatus/list', { threadId: b, cursor: first.nextCursor }, -32602)
    const resource = await client.request('mcpServer/resource/read', {
      threadId: b,
      server: 'first',
      uri: 'fixture://first',
    })
    assert.equal(resource.contents[0].text, 'B')
    const called = await client.request('mcpServer/tool/call', {
      threadId: a,
      server: 'first',
      tool: 'append',
      arguments: { value: 'once' },
      _meta: { trace: 'mcp-metadata' },
    })
    assert.equal(called.structuredContent.marker, 'A')
    assert.equal(called._meta.trace, 'mcp-metadata')
    assert.equal(await readFile(file, 'utf8'), 'once\n')
    const failed = await client.request('mcpServer/tool/call', {
      threadId: b,
      server: 'first',
      tool: 'fail',
      arguments: {},
    })
    assert.equal(failed.isError, true)
    assert.equal(failed.content[0].text, 'FIXTURE_TOOL_ERROR')
    await client.raw(
      'mcpServer/tool/call',
      { threadId: b, server: 'second', tool: 'append', arguments: { value: 'wrong' } },
      -32602,
    )
    await client.request('thread/settings/update', {
      threadId: a,
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    await client.raw(
      'mcpServer/tool/call',
      { threadId: a, server: 'first', tool: 'append', arguments: { value: 'blocked' } },
      -32004,
    )
    assert.equal(await readFile(file, 'utf8'), 'once\n')
    await client.request('config/mcpServer/reload', null)
    assert.equal(model.requests.length, 0)
    assert.ok(
      client.trace.some(
        (x) => x.method === 'mcpServer/startupStatus/updated' && x.params.status === 'ready',
      ),
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
