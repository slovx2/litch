import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ElicitRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { sdkMcpServers, sdkMcpStartupEnvironment } from './mcp-config.mjs'
import { mcpOAuthManager } from './mcp-oauth.mjs'
import { OAuthLoginRequired } from './mcp-oauth-provider.mjs'
import { NativeMcpClient } from './native-mcp-client.mjs'
import type { RuntimeHandlers } from './types.mjs'

// 连接仍进入真实 SDK 的 MCP 工具执行链；交互直接回到 Hub，避免 CLI 丢弃 URL 和元数据。
export class NativeMcpBridge {
  private readonly clients = new Map<string, Client>()
  private readonly closing = new Map<Client, Promise<void>>()
  private closed = false

  async connect(
    raw: unknown,
    cwd: string,
    handlers: Pick<RuntimeHandlers, 'onElicitationRequest'>,
    signal: AbortSignal,
    source = 'native-default',
  ): Promise<Record<string, McpSdkServerConfigWithInstance>> {
    const result: Record<string, McpSdkServerConfigWithInstance> = {}
    const timeout = Number(sdkMcpStartupEnvironment(raw).MCP_TIMEOUT ?? 30_000)
    for (const [name, config] of Object.entries(sdkMcpServers(raw))) {
      signal.throwIfAborted()
      const client = new NativeMcpClient(
        { name: 'codex-harness-adapter', version: '0.1.0' },
        {
          capabilities: { elicitation: { form: {}, url: {} } },
        },
      )
      this.clients.set(name, client)
      client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        const combined = AbortSignal.any([signal, extra.signal])
        combined.throwIfAborted()
        if (!handlers.onElicitationRequest) throw new Error('MCP 交互处理器未注册')
        const response = await handlers.onElicitationRequest(
          { ...request.params, mode: request.params.mode ?? 'form', serverName: name },
          combined,
        )
        combined.throwIfAborted()
        return response
      })
      const cancel = () => {
        void this.closeClient(client).catch(() => {})
      }
      signal.addEventListener('abort', cancel, { once: true })
      client.onclose = () => signal.removeEventListener('abort', cancel)
      await client.connect(mcpTransport(config, cwd, signal, source, name), { signal, timeout })
      if (this.closed) throw new Error('MCP 运行时已关闭')
      signal.throwIfAborted()
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
      const options = (requestSignal: AbortSignal) => ({
        signal: AbortSignal.any([signal, requestSignal]),
        ...(config.timeout === undefined ? {} : { timeout: config.timeout }),
      })
      instance.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        if (!capabilities.tools) return { tools: [] }
        const listed = await client.listTools(request.params, options(extra.signal))
        return {
          ...listed,
          tools: listed.tools.map((tool) => ({
            ...tool,
            _meta: { ...tool._meta, 'anthropic/alwaysLoad': true },
          })),
        }
      })
      instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
        client.callTool(request.params, undefined, options(extra.signal)),
      )
      if (capabilities.resources) {
        instance.server.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
          client.listResources(request.params, options(extra.signal)),
        )
        instance.server.setRequestHandler(ListResourceTemplatesRequestSchema, (request, extra) =>
          client.listResourceTemplates(request.params, options(extra.signal)),
        )
        instance.server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
          client.readResource(request.params, options(extra.signal)),
        )
      }
      if (capabilities.prompts) {
        instance.server.setRequestHandler(ListPromptsRequestSchema, (request, extra) =>
          client.listPrompts(request.params, options(extra.signal)),
        )
        instance.server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
          client.getPrompt(request.params, options(extra.signal)),
        )
      }
      result[name] = {
        type: 'sdk',
        name,
        instance,
        ...(config.timeout ? { timeout: config.timeout } : {}),
      }
    }
    return result
  }

  async close(): Promise<void> {
    this.closed = true
    const clients = [...this.clients.values()]
    this.clients.clear()
    for (const client of clients) this.closeClient(client)
    await Promise.all(this.closing.values())
  }

  private closeClient(client: Client): Promise<void> {
    // SDK transport 的第二次 close 会立即返回；必须复用首次关闭的完成屏障。
    let pending = this.closing.get(client)
    if (!pending) {
      pending = client.close()
      this.closing.set(client, pending)
    }
    return pending
  }

  client(name: string): Client {
    const client = this.clients.get(name)
    if (!client || this.closed) throw new Error('MCP 连接未建立或已关闭')
    return client
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

function mcpTransport(
  config: Record<string, any>,
  cwd: string,
  signal: AbortSignal,
  source: string,
  name: string,
): Transport {
  if (config.type === 'stdio')
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd,
      stderr: 'inherit',
    })
  const requestInit = { headers: config.headers }
  const authenticatedFetch = mcpOAuthManager().fetch(source, name, config, signal)
  let oauthFailure: OAuthLoginRequired | undefined
  const fetchWithSignal: typeof fetch = async (input, init) => {
    // MCP SDK 会把 signal 放在 Request 对象里；覆盖它会让关闭后的 SSE 持续挂起。
    const signals = [signal]
    if (input instanceof Request) signals.push(input.signal)
    if (init?.signal) signals.push(init.signal)
    try {
      return await authenticatedFetch(input, {
        ...init,
        signal: AbortSignal.any(signals),
      })
    } catch (error) {
      if (error instanceof OAuthLoginRequired) oauthFailure = error
      throw error
    }
  }
  if (config.type === 'sse') {
    const transport = new SSEClientTransport(new URL(config.url), {
      requestInit,
      fetch: fetchWithSignal,
    })
    const start = transport.start.bind(transport)
    transport.start = async () => {
      oauthFailure = undefined
      try {
        await start()
      } catch (error) {
        // EventSource 会丢掉原始异常类型，保留真实 fetch 失败而非按文本猜测认证状态。
        throw oauthFailure ?? error
      }
    }
    return transport
  }
  // 固定 MCP SDK 的 class 与接口对 sessionId 可选性的声明不一致。
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit,
    fetch: fetchWithSignal,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  }) as unknown as Transport
}
