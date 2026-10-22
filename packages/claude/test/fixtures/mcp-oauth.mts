import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import WebSocket from 'ws'
import { saveArtifact } from './artifacts.mjs'
import { requireClaudeCliFor, requiredClaudeCli } from './claude-cli.mjs'
import { reclaimAtEnd } from './reclaim.mjs'
import { validatePayload } from './schema-contract.mjs'

const json = (res: ServerResponse, value: unknown, status = 200) =>
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
async function body(req: IncomingMessage): Promise<string> {
  let result = ''
  for await (const chunk of req) result += String(chunk)
  return result
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return 'http://127.0.0.1:' + address.port
}

// 授权服务器与 MCP 使用不同 origin，敏感业务头绝不能随发现或交换请求转发。
export class OAuthMcpFixture {
  readonly errors: string[] = []
  readonly codes = new Map<string, { challenge: string; redirect: string; client: string }>()
  readonly clients = new Map<string, string>()
  readonly authServer: Server
  readonly mcpServer: Server
  issuer = ''
  url = ''
  token = 'oauth-test-access-' + randomUUID()
  refreshToken = 'oauth-test-refresh-' + randomUUID()
  exchanges = 0
  tokenRequests = 0
  refreshes = 0
  effects = 0
  bearerRequests = 0
  authorizedRequests = 0
  failToken = false
  wrongIssuer = false
  wrongResource = false
  private readonly file: string
  private readonly mode: 'http' | 'sse'
  private readonly sse = new Map<string, SSEServerTransport>()
  private tokenGate: { started(): void; released: Promise<void> } | undefined
  private reclaimed: (() => void) | undefined

  constructor(file: string, mode: 'http' | 'sse' = 'http') {
    this.file = file
    this.mode = mode
    this.authServer = createServer((req, res) => {
      void this.authorization(req, res).catch((error) => {
        this.errors.push(String(error))
        if (!res.headersSent) json(res, { error: 'server_error' }, 500)
        else res.end()
      })
    })
    this.mcpServer = createServer((req, res) => {
      void this.mcp(req, res).catch((error) => {
        this.errors.push(String(error))
        if (!res.headersSent) json(res, { error: 'server_error' }, 500)
        else res.end()
      })
    })
  }

  async start(): Promise<string> {
    this.reclaimed = reclaimAtEnd(() => this.close())
    this.issuer = await listen(this.authServer)
    this.url = (await listen(this.mcpServer)) + (this.mode === 'sse' ? '/sse' : '/mcp')
    return this.url
  }

  rotate(): void {
    this.token = 'oauth-test-access-' + randomUUID()
  }

  pauseTokenExchange(): { started: Promise<void>; release(): void } {
    assert.equal(this.tokenGate, undefined, '只允许一个等待中的 token 交换')
    let started!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tokenGate = { started, released }
    return { started: ready, release }
  }

