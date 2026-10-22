// 连接池里留着的连接坏了、被打断过、配置或账号变了时不能接着给下一个回合用（native-mcp-pool.mts）。
// 不起 CLI：桥接交给 CLI 的进程内服务实例由这里的 MCP 客户端直接连上去调，就是 CLI 那一头会做的事。
// stdio 服务是 fixtures/mcp-reuse-server.mjs，HTTP 服务是这里手写的，两边收到的都记下来数。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { sdkMcpServers } from '../src/mcp-config.mjs'
import { mcpOAuthManager } from '../src/mcp-oauth.mjs'
import { oauthBinding } from '../src/mcp-oauth-store.mjs'
import { NativeMcpBridge } from '../src/native-mcp-bridge.mjs'
import { NativeMcpPool } from '../src/native-mcp-pool.mjs'

interface Entry {
  pid: number
  event: string
  tool?: string
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'mcp-pool-health-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function stdioServer(log: string, env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [resolve('packages/claude/test/fixtures/mcp-reuse-server.mjs')],
    env: { FIXTURE_LOG_PATH: log, ...env },
  }
}

const entries = async (log: string): Promise<Entry[]> =>
  (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const started = async (log: string) =>
  (await entries(log)).filter((entry) => entry.event === 'started').map((entry) => entry.pid)
const closedPids = async (log: string) =>
  (await entries(log)).filter((entry) => entry.event === 'closed').map((entry) => entry.pid)
const count = async (log: string, event: string) =>
  (await entries(log)).filter((entry) => entry.event === event).length

async function eventually(check: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等不到预期的状态')
    await new Promise((done) => setTimeout(done, 20))
  }
}

// 一个“CLI 进程”：租用连接、把交给 CLI 的那一份连上，用完放回
async function session<T>(
  pool: NativeMcpPool,
  thread: string,
  servers: Record<string, unknown>,
  run: (clients: Record<string, Client>) => Promise<T> = async () => undefined as T,
): Promise<T> {
  const bridge = new NativeMcpBridge(pool, thread)
  const clients: Record<string, Client> = {}
  try {
    const served = await bridge.connect(servers, process.cwd(), {}, new AbortController().signal)
    for (const [name, config] of Object.entries(served)) clients[name] = await attach(config)
    return await run(clients)
  } finally {
    for (const client of Object.values(clients)) await client.close()
    await bridge.close()
  }
}

async function attach(config: McpSdkServerConfigWithInstance): Promise<Client> {
  const [cli, served] = InMemoryTransport.createLinkedPair()
  await config.instance.connect(served)
  const client = new Client({ name: 'cli-stand-in', version: '1.0.0' })
  await client.connect(cli)
  return client
}

/** 手写的 Streamable HTTP 服务：应答直接是 JSON；ping、工具调用回什么状态码由用例改 */
async function httpServer(options: { listChanged?: boolean } = {}) {
  const state = {
    initialize: 0,
    listed: 0,
    sessions: 0,
    ping: 200,
    call: 200,
  }
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') return res.writeHead(405).end()
    if (req.method === 'DELETE') return res.writeHead(200).end()
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const message = JSON.parse(Buffer.concat(chunks).toString())
    if (message.id === undefined) return res.writeHead(202).end()
    const reply = (result: unknown, headers: Record<string, string> = {}) =>
      res
        .writeHead(200, { 'Content-Type': 'application/json', ...headers })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    if (message.method === 'initialize') {
      state.initialize++
      return reply(
        {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: options.listChanged ? { listChanged: true } : {} },
          serverInfo: { name: 'http-fixture', version: '1.0.0' },
        },
        { 'Mcp-Session-Id': `s-${++state.sessions}` },
      )
    }
    if (message.method === 'ping')
      return state.ping === 200 ? reply({}) : res.writeHead(state.ping).end()
    if (message.method === 'tools/list') {
      state.listed++
      return reply({
        tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
      })
    }
    if (message.method === 'tools/call')
      return state.call === 200
        ? reply({ content: [{ type: 'text', text: 'ok' }] })
        : res.writeHead(state.call).end()
    res.writeHead(404).end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  return { state, url, close: () => new Promise((done) => server.close(done)) }
}

