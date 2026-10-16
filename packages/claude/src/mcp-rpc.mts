import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { sdkMcpServers } from './mcp-config.mjs'
import { mcpOAuthManager } from './mcp-oauth.mjs'
import { OAuthLoginRequired } from './mcp-oauth-provider.mjs'
import { NativeMcpBridge } from './native-mcp-bridge.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import type { RuntimeHandlers } from './types.mjs'

export interface McpScope {
  threadId: string | null
  cwd: string
  servers: Record<string, unknown>
  source: string
}
export interface McpCallbacks {
  peerId: string
  elicitation: NonNullable<RuntimeHandlers['onElicitationRequest']>
  status(name: string, status: string, error: string | null): void
}

// 操作被取消（连接断开、重载）与服务自身失败的区别：前者不该再继续探测别的服务。
export class McpOperationCancelled extends ProtocolError {}

// 管理 RPC 不调用 LLM；一次操作共用完成初始化的 MCP 会话，不重放失败的工具。
export class McpRpc {
  private readonly operations = new Map<AbortController, { peerId: string; done: Promise<void> }>()
  private closed = false

  async withClient<T>(
    scope: McpScope,
    name: string,
    callbacks: McpCallbacks,
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new ProtocolError(-32009, 'MCP 管理器已关闭')
    if (!Object.hasOwn(sdkMcpServers(scope.servers), name))
      throw new ProtocolError(-32602, '当前会话未配置指定 MCP 服务')
    const abort = new AbortController()
    const bridge = new NativeMcpBridge()
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.operations.set(abort, { peerId: callbacks.peerId, done })
    callbacks.status(name, 'starting', null)
    try {
      await bridge.connect(
        { [name]: scope.servers[name] },
        scope.cwd,
        {
          onElicitationRequest: callbacks.elicitation,
        },
        abort.signal,
        scope.source,
      )
      callbacks.status(name, 'ready', null)
      return await operation(bridge.client(name), abort.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      callbacks.status(name, abort.signal.aborted ? 'cancelled' : 'failed', message)
      if (error instanceof ProtocolError) throw error
      if (error instanceof OAuthLoginRequired) throw error
      if (abort.signal.aborted)
        throw new McpOperationCancelled(-32001, `MCP ${name} 操作失败: ${message}`)
      throw new ProtocolError(-32001, `MCP ${name} 操作失败: ${message}`)
    } finally {
      try {
        await bridge.close()
      } finally {
        this.operations.delete(abort)
        finish()
      }
    }
  }

  async statuses(scope: McpScope, params: Record<string, unknown>, callbacks: McpCallbacks) {
    const configured = sdkMcpServers(scope.servers)
    const names = Object.keys(configured).sort()
    const detail = params.detail ?? 'full'
    if (!['full', 'toolsAndAuthOnly'].includes(String(detail)))
      throw new ProtocolError(-32602, 'MCP 状态 detail 无效')
    const limit = params.limit ?? 100
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new ProtocolError(-32602, 'MCP 状态 limit 必须在 1 到 1000 之间')
    const key = createHash('sha256')
      .update(JSON.stringify([scope.threadId, scope.servers, detail]))
      .digest('hex')
    let offset = 0
    if (params.cursor != null) {
      try {
        if (typeof params.cursor !== 'string') throw new Error()
        const cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString())
        if (
          cursor.key !== key ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0 ||
          cursor.offset > names.length
        )
          throw new Error()
        offset = cursor.offset
      } catch {
        throw new ProtocolError(-32602, 'MCP 游标无效或不属于当前查询')
      }
    }
    const data: Record<string, unknown>[] = []
    for (const name of names.slice(offset, offset + limit)) {
      try {
        data.push(
          await this.withClient(scope, name, callbacks, async (client, signal) => {
            const caps = client.getServerCapabilities() ?? {}
            const tools = caps.tools
              ? await collectPages((cursor) => client.listTools({ cursor }, { signal }))
              : []
            const full = detail === 'full' && caps.resources
            const resources = full
              ? await collectPages((cursor) => client.listResources({ cursor }, { signal }))
              : []
            // 声明了资源能力的服务不一定实现模板目录；"方法不存在"等同于没有模板，
            // 不能因此把整个服务判为失败。
            const templates = full
              ? await collectPages((cursor) =>
                  client.listResourceTemplates({ cursor }, { signal }),
                ).catch((error: unknown) => {
                  if ((error as { code?: unknown } | null)?.code === -32601) return []
                  throw error
                })
              : []
            return {
              name,
              tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
              resources,
              resourceTemplates: templates,
              serverInfo: client.getServerVersion() ?? null,
              authStatus: Object.keys(configured[name].headers ?? {}).some(
                (header) => header.toLowerCase() === 'authorization',
              )
                ? 'bearerToken'
                : configured[name].type !== 'stdio' &&
                    mcpOAuthManager().status(scope.source, name, configured[name]) === 'oAuth'
                  ? 'oAuth'
                  : 'unsupported',
            }
          }),
        )
      } catch (error) {
        if (!(error instanceof OAuthLoginRequired)) throw error
        data.push({
          name,
          tools: {},
          resources: [],
          resourceTemplates: [],
          serverInfo: null,
          authStatus: 'notLoggedIn',
        })
      }
    }
    const next = offset + data.length
    return {
      data,
      nextCursor:
        next < names.length
          ? Buffer.from(JSON.stringify({ key, offset: next })).toString('base64url')
          : null,
    }
  }

  closePeer(peerId: string): void {
    for (const [abort, operation] of this.operations) if (operation.peerId === peerId) abort.abort()
  }

  async cancelAll(): Promise<void> {
    const pending = [...this.operations]
    for (const [abort] of pending) abort.abort()
    await Promise.all(pending.map(([, operation]) => operation.done))
  }

  async close(): Promise<void> {
    this.closed = true
    await this.cancelAll()
  }
}

// 服务端目录也可能分页；重复游标明确失败，不能漏项或无限循环。
async function collectPages(
  read: (cursor: string | undefined) => Promise<Record<string, any>>,
): Promise<Record<string, any>[]> {
  const result: Record<string, any>[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await read(cursor)
    const items = page.tools ?? page.resources ?? page.resourceTemplates
    if (!Array.isArray(items)) throw new Error('MCP 返回的目录不是数组')
    result.push(...items)
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || seen.has(cursor))
        throw new Error('MCP 返回了重复或无效的游标')
      seen.add(cursor)
    }
  } while (cursor !== undefined)
  return result
}
