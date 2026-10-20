import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { sdkMcpServers, sdkMcpStartupEnvironment } from './mcp-config.mjs'
import { McpConnection, McpLease, type NativeMcpPool } from './native-mcp-pool.mjs'
import { submissionHash } from './protocol-contract.mjs'
import type { RuntimeHandlers } from './types.mjs'
import { debugLog } from './util.mjs'

// 连接仍进入真实 SDK 的 MCP 工具执行链；交互直接回到 Hub，避免 CLI 丢弃 URL 和元数据。
// 给了连接池（Claude 回合）就向池里租连接、用完放回；没给（管理操作）就现连、用完关掉。
// 交给 CLI 的进程内服务实例（McpServer）每个 CLI 进程现建一份，只有到服务的连接跨回合留着。
export class NativeMcpBridge {
  private readonly pool: NativeMcpPool | null
  private readonly thread: string
  private readonly leases = new Map<string, { connection: McpConnection; lease: McpLease }>()
  private closed = false

  constructor(pool: NativeMcpPool | null = null, thread = '') {
    this.pool = pool
    this.thread = thread
  }

  async connect(
    raw: unknown,
    cwd: string,
    handlers: Pick<RuntimeHandlers, 'onElicitationRequest'>,
    signal: AbortSignal,
    source = 'native-default',
  ): Promise<Record<string, McpSdkServerConfigWithInstance>> {
    const result: Record<string, McpSdkServerConfigWithInstance> = {}
    const timeout = Number(sdkMcpStartupEnvironment(raw).MCP_TIMEOUT ?? 30_000)
    const servers = Object.entries(sdkMcpServers(raw)).map(([name, config]) => ({
      name,
      config,
      fingerprint: submissionHash({ cwd, source, config }),
    }))
    const started = Date.now()
    this.pool?.retain(this.thread, new Set(servers.map(({ name }) => name)))
    // 池里能复用的先一起 ping：几个服务的往返叠在一起，不按个数累加。没 ping 通的已经关掉
    const pooled = await Promise.allSettled(
      servers.map(({ name, fingerprint }) => this.reuse(name, fingerprint, signal)),
    )
    const taken = pooled.flatMap((outcome, index) => {
      const name = servers[index]?.name
      return outcome.status === 'fulfilled' && outcome.value && name
        ? [{ name, connection: outcome.value }]
        : []
    })
    // ping 的时候进程已经收场了：原样放回去
    if (this.closed) {
      await Promise.all(taken.map(({ connection }) => this.pool?.release(connection, true)))
      throw new Error('MCP 运行时已关闭')
    }
    for (const { name, connection } of taken) {
      const lease = new McpLease(handlers, signal)
      connection.bind(lease)
      this.leases.set(name, { connection, lease })
    }
    const failed = pooled.find((outcome) => outcome.status === 'rejected')
    if (failed) throw failed.reason
    for (const { name, config, fingerprint } of servers) {
      if (this.closed) throw new Error('MCP 运行时已关闭')
      signal.throwIfAborted()
      let entry = this.leases.get(name)
      const reused = entry !== undefined
      if (!entry) {
        entry = {
          connection: new McpConnection(name, fingerprint),
          lease: new McpLease(handlers, signal),
        }
        entry.connection.bind(entry.lease)
        this.leases.set(name, entry)
        // 没给连接池（管理操作）：和以前一样，操作一取消就连同连接一起关掉
        if (!this.pool) {
          const { connection } = entry
          entry.lease.signal.addEventListener(
            'abort',
            () => void connection.close().catch(() => {}),
            {
              once: true,
            },
          )
        }
        await entry.connection.connect(config, cwd, source, entry.lease, timeout)
        this.pool?.adopt(this.thread, name, entry.connection)
      }
      if (this.closed) throw new Error('MCP 运行时已关闭')
      signal.throwIfAborted()
      const { connection, lease } = entry
      debugLog('native.mcp.ready', {
        threadId: this.thread,
        server: name,
        reused,
        atMs: Date.now() - started,
      })
      result[name] = this.serve(name, config, connection, lease)
    }
    debugLog('native.mcp.prepared', {
      threadId: this.thread,
      servers: servers.length,
      ms: Date.now() - started,
    })
    return result
  }