const pool = () => new NativeMcpPool({ idleMs: 60_000, maxIdle: 8 })

test('MCP-025：HTTP 服务的会话过期了（ping 回 404），下一个回合重新握手，不把死连接交出去', async () => {
  const http = await httpServer()
  const p = pool()
  try {
    const servers = { remote: { url: http.url } }
    await session(p, 't1', servers)
    http.state.ping = 404
    const text = await session(p, 't1', servers, async ({ remote }) => {
      const result = await remote!.callTool({ name: 'echo', arguments: {} })
      return (result.content as Array<{ text: string }>)[0]?.text
    })
    assert.equal(text, 'ok')
    assert.equal(http.state.initialize, 2)
  } finally {
    await p.close()
    await http.close()
  }
})

test('MCP-025：stdio 服务卡住了（ping 不回），等 ping 超时后关掉它，重起一份接着用', {
  timeout: 30_000,
}, async () => {
  await withHome(async (home) => {
    const log = join(home, 'log.jsonl')
    const p = pool()
    try {
      const servers = { local: stdioServer(log, { FIXTURE_HANG_PING: '1' }) }
      await session(p, 't1', servers)
      const begun = Date.now()
      await session(p, 't1', servers, async ({ local }) => {
        await local!.callTool({ name: 'echo', arguments: {} })
      })
      assert.ok(Date.now() - begun >= 4_500, 'ping 要等到超时')
      const pids = await started(log)
      assert.equal(pids.length, 2)
      await eventually(async () => (await closedPids(log)).includes(pids[0]!))
      assert.deepEqual(
        (await entries(log)).filter((e) => e.event === 'called').map((e) => e.pid),
        [pids[1]],
      )
    } finally {
      await p.close()
    }
  })
})

test('MCP-025：OAuth 失效（ping 回 401）不复用；重新连也要登录时照旧报要登录，不交出死连接', async () => {
  const http = await httpServer()
  const p = pool()
  try {
    const servers = { remote: { url: http.url } }
    await session(p, 't1', servers)
    http.state.ping = 401
    // 重新握手照常的话，下一个回合是新连上的那一条
    await session(p, 't1', servers)
    assert.equal(http.state.initialize, 2)
    // 工具调用时令牌失效：这条连接也不回池
    http.state.ping = 200
    http.state.call = 401
    await session(p, 't1', servers, async ({ remote }) => {
      await assert.rejects(remote!.callTool({ name: 'echo', arguments: {} }))
    })
    http.state.call = 200
    await session(p, 't1', servers)
    assert.equal(http.state.initialize, 3)
    assert.deepEqual(p.snapshot(), [{ thread: 't1', name: 'remote', taken: false }])
  } finally {
    await p.close()
    await http.close()
  }
})

test('MCP-025：换了账号重新登录（OAuth 登录代数变了）的服务，下一个回合重建连接', async () => {
  const http = await httpServer()
  const p = pool()
  try {
    const servers = { remote: { url: http.url } }
    await session(p, 't1', servers)
    await session(p, 't1', servers)
    assert.equal(http.state.initialize, 1)
    const config = sdkMcpServers(servers).remote
    mcpOAuthManager().noteLogin(oauthBinding('native-default', 'remote', config))
    await session(p, 't1', servers)
    assert.equal(http.state.initialize, 2)
  } finally {
    await p.close()
    await http.close()
  }
})

for (const how of ['取消', '超时'] as const)
  test(`MCP-025：工具请求被${how}过的连接不回池，下一个回合重起一份`, async () => {
    await withHome(async (home) => {
      const log = join(home, 'log.jsonl')
      const p = pool()
      try {
        // 超时用服务配置里的 timeout（毫秒）
        const servers = {
          local: { ...stdioServer(log), ...(how === '超时' ? { timeout: 200 } : {}) },
        }
        await session(p, 't1', servers, async ({ local }) => {
          const abort = new AbortController()
          const call = local!.callTool({ name: 'slow', arguments: {} }, undefined, {
            signal: abort.signal,
          })
          if (how === '取消') setTimeout(() => abort.abort(), 100)
          await assert.rejects(call)
        })
        await eventually(async () => (await closedPids(log)).length === 1)
        assert.deepEqual(p.snapshot(), [])
        await session(p, 't1', servers)
        assert.equal((await started(log)).length, 2)
      } finally {
        await p.close()
      }
    })
  })