  async close(): Promise<void> {
    this.reclaimed?.()
    for (const transport of this.sse.values()) await transport.close()
    this.sse.clear()
    for (const server of [this.authServer, this.mcpServer]) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private async authorization(req: IncomingMessage, res: ServerResponse): Promise<void> {
    assert.equal(req.headers['x-resource-only'], undefined, '业务凭据头不能泄漏到授权服务器')
    assert.equal(req.headers.authorization, undefined, '资源 Bearer 不能泄漏到授权服务器')
    const url = new URL(req.url ?? '/', this.issuer)
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, {
        issuer: this.wrongIssuer ? this.issuer + '/wrong' : this.issuer,
        authorization_endpoint: this.issuer + '/authorize',
        token_endpoint: this.issuer + '/token',
        registration_endpoint: this.issuer + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      })
      return
    }
    if (url.pathname === '/register') {
      const value = JSON.parse(await body(req))
      const id = 'test-client-' + randomUUID()
      this.clients.set(id, value.redirect_uris[0])
      json(res, { ...value, client_id: id }, 201)
      return
    }
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(url.searchParams.get('resource'), this.url)
      const client = url.searchParams.get('client_id')!
      const redirect = url.searchParams.get('redirect_uri')!
      assert.equal(this.clients.get(client), redirect)
      const code = randomUUID()
      this.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect, client })
      const callback = new URL(redirect)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      res.writeHead(302, { Location: callback.href }).end()
      return
    }
    if (url.pathname === '/token') {
      this.tokenRequests++
      const values = new URLSearchParams(await body(req))
      const gate = this.tokenGate
      if (gate) {
        gate.started()
        await gate.released
        this.tokenGate = undefined
      }
      if (this.failToken) {
        json(res, { error: 'server_error' }, 500)
        return
      }
      assert.equal(values.get('resource'), this.url)
      if (values.get('grant_type') === 'authorization_code') {
        const code = values.get('code')!
        const original = this.codes.get(code)
        if (!original) {
          json(res, { error: 'invalid_grant' }, 400)
          return
        }
        this.codes.delete(code)
        assert.equal(values.get('client_id'), original.client)
        assert.equal(values.get('redirect_uri'), original.redirect)
        assert.equal(
          createHash('sha256').update(values.get('code_verifier')!).digest('base64url'),
          original.challenge,
        )
        this.exchanges++
      } else {
        assert.equal(values.get('grant_type'), 'refresh_token')
        assert.equal(values.get('refresh_token'), this.refreshToken)
        this.refreshes++
      }
      json(res, {
        access_token: this.token,
        token_type: 'Bearer',
        expires_in: 300,
        refresh_token: this.refreshToken,
        scope: 'fixture:write',
      })
      return
    }
    res.writeHead(404).end()
  }

  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      assert.equal(req.headers['x-resource-only'], undefined)
      json(res, {
        resource: this.wrongResource ? this.issuer + '/wrong' : this.url,
        authorization_servers: [this.issuer],
        scopes_supported: ['fixture:write'],
      })
      return
    }
    if (url.pathname !== new URL(this.url).pathname && url.pathname !== '/messages') {
      res.writeHead(404).end()
      return
    }
    if (req.headers.authorization) this.bearerRequests++
    if (req.headers.authorization !== 'Bearer ' + this.token) {
      res
        .writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${new URL(this.url).origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end()
      return
    }
    this.authorizedRequests++
    assert.equal(req.headers['x-resource-only'], 'resource-test-secret')
    if (this.mode === 'sse' && url.pathname === '/messages') {
      const transport = this.sse.get(url.searchParams.get('sessionId') ?? '')
      assert.ok(transport, 'SSE 消息必须绑定真实连接')
      await transport.handlePostMessage(req, res)
      return
    }
    if (this.mode === 'sse' && req.method === 'GET') {
      const mcp = this.createMcp()
      const transport = new SSEServerTransport('/messages', res)
      this.sse.set(transport.sessionId, transport)
      res.on('close', () => {
        this.sse.delete(transport.sessionId)
        void mcp.close()
      })
      await mcp.connect(transport)
      return
    }
    if (req.method === 'GET') {
      res.writeHead(405).end()
      return
    }
    const mcp = this.createMcp()
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
    res.on('close', () => {
      void mcp.close()
    })
    await mcp.connect(transport as unknown as Transport)
    await transport.handleRequest(req, res)
  }

  private createMcp(): McpServer {
    const mcp = new McpServer(
      { name: 'oauth-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'oauth_write',
          description: '通过真实 OAuth MCP 写入测试文件',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }))
    mcp.setRequestHandler(CallToolRequestSchema, async () => {
      await appendFile(this.file, 'OAUTH_REAL_EFFECT\n')
      this.effects++
      return { content: [{ type: 'text', text: 'OAUTH_REAL_EFFECT' }] }
    })
    return mcp
  }
}

// 使用真实适配器守护进程和真实 WebSocket；断开客户端不等同于终止进程。
export class OAuthDaemonFixture {
  readonly trace: any[] = []
  readonly process: ChildProcessWithoutNullStreams
  private readonly address: string
  private readonly exited: Promise<unknown>
  private readonly pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >()
  private sequence = 0
  private ws: WebSocket | undefined
  private readonly protocolErrors: string[] = []
  private readonly reclaimed: () => void
  private closing: Promise<void> | undefined