  // 池里有配置对得上的空闲连接、ping 得通就用它；不通的关掉，由调用方重新连。
  private async reuse(
    name: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<McpConnection | null> {
    const pool = this.pool
    const connection = pool?.take(this.thread, name, fingerprint)
    if (!pool || !connection) return null
    let healthy = false
    try {
      healthy = await connection.healthy(signal)
    } finally {
      if (!healthy) await pool.release(connection, false)
    }
    return connection
  }

  // 交给 CLI 的那一份：请求都挂在这次租约上，进程收场时还没完的一起取消。
  private serve(
    name: string,
    config: Record<string, any>,
    connection: McpConnection,
    lease: McpLease,
  ): McpSdkServerConfigWithInstance {
    const client = connection.client
    const capabilities = client.getServerCapabilities() ?? {}
    const instructions = client.getInstructions()
    const instance = new McpServer(client.getServerVersion() ?? { name, version: '1.0.0' }, {
      capabilities: {
        tools: {},
        ...(capabilities.resources ? { resources: {} } : {}),
        ...(capabilities.prompts ? { prompts: {} } : {}),
      },
      ...(instructions === undefined ? {} : { instructions }),
    })
    const call = <T,>(
      requestSignal: AbortSignal,
      run: (options: { signal: AbortSignal; timeout?: number }) => Promise<T>,
    ): Promise<T> =>
      lease.track(requestSignal, false, (signal) =>
        run({ signal, ...(config.timeout === undefined ? {} : { timeout: config.timeout }) }),
      )
    instance.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      if (!capabilities.tools) return { tools: [] }
      const listed = await call(extra.signal, (options) =>
        connection.listTools(request.params, options),
      )
      return {
        ...listed,
        tools: listed.tools.map((tool) => ({
          ...tool,
          _meta: { ...tool._meta, 'anthropic/alwaysLoad': true },
        })),
      }
    })
    instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      call(extra.signal, (options) => client.callTool(request.params, undefined, options)),
    )
    if (capabilities.resources) {
      instance.server.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
        call(extra.signal, (options) => client.listResources(request.params, options)),
      )
      instance.server.setRequestHandler(ListResourceTemplatesRequestSchema, (request, extra) =>
        call(extra.signal, (options) => client.listResourceTemplates(request.params, options)),
      )
      instance.server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
        call(extra.signal, (options) => client.readResource(request.params, options)),
      )
    }
    if (capabilities.prompts) {
      instance.server.setRequestHandler(ListPromptsRequestSchema, (request, extra) =>
        call(extra.signal, (options) => client.listPrompts(request.params, options)),
      )
      instance.server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
        call(extra.signal, (options) => client.getPrompt(request.params, options)),
      )
    }
    return {
      type: 'sdk',
      name,
      instance,
      ...(config.timeout ? { timeout: config.timeout } : {}),
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const leases = [...this.leases.values()]
    this.leases.clear()
    await Promise.all(
      leases.map(({ connection, lease }) => {
        const reusable = connection.unbind(lease)
        return this.pool ? this.pool.release(connection, reusable) : connection.close()
      }),
    )
  }

  client(name: string): Client {
    const entry = this.leases.get(name)
    if (!entry || entry.connection.closed || this.closed) throw new Error('MCP 连接未建立或已关闭')
    return entry.connection.client
  }
}

// 适配器配置里的 MCP 服务归适配器管，Claude Code 不许再照它自己的配置去连同名的服务。
// 用户级配置（.claude.json）里的服务两边都读得到：不拦的话每个回合同一个服务会被起两份，
// 工具调用只落在桥接的那一份上，CLI 自己连的那一份白起一场、活到回合结束；
// 在适配器这边停用了的服务，CLI 也照样会自己连上、把工具交给模型。
// 按名字拦（Claude Code 设置里的 deniedMcpServers）：这份名单不管进程内的 sdk 类型服务，
// 桥接进去的那一份不受影响；只有 CLI 知道的服务（项目里的 .mcp.json 等）名字不在里面，照旧由它自己连。
export function cliDeniedServers(raw: unknown): Array<{ serverName: string }> {
  if (!raw || typeof raw !== 'object') return []
  // Claude Code 不收空的和首尾带空白的名字，带了整份设置都不认
  return Object.keys(raw)
    .filter((name) => name !== '' && name === name.trim())
    .map((serverName) => ({ serverName }))
}
