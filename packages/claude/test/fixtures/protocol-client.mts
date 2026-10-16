import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { saveArtifact } from './artifacts.mjs'
import { configuredClaudeCli, requireClaudeCliFor, requiredClaudeCli } from './claude-cli.mjs'
import { reclaimAtEnd } from './reclaim.mjs'
import { validatePayload } from './schema-contract.mjs'

// 被测适配器进程的环境：白名单，不能继承个人模型凭据、代理或 Claude 配置；模型端只能是回环上的 Mock LLM。
// ProtocolClient 和别的要自己起适配器进程的夹具（upstream-compat.test.mts）共用这一份。
export function protocolEnv(
  home: string,
  baseURL: string,
  mock: boolean,
  auth: 'api-key' | 'oauth' = 'api-key',
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const endpoint = new URL(baseURL)
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error('协议测试只能连接回环 Mock LLM')
  const cli = mock ? configuredClaudeCli() : requiredClaudeCli()
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: home,
    CODEX_HOME: join(home, 'codex'),
    CHA_CLAUDE_HOME: join(home, 'adapter'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    // CLI 的每用户临时根不看 TMPDIR，默认是 /tmp/claude-<uid>（本机所有 Claude Code 共用），
    // 后台命令的输出、贴进来的图都写在那下面：指进用例自己的目录，跟着用例一起删
    CLAUDE_CODE_TMPDIR: join(home, 'ct'),
    CHA_CLAUDE_CLI: cli,
    ...(auth === 'oauth'
      ? { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-not-a-secret' }
      : { ANTHROPIC_API_KEY: 'test-not-a-secret' }),
    ANTHROPIC_BASE_URL: baseURL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CHA_CLAUDE_RUNTIME: mock ? 'mock' : 'agent-sdk-sidecar',
    CHA_CLAUDE_MOCK: mock ? '1' : '0',
    CHA_CLAUDE_DEFAULT_MODEL: 'claude-sonnet-4-6',
    NODE_NO_WARNINGS: '1',
    CHA_CLAUDE_SDK_DEBUG: '1',
    DEBUG_CLAUDE_AGENT_SDK: '1',
    ...extraEnv,
  }
}

export class ProtocolClient {
  readonly trace: any[] = []
  stderr = ''
  private readonly home: string
  private readonly modelEndpoint: string
  private protocolErrors: Error[] = []
  readonly process: ChildProcessWithoutNullStreams
  private readonly transportClosed: Promise<void>
  private readonly reclaimed: () => void
  private closing: Promise<void> | undefined
  private expectedCloseSignal: NodeJS.Signals | undefined
  private sequence = 0
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  onTool: ((params: any) => Promise<unknown>) | null = null
  onServerRequest: ((method: string, params: any) => Promise<unknown>) | null = null
  // 握手时声明了协议扩展的连接会收到标准 schema 之外的内容。用例在这里把服务端请求的参数和自己的应答
  // 换成去掉扩展之后的样子，其余部分照旧按标准 schema 校验；返回 undefined 表示这一条不校验。
  // 没声明扩展的连接不要设置它：收到的内容必须原样通过标准 schema。
  standardView: (method: string, kind: 'Params' | 'Response', payload: any) => unknown = (
    _method,
    _kind,
    payload,
  ) => payload

  private constructor(
    home: string,
    baseURL: string,
    mock: boolean,
    auth: 'api-key' | 'oauth',
    extraEnv: Record<string, string>,
  ) {
    this.home = home
    this.modelEndpoint = new URL(baseURL).origin
    const env = protocolEnv(home, baseURL, mock, auth, extraEnv)
    this.process = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../src/adapter.mjs', import.meta.url)), 'app-server'],
      { env },
    )
    this.reclaimed = reclaimAtEnd(() => this.close())
    this.transportClosed = new Promise((resolve) => {
      this.process.once('close', (exitCode, signal) => {
        this.trace.push({
          transport: {
            event: 'closed',
            source: 'process',
            exitCode,
            signal,
            ...(this.expectedCloseSignal ? { expectedSignal: this.expectedCloseSignal } : {}),
          },
        })
        resolve()
      })
    })
    this.process.stderr.on('data', (chunk) => {
      this.stderr += String(chunk)
    })
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      this.trace.push(message)
      if (message.method) {
        try {
          this.validate(message.method, 'Params', message.params)
        } catch (error) {
          this.protocolErrors.push(error as Error)
        }
      }
      if (message.method && message.id != null) {
        const handler =
          this.onServerRequest ??
          (message.method === 'item/tool/call' && this.onTool
            ? (_method: string, params: any) => this.onTool!(params)
            : null)
        if (!handler) {
          this.send({ id: message.id, error: { code: -32601, message: '测试端未实现回调' } })
          return
        }
        this.validate(message.method, 'Params', message.params)
        void handler(message.method, message.params)
          .then((result) => {
            this.validate(message.method, 'Response', result)
            this.send({ id: message.id, result })
          })
          .catch((error) => {
            this.protocolErrors.push(error as Error)
            this.send({ id: message.id, error: { code: -32000, message: String(error) } })
          })
        return
      }
      const waiter = this.pending.get(message.id)
      if (waiter) {
        this.pending.delete(message.id)
        waiter.resolve(message)
      }
    })
    this.process.on('exit', (code) => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error(`适配器退出 ${code}: ${this.stderr}`))
      this.pending.clear()
    })
  }
  static async start(
    home: string,
    baseURL: string,
    mock = false,
    auth: 'api-key' | 'oauth' = 'api-key',
    // 只用于适配器自己的开关；模型凭据、代理等仍然不能传进来。
    extraEnv: Record<string, string> = {},
    // 握手时的 capabilities。默认什么都不声明，和只说标准协议的客户端一样。
    capabilities: Record<string, unknown> | null = null,
  ): Promise<ProtocolClient> {
    if (!mock) await requireClaudeCliFor(home)
    await mkdir(join(home, 'claude'), { recursive: true })
    const client = new ProtocolClient(home, baseURL, mock, auth, extraEnv)
    try {
      await client.request('initialize', {
        clientInfo: { name: 'protocol-test', title: null, version: '1.0.0' },
        capabilities,
      })
    } catch (error) {
      await client.close()
      throw error
    }
    return client
  }
  private validate(method: string, kind: 'Params' | 'Response', payload: unknown): void {
    const standard = this.standardView(method, kind, payload)
    if (standard !== undefined) validatePayload(method, kind, standard)
  }
  private send(value: unknown, expectedErrorCode?: number): void {
    this.trace.push({
      direction: 'client',
      ...(value as Record<string, unknown>),
      ...(expectedErrorCode === undefined ? {} : { expectedErrorCode }),
    })
    this.process.stdin.write(`${JSON.stringify(value)}\n`)
  }
  async raw(method: string, params: unknown = {}, expectedErrorCode?: number): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC 超时 ${method}: ${this.stderr}`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          if (
            expectedErrorCode !== undefined &&
            (value.error?.code !== expectedErrorCode || 'result' in value)
          ) {
            reject(
              new Error(`RPC ${method} 应拒绝为 ${expectedErrorCode}: ${JSON.stringify(value)}`),
            )
            return
          }
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.send({ id, method, params }, expectedErrorCode)
    })
  }
  async request(method: string, params: unknown = {}): Promise<any> {
    validatePayload(method, 'Params', params)
    const response = await this.raw(method, params)
    if (response.error) throw new Error(JSON.stringify(response.error))
    validatePayload(method, 'Response', response.result)
    return response.result
  }
  async completed(turnId: string): Promise<any> {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (this.protocolErrors.length) throw this.protocolErrors[0]
      const message = this.trace.find(
        (item) => item.method === 'turn/completed' && item.params.turn.id === turnId,
      )
      if (message) return message.params.turn
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Turn 超时: ${this.stderr}\n${JSON.stringify(this.trace.slice(-8))}`)
  }
  async notification(
    method: string,
    predicate: (params: any) => boolean = () => true,
  ): Promise<any> {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (this.protocolErrors.length) throw this.protocolErrors[0]
      const message = this.trace.find((item) => item.method === method && predicate(item.params))
      if (message) return message.params
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`通知超时 ${method}: ${this.stderr}`)
  }
  crash(): void {
    this.expectedCloseSignal = 'SIGKILL'
    if (!this.process.kill('SIGKILL')) throw new Error('无法注入适配器进程崩溃')
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }
  private async shutdown(): Promise<void> {
    this.reclaimed()
    let forced = false
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGTERM')
    }
    // 收尾必须有界：适配器不响应时强制结束，并让用例失败，而不是让测试文件挂住。
    const escalate = setTimeout(() => {
      forced = true
      this.process.kill('SIGKILL')
    }, 15_000)
    await this.transportClosed
    clearTimeout(escalate)
    // CLI 将部分连接错误写入配置目录，stderr 可能为空；只读本用例的临时目录。
    const debugDirectory = join(this.home, 'claude', 'debug')
    const debugFiles = await readdir(debugDirectory, { withFileTypes: true }).catch(() => [])
    const debugLogs: Record<string, string> = {}
    for (const file of debugFiles.filter((entry) => entry.isFile()).slice(-16)) {
      const contents = await readFile(join(debugDirectory, file.name), 'utf8')
      debugLogs[file.name] = this.redactDiagnostics(contents.slice(-128_000))
    }
    // 子进程只接收白名单测试环境；保存诊断用于区分协议失败与 SDK 启动/沙箱失败。
    await saveArtifact('runtime-diagnostics', {
      modelEndpoint: this.modelEndpoint,
      stderr: this.redactDiagnostics(this.stderr.slice(-128_000)),
      debugLogs,
    })
    await saveArtifact('wire', {
      messages: this.trace,
      protocolErrors: this.protocolErrors.map((error) => error.message),
    })
    if (forced) throw new Error(`适配器 15 秒内没有响应 SIGTERM，已强制结束: ${this.stderr}`)
  }
  private redactDiagnostics(value: string): string {
    return value
      .replace(
        /^.*(?:authorization|api.?key|access.?token|refresh.?token|password|secret).*$/gim,
        '[redacted]',
      )
      .replaceAll('test-not-a-secret', '[redacted]')
  }
}