  constructor(home: string, endpoint: string, address: string) {
    assert.equal(new URL(endpoint).hostname, '127.0.0.1')
    this.address = address
    this.process = spawn(
      process.execPath,
      [resolve('packages/claude/dist/claude/src/adapter.mjs'), 'app-server', '--listen', address],
      {
        env: {
          PATH: dirname(process.execPath) + ':/usr/bin:/bin',
          HOME: home,
          TMPDIR: home,
          CODEX_HOME: join(home, 'codex'),
          CHA_CLAUDE_HOME: join(home, 'adapter'),
          // 日志目录（命令行平时经它交给入口）：调试日志、协议请求摘要都写在用例自己的目录里
          LITCH_LOG_DIR: join(home, 'adapter'),
          CLAUDE_CONFIG_DIR: join(home, 'claude'),
          CLAUDE_CODE_TMPDIR: join(home, 'ct'),
          CHA_CLAUDE_CLI: requiredClaudeCli(),
          ANTHROPIC_API_KEY: 'test-not-a-secret',
          ANTHROPIC_BASE_URL: endpoint,
          CHA_CLAUDE_RUNTIME: 'agent-sdk-sidecar',
          CHA_CLAUDE_MOCK: '0',
          CHA_CLAUDE_DEFAULT_MODEL: 'claude-sonnet-4-6',
          CHA_CLAUDE_IDLE_EXIT_MS: '0',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          NODE_NO_WARNINGS: '1',
        },
      },
    )
    this.process.stdout.resume()
    this.process.stderr.resume()
    this.exited = once(this.process, 'close')
    this.reclaimed = reclaimAtEnd(() => this.close())
  }

  static async start(home: string, endpoint: string): Promise<OAuthDaemonFixture> {
    await requireClaudeCliFor(home)
    await mkdir(join(home, 'claude'), { recursive: true })
    const reserve = createServer()
    const address = (await listen(reserve)).replace('http:', 'ws:')
    await new Promise<void>((resolve) => reserve.close(() => resolve()))
    const daemon = new OAuthDaemonFixture(home, endpoint, address)
    try {
      const deadline = Date.now() + 10_000
      while (true) {
        try {
          await daemon.connect()
          break
        } catch {
          if (Date.now() > deadline || daemon.process.exitCode !== null)
            throw new Error('真实 OAuth 守护进程没有启动')
          await delay(20)
        }
      }
      return daemon
    } catch (error) {
      await daemon.close()
      throw error
    }
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.address)
    this.ws = ws
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      this.trace.push(message)
      if (message.method) {
        try {
          validatePayload(message.method, 'Params', message.params)
        } catch (error) {
          this.protocolErrors.push(String(error))
        }
      }
      const waiter = this.pending.get(message.id)
      if (waiter) {
        this.pending.delete(message.id)
        waiter.resolve(message)
      }
    })
    await once(ws, 'open')
    await this.request('initialize', {
      clientInfo: { name: 'oauth-real-websocket', title: null, version: '1.0.0' },
      capabilities: null,
    })
  }

  async request(method: string, params: unknown = {}): Promise<any> {
    validatePayload(method, 'Params', params)
    const id = ++this.sequence
    const message = { id, method, params }
    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('OAuth WebSocket RPC 超时: ' + method)),
        15_000,
      )
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timer)
          resolve(value)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.trace.push({ direction: 'client', ...message })
      this.ws!.send(JSON.stringify(message))
    })
    assert.equal(response.error, undefined, '真实 WebSocket RPC 应成功: ' + method)
    validatePayload(method, 'Response', response.result)
    return response.result
  }

  async disconnect(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return
    const closed = once(this.ws, 'close')
    this.ws.close()
    await closed
    this.ws = undefined
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    this.reclaimed()
    await this.disconnect()
    let forced = false
    if (this.process.exitCode === null && this.process.signalCode === null)
      this.process.kill('SIGTERM')
    // 与 ProtocolClient 相同：收尾有界，不响应就强制结束并让用例失败。
    const escalate = setTimeout(() => {
      forced = true
      this.process.kill('SIGKILL')
    }, 15_000)
    await this.exited
    clearTimeout(escalate)
    await saveArtifact('wire', { messages: this.trace, protocolErrors: this.protocolErrors })
    assert.deepEqual(this.protocolErrors, [])
    assert.equal(forced, false, '守护进程 15 秒内没有响应 SIGTERM，已强制结束')
  }
}
