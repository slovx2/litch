import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mcpOAuthClientName, StoredOAuthProvider } from '../src/mcp-oauth-provider.mjs'
import type { OAuthCredential } from '../src/mcp-oauth-store.mjs'
import { permissionToolName } from '../src/permission-grants.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 入口交给模型的东西（系统提示、工具定义）和报给外部服务的客户端名里不出现内部名称。

test('NAMES-001：交给模型的系统提示和工具定义里没有内部名称', { timeout: 100_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-visible-names-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    let seen = ''
    model.enqueue((request) => {
      assert.ok(request.tools.some((tool: any) => tool.name === permissionToolName))
      seen = JSON.stringify({ system: request.system, tools: request.tools })
      return [{ type: 'text', text: 'DONE' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '你好' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
    assert.doesNotMatch(seen, /tyrs/i)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('NAMES-002：MCP OAuth 动态注册的客户端名默认是适配器的名字，可由 CHA_CLAUDE_MCP_OAUTH_CLIENT_NAME 改', () => {
  assert.equal(mcpOAuthClientName({}), 'codex-harness-adapter')
  assert.equal(
    mcpOAuthClientName({ CHA_CLAUDE_MCP_OAUTH_CLIENT_NAME: '  ' }),
    'codex-harness-adapter',
  )
  assert.equal(mcpOAuthClientName({ CHA_CLAUDE_MCP_OAUTH_CLIENT_NAME: 'Litch' }), 'Litch')
  const provider = new StoredOAuthProvider({} as OAuthCredential, 'http://127.0.0.1:1/callback')
  assert.equal(provider.clientMetadata.client_name, mcpOAuthClientName())
})
