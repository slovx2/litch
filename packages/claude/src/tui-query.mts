import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { McpSdkServerConfigWithInstance, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { hostClaudeVersion } from './host-claude.mjs'
import { registerTuiCli } from './native-process.mjs'
import { tuiHook } from './tui-hooks.mjs'
import { TuiMcp } from './tui-mcp.mjs'

export function tuiHelperBinary(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const path = fileURLToPath(
    new URL(
      `./tui-helper/${platform}-${arch}/claude-tui-helper${process.platform === 'win32' ? '.exe' : ''}`,
      import.meta.url,
    ),
  )
  if (!existsSync(path)) throw new Error('缺少 Claude TUI helper，请重新安装设备服务')
  return path
}

/** 交互 CLI 的本机流；SDK 只保留 MCP 实例和类型，不启动其非交互传输。 */
export class TuiQuery implements AsyncIterable<Record<string, unknown>> {
  private readonly options: Record<string, any>
  private readonly prompt: AsyncIterable<SDKUserMessage>
  private readonly token = randomBytes(32).toString('hex')
  private readonly mcp = new Map<string, TuiMcp>()
  private readonly server = createServer((request, response) => {
    void this.request(request, response)
  })
  private readonly queue: Record<string, unknown>[] = []
  private wake: (() => void) | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private stopped = false
  private disposed = false
  private failed: Error | null = null
  private sid: string | null = null
  private started = false
  private ownCli: (() => void) | null = null
  private hookReady = false
  private credentials: string | null = null
  private helperReady: (() => void) | null = null

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Record<string, any>) {
    this.prompt = prompt
    this.options = options
    // 旧版会忽略 onFailure，不能用版本不明的 CLI 承担权限闸。
    try {
      hostClaudeVersion(options.pathToClaudeCodeExecutable, '2.1.316')
    } catch (error) {
      throw new Error(
        'TUI 需要 Claude Code 2.1.316 或更新版本。请在设备的 Claude Code 设置中选择安装与更新 → 更新到最新。也可切回 SDK。',
        { cause: error },
      )
    }
    if (options.forkSession || options.outputFormat)
      throw new Error('TUI 后端暂不支持分叉和结构化输出')
    options.abortController.signal.addEventListener('abort', () => this.close(), { once: true })
  }

  private emit = (event: Record<string, unknown>): void => {
    if (this.stopped) return
    this.queue.push(event)
    this.wake?.()
  }

  private fail(error: unknown): void {
    if (!this.stopped) this.failed = error instanceof Error ? error : new Error(String(error))
    this.close()
  }

  private async request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (
        request.method !== 'POST' ||
        request.headers.authorization !== `Bearer ${this.token}` ||
        this.stopped
      ) {
        response.writeHead(403).end()
        return
      }
      let size = 0
      const chunks: Buffer[] = []
      for await (const data of request) {
        size += data.length
        if (size > 16 * 1024 * 1024) throw new Error('桥接请求过大')
        chunks.push(data)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      let result: unknown
      if (request.url === '/hook') {
        if (typeof body.session_id !== 'string') throw new Error('缺少原生会话编号')
        if (this.sid && body.session_id !== this.sid) throw new Error('权限桥会话编号不匹配')
        this.sid ??= body.session_id
        const pid = Number(request.headers['x-litch-cli-pid'])
        if (!this.ownCli && Number.isSafeInteger(pid) && pid > 1)
          this.ownCli = registerTuiCli(pid, optionsThread(this.options))
        result = await tuiHook(this.options, body, this.emit)
        if (body.hook_event_name === 'SessionStart') this.hookReady = true
      } else if (request.url?.startsWith('/mcp/')) {
        const bridge = this.mcp.get(decodeURIComponent(request.url.slice(5)))
        if (!bridge) throw new Error('没有这个会话的 MCP 服务')
        result = await bridge.request(body as JSONRPCMessage)
      } else throw new Error('未知桥接请求')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(result == null ? '' : JSON.stringify(result))
    } catch (error) {
      // Go hook 把非 200 转成 exit 2；CLI onFailure:block 还覆盖连 helper 都起不来的情形。
      response.writeHead(500).end(JSON.stringify({ error: String(error) }))
    }
  }

  private async start(): Promise<void> {
    const options = this.options
    options.abortController.signal.throwIfAborted()
    const binary = tuiHelperBinary()
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    options.abortController.signal.throwIfAborted()
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('TUI 权限桥没有监听地址')
    const base = `http://127.0.0.1:${address.port}`
    this.credentials = mkdtempSync(join(tmpdir(), 'litch-tui-auth-'))
    const tokenFile = join(this.credentials, 'token')
    writeFileSync(tokenFile, this.token, { mode: 0o600 })
    const servers: Record<string, unknown> = {}
    for (const [name, config] of Object.entries(options.mcpServers ?? {}) as Array<
      [string, McpSdkServerConfigWithInstance]
    >) {
      if (config.type !== 'sdk') throw new Error('TUI MCP 必须经宿主连接')
      const bridge = new TuiMcp(config.instance)
      this.mcp.set(name, bridge)
      await bridge.start()
      servers[name] = {
        command: binary,
        args: ['mcp', `${base}/mcp/${encodeURIComponent(name)}`, tokenFile],
      }
    }
    const hooks: Record<string, unknown> = {}
    for (const name of new Set([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      ...Object.keys(options.hooks ?? {}),
    ]))
      hooks[name] = [
        {
          hooks: [
            {
              type: 'command',
              command: binary,
              args: ['hook', `${base}/hook`, tokenFile],
              onFailure: 'block',
              timeout: 610,
            },
          ],
        },
      ]
    const settings = {
      ...options.settings,
      hooks,
      disableAllHooks: false,
      disableSkillShellExecution: true,
      sandbox: options.sandbox,
      env: {
        ...options.settings?.env,
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1',
      },
    }
    const args = [
      '--setting-sources',
      (options.settingSources ?? []).join(','),
      '--settings',
      JSON.stringify(settings),
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: servers }),
    ]
    if (options.model) args.push('--model', options.model)
    if (options.effort) args.push('--effort', options.effort)
    if (options.resume) {
      args.push('--resume', options.resume)
      this.sid = options.resume
    }
    if (options.systemPrompt?.append)
      args.push('--append-system-prompt', options.systemPrompt.append)
    if (options.additionalDirectories?.length)
      args.push('--add-dir', ...options.additionalDirectories)
    args.push(
      '--disallowedTools',
      [
        ...(options.disallowedTools ?? []),
        'Agent',
        'Task',
        'Workflow',
        'Monitor',
        'SendMessage',
        'ListAgents',
        'PowerShell',
        'EnterPlanMode',
        'ExitPlanMode',
      ].join(','),
    )
    options.abortController.signal.throwIfAborted()
    const env = { ...options.env }
    // SDK 模块会给宿主环境补自己的版本；交互进程不继承 SDK 身份。
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_AGENT_SDK')) delete env[key]
    this.child = options.spawnClaudeCodeProcess({
      command: binary,
      args: [options.pathToClaudeCodeExecutable, ...args],
      cwd: options.cwd,
      env: {
        ...env,
        // 上游会清理 magpie 前缀临时文件；限定在本会话目录，避免碰到别的 magpie 进程。
        TMPDIR: this.credentials,
        TEMP: this.credentials,
        TMP: this.credentials,
        MAGPIE_CLAUDE_TUI_ONLY: '1',
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1',
      },
      signal: options.abortController.signal,
    })
    const child = this.child
    if (!child) throw new Error('TUI helper 未启动')
    child.on('error', (error: Error) => this.fail(error))
    child.on('close', (code: number | null) => {
      if (!this.stopped && code !== 0)
        this.failed = new Error(
          `Claude TUI helper 已退出（${code}）；请在设备终端完成 Claude Code 登录与目录信任后重试`,
        )
      this.close()
      this.dispose()
    })
    const ready = new Promise<void>((resolve) => {
      this.helperReady = resolve
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line)
        if (event.type === 'system' && event.subtype === 'init') {
          if (!this.hookReady)
            throw new Error(
              'TUI 权限钩子没有生效；请检查 Claude 的托管策略或切回 SDK。尚未发送用户消息。',
            )
          this.sid = event.session_id
          this.helperReady?.()
        }
        if (event.type === 'user' && !event.message) return // 完整工具结果由 PostToolUse 桥传递。
        this.emit({ ...event, session_id: event.session_id ?? this.sid })
      } catch (error) {
        this.fail(error)
      }
    })
    void (async () => {
      await ready
      if (this.stopped) return
      for await (const message of this.prompt) {
        if (this.stopped) break
        child.stdin.write(`${JSON.stringify(message)}\n`)
      }
      child.stdin.end()
    })().catch((error) => this.fail(error))
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    if (this.started) throw new Error('TUI 输出只能读取一次')
    this.started = true
    try {
      await this.start()
      while (!this.stopped || this.queue.length) {
        const event = this.queue.shift()
        if (event) yield event
        else
          await new Promise<void>((resolve) => {
            this.wake = resolve
          })
        this.wake = null
      }
      if (this.failed) throw this.failed
    } finally {
      this.close()
      // 启动途中取消时，等 start 不再创建资源后统一清理；避免先 dispose 后又监听端口。
      if (!this.child) this.dispose()
    }
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.helperReady?.()
    this.child?.kill('SIGTERM')
    if (!this.started) this.dispose()
    this.wake?.()
  }

  // 先确认真实进程退出，再撤销身份和工具通道；不得提前释放仍可执行的审批。
  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ownCli?.()
    this.ownCli = null
    this.server.closeAllConnections()
    this.server.close()
    if (this.credentials) rmSync(this.credentials, { recursive: true, force: true })
    for (const bridge of this.mcp.values()) void bridge.close().catch(() => {})
    this.options.abortController.abort()
  }
  async interrupt(): Promise<void> {
    this.close()
  }
  async setPermissionMode(): Promise<void> {
    throw new Error('TUI 后端暂不支持切换计划模式，请切回 SDK')
  }
  async applyFlagSettings(): Promise<void> {
    throw new Error('TUI 后端不支持运行中修改模型或推理强度，请结束当前回合后重试')
  }
  async stopTask(): Promise<void> {
    throw new Error('TUI 后端不支持后台任务')
  }
  async getContextUsage(): Promise<never> {
    throw new Error('TUI 后端不提供实时上下文总账')
  }
}

function optionsThread(options: Record<string, any>): string {
  return String(options.env?.LITCH_THREAD_ID ?? '')
}
