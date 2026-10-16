import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { requireClaudeCliFor, requiredClaudeCli } from './claude-cli.mjs'
import { reclaimAtEnd } from './reclaim.mjs'
import { validatePayload } from './schema-contract.mjs'

export interface ServerRequest {
  id: string | number
  method: string
  params: any
}

// 守护进程上的一条真实 WebSocket 连接。服务端发来的请求（审批、提问）不自动回答，
// 记在 serverRequests 里由用例决定什么时候、怎么答。
export class DaemonClient {
  readonly trace: any[] = []
  readonly serverRequests: ServerRequest[] = []
  private readonly ws: WebSocket
  private sequence = 0
  private readonly pending = new Map<number, (message: any) => void>()
  private readonly protocolErrors: Error[] = []
  // 和 ProtocolClient 的同名钩子一样：握手时声明了协议扩展的连接在这里把服务端请求的参数和自己的应答
  // 换成去掉扩展之后的样子再按标准 schema 校验，返回 undefined 表示这一条不校验。没声明的连接不要设置它。
  standardView: (method: string, kind: 'Params' | 'Response', payload: any) => unknown = (
    _method,
    _kind,
    payload,
  ) => payload

  private validate(method: string, kind: 'Params' | 'Response', payload: unknown): void {
    const standard = this.standardView(method, kind, payload)
    if (standard !== undefined) validatePayload(method, kind, standard)
  }

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      this.trace.push(message)
      if (message.method) {
        try {
          this.validate(message.method, 'Params', message.params)
        } catch (error) {
          this.protocolErrors.push(error as Error)
        }
      }
      if (message.method && message.id != null) {
        this.serverRequests.push(message)
        return
      }
      const waiter = this.pending.get(message.id)
      if (waiter) {
        this.pending.delete(message.id)
        waiter(message)
      }
    })
  }

  static async open(
    address: string,
    name: string,
    capabilities: Record<string, unknown> | null = null,
    standardView?: DaemonClient['standardView'],
  ): Promise<DaemonClient> {
    const ws = new WebSocket(address)
    await once(ws, 'open')
    const client = new DaemonClient(ws)
    // 握手一完成服务端就可能把留着的请求送过来，校验用的钩子要在握手之前装好。
    if (standardView) client.standardView = standardView
    await client.request('initialize', {
      clientInfo: { name, title: null, version: '1.0.0' },
      capabilities,
    })
    return client
  }

  async raw(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC 超时 ${method}`))
      }, 30_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async request(method: string, params: unknown = {}): Promise<any> {
    validatePayload(method, 'Params', params)
    const response = await this.raw(method, params)
    if (response.error) throw new Error(JSON.stringify(response.error))
    validatePayload(method, 'Response', response.result)
    return response.result
  }

  // 回答一条服务端请求。
  answer(request: ServerRequest, result: unknown): void {
    this.validate(request.method, 'Response', result)
    this.ws.send(JSON.stringify({ id: request.id, result }))
  }

  private async waitFor<T>(what: string, find: () => T | undefined, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.protocolErrors.length) throw this.protocolErrors[0]
      const found = find()
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`等待超时：${what}\n${JSON.stringify(this.trace.slice(-6))}`)
  }

  serverRequest(method: string, timeoutMs = 30_000): Promise<ServerRequest> {
    return this.waitFor(
      `服务端请求 ${method}`,
      () => this.serverRequests.find((request) => request.method === method),
      timeoutMs,
    )
  }

  async notification(
    method: string,
    predicate: (params: any) => boolean = () => true,
    timeoutMs = 30_000,
  ): Promise<any> {
    const message = await this.waitFor(
      `通知 ${method}`,
      () => this.trace.find((item) => item.method === method && predicate(item.params)),
      timeoutMs,
    )
    return message.params
  }

  async completed(turnId: string, timeoutMs = 45_000): Promise<any> {
    const params = await this.notification(
      'turn/completed',
      (value) => value.turn.id === turnId,
      timeoutMs,
    )
    return params.turn
  }

  get connected(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  async disconnect(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return
    const closed = once(this.ws, 'close')
    this.ws.close()
    await closed
  }
}

// 真实的适配器进程，监听回环 WebSocket：连接可以断开、换一条再连，进程不随连接结束。
// 用来测“没有客户端在看”的那段时间和之后连上来的客户端。
export class Daemon {
  readonly process: ChildProcessWithoutNullStreams
  stderr = ''
  private readonly address: string
  private readonly exited: Promise<unknown>
  private readonly clients: DaemonClient[] = []
  private readonly reclaimed: () => void
  private closing: Promise<void> | undefined

  private constructor(
    home: string,
    modelUrl: string,
    address: string,
    env: Record<string, string>,
  ) {
    const endpoint = new URL(modelUrl)
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
      throw new Error('协议测试只能连接回环 Mock LLM')
    this.address = address
    // 白名单环境，不继承个人模型凭据、代理或 Claude 配置。
    this.process = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../src/adapter.mjs', import.meta.url)),
        'app-server',
        '--listen',
        address,
      ],
      {
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: home,
          TMPDIR: home,
          CODEX_HOME: join(home, 'codex'),
          CHA_CLAUDE_HOME: join(home, 'adapter'),
          CLAUDE_CONFIG_DIR: join(home, 'claude'),
          CLAUDE_CODE_TMPDIR: join(home, 'ct'),
          CHA_CLAUDE_CLI: requiredClaudeCli(),
          ANTHROPIC_API_KEY: 'test-not-a-secret',
          ANTHROPIC_BASE_URL: modelUrl,
          CHA_CLAUDE_RUNTIME: 'agent-sdk-sidecar',
          CHA_CLAUDE_MOCK: '0',
          CHA_CLAUDE_DEFAULT_MODEL: 'claude-sonnet-4-6',
          CHA_CLAUDE_IDLE_EXIT_MS: '0',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          NODE_NO_WARNINGS: '1',
          ...env,
        },
      },
    )
    this.process.stdout.resume()
    this.process.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-16_000)
    })
    this.exited = once(this.process, 'close')
    this.reclaimed = reclaimAtEnd(() => this.close())
  }

  // 只用于适配器自己的开关；模型凭据、代理等不能传进来。
  static async start(
    home: string,
    modelUrl: string,
    env: Record<string, string> = {},
  ): Promise<Daemon> {
    await requireClaudeCliFor(home)
    await mkdir(join(home, 'claude'), { recursive: true })
    const reserve = createServer()
    await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve))
    const address = `ws://127.0.0.1:${(reserve.address() as AddressInfo).port}`
    await new Promise<void>((resolve) => reserve.close(() => resolve()))
    return new Daemon(home, modelUrl, address, env)
  }

  // 新开一条连接并完成握手。进程刚启动时端口还没监听，重试到连上为止。
  // capabilities 是握手时的 capabilities，默认什么都不声明；声明了协议扩展的连接同时给出 standardView。
  async connect(
    name = 'daemon-test',
    capabilities: Record<string, unknown> | null = null,
    standardView?: DaemonClient['standardView'],
  ): Promise<DaemonClient> {
    const deadline = Date.now() + 15_000
    while (true) {
      try {
        const client = await DaemonClient.open(this.address, name, capabilities, standardView)
        this.clients.push(client)
        return client
      } catch (error) {
        if (Date.now() > deadline || this.process.exitCode !== null)
          throw new Error(`适配器守护进程没有启动：${String(error)}\n${this.stderr}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    this.reclaimed()
    for (const client of this.clients) await client.disconnect().catch(() => {})
    if (this.process.exitCode === null && this.process.signalCode === null)
      this.process.kill('SIGTERM')
    // 收尾有界：适配器不响应时强制结束，不让测试文件挂住。
    const escalate = setTimeout(() => this.process.kill('SIGKILL'), 15_000)
    await this.exited
    clearTimeout(escalate)
  }
}