test('MCP-025：工具清单只对声明了 listChanged 的 stdio 服务跨回合缓存；HTTP 和没声明的每回合照拉', async () => {
  await withHome(async (home) => {
    const logs = { cached: join(home, 'cached.jsonl'), plain: join(home, 'plain.jsonl') }
    const http = await httpServer({ listChanged: true })
    const p = pool()
    try {
      const servers = {
        cached: stdioServer(logs.cached, { FIXTURE_LIST_CHANGED: '1' }),
        plain: stdioServer(logs.plain),
        remote: { url: http.url },
      }
      for (let round = 0; round < 2; round++)
        await session(p, 't1', servers, async (clients) => {
          for (const client of Object.values(clients)) await client.listTools()
        })
      assert.equal(await count(logs.cached, 'listed'), 1)
      assert.equal(await count(logs.plain, 'listed'), 2)
      assert.equal(http.state.listed, 2)
      assert.equal((await started(logs.cached)).length, 1)
    } finally {
      await p.close()
      await http.close()
    }
  })
})

test('MCP-025：线程正在准备连接时被关掉，连好的连接不进池、用完就关；下一次准备连接时恢复复用', async () => {
  await withHome(async (home) => {
    const log = join(home, 'log.jsonl')
    const p = pool()
    try {
      const servers = { local: stdioServer(log, { FIXTURE_DELAY_MS: '400' }) }
      const bridge = new NativeMcpBridge(p, 't1')
      const connecting = bridge.connect(servers, process.cwd(), {}, new AbortController().signal)
      await eventually(async () => (await started(log)).length === 1)
      await p.closeThread('t1')
      await connecting
      assert.deepEqual(p.snapshot(), [])
      await bridge.close()
      await eventually(async () => (await closedPids(log)).length === 1)
      assert.deepEqual(p.snapshot(), [])
      await session(p, 't1', servers)
      await session(p, 't1', servers)
      assert.equal((await started(log)).length, 2)
      assert.deepEqual(p.snapshot(), [{ thread: 't1', name: 'local', taken: false }])
    } finally {
      await p.close()
    }
  })
})

test('MCP-025：客户端全都断开时（closeIdle）没人用的连接现在就关，正被用的接着用、用完就关', async () => {
  await withHome(async (home) => {
    const logs = { idle: join(home, 'idle.jsonl'), busy: join(home, 'busy.jsonl') }
    const p = pool()
    try {
      await session(p, 't1', { local: stdioServer(logs.idle) })
      const bridge = new NativeMcpBridge(p, 't2')
      await bridge.connect(
        { local: stdioServer(logs.busy) },
        process.cwd(),
        {},
        new AbortController().signal,
      )
      await p.closeIdle()
      await eventually(async () => (await closedPids(logs.idle)).length === 1)
      assert.deepEqual(p.snapshot(), [])
      assert.deepEqual(await closedPids(logs.busy), [])
      await bridge.close()
      await eventually(async () => (await closedPids(logs.busy)).length === 1)
    } finally {
      await p.close()
    }
  })
})

test('MCP-026：回合里有服务连不上（端口没人听）时跳过它，其余照常交给 CLI；管理操作照旧报错', async () => {
  const http = await httpServer()
  const closed = createServer()
  await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done))
  const dead = { url: `http://127.0.0.1:${(closed.address() as AddressInfo).port}/mcp` }
  await new Promise<void>((done) => closed.close(() => done()))
  const p = pool()
  try {
    const servers = { dead, remote: { url: http.url } }
    const names = await session(p, 't1', servers, async (clients) => Object.keys(clients))
    assert.deepEqual(names, ['remote'])
    assert.deepEqual(p.snapshot(), [{ thread: 't1', name: 'remote', taken: false }])
    const bridge = new NativeMcpBridge()
    try {
      await assert.rejects(
        bridge.connect({ dead }, process.cwd(), {}, new AbortController().signal),
      )
    } finally {
      await bridge.close()
    }
  } finally {
    await p.close()
    await http.close()
  }
})
