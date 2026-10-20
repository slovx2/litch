import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ElicitRequestSchema,
  ErrorCode,
  type ListToolsRequest,
  type ListToolsResult,
  McpError,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { mcpOAuthManager } from './mcp-oauth.mjs'
import { OAuthLoginRequired } from './mcp-oauth-provider.mjs'
import { NativeMcpClient } from './native-mcp-client.mjs'
import type { RuntimeHandlers } from './types.mjs'

// 跨回合复用 MCP 连接。连接按“线程 + 服务名”放一格，配置指纹（工作目录、OAuth 来源、
// 归一化后的服务配置，含已经代入的环境变量与请求头）对不上就重建。每个 CLI 进程（或一次管理操作）
// 租用一次连接：征询、工具请求都挂在租约上，路由到租用方当前的回合；租约结束时还没完的请求一并取消。
// 租用期间有请求被取消、超时或因租约结束中止的连接不回池：服务那头可能还在处理，下一个回合重新连。

type ElicitationHandlers = Pick<RuntimeHandlers, 'onElicitationRequest'>

// 复用前先 ping 一次：stdio 服务的进程退出了会直接看到，HTTP 服务重启、会话过期要问了才知道。
const REUSE_PING_TIMEOUT_MS = 5_000

export class McpLease {
  readonly handlers: ElicitationHandlers
  readonly signal: AbortSignal
  private readonly ended = new AbortController()
  private active = 0
  // 有请求没正常收场：连接不再回池。
  disrupted = false
  // 租约中止（回合被打断、进程收场）时还有请求在途：由连接立即关掉自己。
  // 和以前每回合一条连接时一样，挂着的征询随连接作废、不另外答复，服务也看得到连接断了。
  ondisrupt: (() => void) | null = null

  constructor(handlers: ElicitationHandlers, signal: AbortSignal) {
    this.handlers = handlers
    this.signal = AbortSignal.any([signal, this.ended.signal])
    this.signal.addEventListener(
      'abort',
      () => {
        if (this.active === 0) return
        this.disrupted = true
        this.ondisrupt?.()
      },
      { once: true },
    )
  }

  // fromServer：服务发来的请求（征询）。服务自己撤回它不算异常；我们这头撤回的工具请求算。
  async track<T>(
    requestSignal: AbortSignal | undefined,
    fromServer: boolean,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = requestSignal ? AbortSignal.any([this.signal, requestSignal]) : this.signal
    signal.throwIfAborted()
    this.active++
    try {
      return await run(signal)
    } catch (error) {
      if (
        this.signal.aborted ||
        (!fromServer && requestSignal?.aborted) ||
        (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
      )
        this.disrupted = true
      throw error
    } finally {
      this.active--
    }
  }

  end(): void {
    if (this.active > 0) this.disrupted = true
    this.ended.abort(new Error('MCP 连接的租用已结束'))
  }
}

export class McpConnection {
  readonly name: string
  readonly fingerprint: string
  readonly client: NativeMcpClient
  // 连接本身的寿命：HTTP 请求（含常驻的 SSE 流）都挂在它上面，不跟着某个 CLI 进程。
  private readonly lifetime = new AbortController()
  private lease: McpLease | null = null
  private closing: Promise<void> | null = null
  // 工具清单只在 stdio 服务声明了 tools.listChanged 时缓存，收到变更通知就作废：通知和应答走同一条管道，
  // 收得到。HTTP 的通知走另开的 GET 流，服务可以不支持，断了也不重连（maxRetries 为 0），所以不缓存。
  private toolList: ListToolsResult | null = null
  private stdio = false
  private toolGeneration = 0
  closed = false
  // OAuth 失效之类：这条连接上后面的请求也会失败，不回池。
  broken = false
  onclose: (() => void) | null = null

  constructor(name: string, fingerprint: string) {
    this.name = name
    this.fingerprint = fingerprint
    this.client = new NativeMcpClient(
      { name: 'codex-harness-adapter', version: '0.1.0' },
      { capabilities: { elicitation: { form: {}, url: {} } } },
    )
    this.client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const lease = this.lease
      if (!lease) throw new Error('没有进行中的回合，不能处理 MCP 交互')
      return lease.track(extra.signal, true, async (signal) => {
        if (!lease.handlers.onElicitationRequest) throw new Error('MCP 交互处理器未注册')
        const response = await lease.handlers.onElicitationRequest(
          { ...request.params, mode: request.params.mode ?? 'form', serverName: this.name },
          signal,
        )
        signal.throwIfAborted()
        return response
      })
    })
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.toolList = null
      this.toolGeneration++
    })
    this.client.onclose = () => {
      this.closed = true
      this.onclose?.()
    }
  }

  get leased(): boolean {
    return this.lease !== null
  }

  bind(lease: McpLease): void {
    if (this.lease) throw new Error('MCP 连接正被别的进程使用')
    this.lease = lease
    lease.ondisrupt = () => {
      void this.close().catch(() => {})
    }
  }

  // 结束租用；返回这条连接还能不能给下一个进程用。
  unbind(lease: McpLease): boolean {
    if (this.lease !== lease) return false
    lease.end()
    this.lease = null
    return !lease.disrupted && !this.broken && !this.closed
  }

  // 连接期间租约结束（回合被打断、进程收场）就关掉连接，和以前一样不留半连上的服务。
  async connect(
    config: Record<string, any>,
    cwd: string,
    source: string,
    lease: McpLease,
    timeout: number,
  ): Promise<void> {
    const cancel = () => {
      void this.close().catch(() => {})
    }
    lease.signal.addEventListener('abort', cancel, { once: true })
    try {
      lease.signal.throwIfAborted()
      this.stdio = config.type === 'stdio'
      const signal = AbortSignal.any([lease.signal, this.lifetime.signal])
      const transport = mcpTransport(config, cwd, this.lifetime.signal, source, this.name, () => {
        this.broken = true
      })
      await this.client.connect(transport, { signal, timeout })
      signal.throwIfAborted()
    } finally {
      lease.signal.removeEventListener('abort', cancel)
    }
  }

  async healthy(signal: AbortSignal): Promise<boolean> {
    if (this.closed || this.broken) return false
    try {
      await this.client.ping({ signal, timeout: REUSE_PING_TIMEOUT_MS })
      return !this.closed && !this.broken
    } catch (error) {
      if (signal.aborted) throw error
      return false
    }
  }

  async listTools(
    params: ListToolsRequest['params'],
    options: RequestOptions,
  ): Promise<ListToolsResult> {
    const cacheable =
      this.stdio &&
      this.client.getServerCapabilities()?.tools?.listChanged === true &&
      params?.cursor === undefined
    if (cacheable && this.toolList) return this.toolList
    const generation = this.toolGeneration
    const listed = await this.client.listTools(params, options)
    if (cacheable && listed.nextCursor === undefined && generation === this.toolGeneration)
      this.toolList = listed
    return listed
  }

  close(): Promise<void> {
    // SDK transport 的第二次 close 会立即返回；必须复用首次关闭的完成屏障。
    if (!this.closing) {
      this.closed = true
      this.closing = this.client.close().finally(() => this.lifetime.abort())
    }
    return this.closing
  }
}

function mcpTransport(
  config: Record<string, any>,
  cwd: string,
  signal: AbortSignal,
  source: string,
  name: string,
  onAuthFailure: () => void,
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
      if (error instanceof OAuthLoginRequired) {
        oauthFailure = error
        onAuthFailure()
      }
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

export interface McpPoolLimits {
  // 没人用的连接留多久，0 表示不复用（每个 CLI 进程收场时关掉，和以前一样）
  idleMs: number
  // 最多留几条没人用的连接，超出时先关最久没用的；0 也表示不复用
  maxIdle: number
}

const DEFAULT_IDLE_MINUTES = 10
const DEFAULT_MAX_IDLE = 8
// setTimeout 最多等 2^31-1 毫秒（约 24.8 天），再长会溢出成立即触发
const MAX_IDLE_MS = 2_147_483_647

export function mcpPoolLimits(env: NodeJS.ProcessEnv = process.env): McpPoolLimits {
  const number = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw.trim() === '') return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return {
    idleMs: Math.min(
      number(env.CHA_CLAUDE_MCP_IDLE_MINUTES, DEFAULT_IDLE_MINUTES) * 60_000,
      MAX_IDLE_MS,
    ),
    maxIdle: Math.floor(number(env.CHA_CLAUDE_MCP_IDLE_CONNECTIONS, DEFAULT_MAX_IDLE)),
  }
}

interface Slot {
  thread: string
  connection: McpConnection
  // 被某个进程拿走了（租用中、或拿走后正在 ping）
  taken: boolean
  idleSince: number
  timer: ReturnType<typeof setTimeout> | null
}

// 一格只放一条连接。同一线程同一时刻只有一个 CLI 进程，所以一格不会被两个进程同时要；
// 真碰上（格子被占着）时后来的那条现连现关，不进池。
export class NativeMcpPool {
  private readonly limits: McpPoolLimits
  private readonly slots = new Map<string, Slot>()
  // closeThread 之后的线程：它还在连的、还在用的连接都不进池，直到这个线程下一次准备连接（reopen）。
  // 不然线程正在起进程时被关，连好的连接会落进一个已经关掉的线程的格子里，等到空闲超时才关。
  private readonly closedThreads = new Set<string>()
  private closed = false

  constructor(limits: McpPoolLimits = mcpPoolLimits()) {
    this.limits = limits
  }

  get enabled(): boolean {
    return !this.closed && this.limits.idleMs > 0 && this.limits.maxIdle > 0
  }

  // 拿一条配置对得上、没人用的连接；拿到的要么 adopt 回来（复用失败时由 release 关掉），要么 release。
  take(thread: string, name: string, fingerprint: string): McpConnection | null {
    if (this.closedThreads.has(thread)) return null
    const key = slotKey(thread, name)
    const slot = this.slots.get(key)
    if (!slot || slot.taken) return null
    if (
      slot.connection.fingerprint !== fingerprint ||
      slot.connection.closed ||
      slot.connection.broken
    ) {
      void this.drop(key, slot)
      return null
    }
    this.clearTimer(slot)
    slot.taken = true
    return slot.connection
  }

  // 新连上的连接放进格子，用完 release 时才可能留下。
  adopt(thread: string, name: string, connection: McpConnection): void {
    if (!this.enabled || connection.closed || this.closedThreads.has(thread)) return
    const key = slotKey(thread, name)
    const previous = this.slots.get(key)
    if (previous?.connection === connection) return
    if (previous) {
      if (previous.taken) return
      void this.drop(key, previous)
    }
    const slot: Slot = { thread, connection, taken: true, idleSince: 0, timer: null }
    this.slots.set(key, slot)
    connection.onclose = () => {
      if (this.slots.get(key) === slot) this.forget(key, slot)
    }
  }

  // 进程用完：还能用的放回去等下一个回合，否则关掉。
  release(connection: McpConnection, reusable: boolean): Promise<void> {
    const entry = this.find(connection)
    if (!entry) return connection.close()
    const [key, slot] = entry
    if (!reusable || !this.enabled || connection.closed) return this.drop(key, slot)
    slot.taken = false
    slot.idleSince = Date.now()
    slot.timer = setTimeout(() => {
      slot.timer = null
      if (this.slots.get(key) === slot && !slot.taken) void this.drop(key, slot)
    }, this.limits.idleMs)
    slot.timer.unref()
    this.evict()
    return Promise.resolve()
  }

  // 线程又要用连接了（新的 CLI 进程开始准备），撤掉 closeThread 留下的标记。
  reopen(thread: string): void {
    this.closedThreads.delete(thread)
  }

  // 线程的服务配置里已经没有的那几个，空闲着的直接关掉。
  retain(thread: string, names: ReadonlySet<string>): void {
    for (const [key, slot] of this.slots)
      if (slot.thread === thread && !slot.taken && !names.has(slot.connection.name))
        void this.drop(key, slot)
  }

  // 线程不再用了（归档、删除、卸载、回退、客户端都断开）：空闲的现在关，正被用的用完就关。
  closeThread(thread: string): Promise<void> {
    this.closedThreads.add(thread)
    const pending: Promise<void>[] = []
    for (const [key, slot] of this.slots) {
      if (slot.thread !== thread) continue
      if (slot.taken) this.forget(key, slot)
      else pending.push(this.drop(key, slot))
    }
    return Promise.all(pending).then(() => {})
  }

  // 客户端全都断开了：没人用的连接现在就关；正被用的照旧跟着它的进程走，用完就关、不再回池
  // （断开时回合常常刚结束、CLI 进程还在收场，连接还没放回来）。
  closeIdle(): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [key, slot] of this.slots) {
      if (slot.taken) this.forget(key, slot)
      else pending.push(this.drop(key, slot))
    }
    return Promise.all(pending).then(() => {})
  }

  async close(): Promise<void> {
    this.closed = true
    const slots = [...this.slots]
    await Promise.all(slots.map(([key, slot]) => this.drop(key, slot)))
  }

  // 只给测试看：现在池里有几条、各自有没有被拿走
  snapshot(): Array<{ thread: string; name: string; taken: boolean }> {
    return [...this.slots.values()].map((slot) => ({
      thread: slot.thread,
      name: slot.connection.name,
      taken: slot.taken,
    }))
  }

  private evict(): void {
    const idle = [...this.slots].filter(([, slot]) => !slot.taken)
    idle.sort(([, a], [, b]) => a.idleSince - b.idleSince)
    for (const [key, slot] of idle.slice(0, Math.max(0, idle.length - this.limits.maxIdle)))
      void this.drop(key, slot)
  }

  private find(connection: McpConnection): [string, Slot] | null {
    for (const entry of this.slots) if (entry[1].connection === connection) return entry
    return null
  }

  private forget(key: string, slot: Slot): void {
    this.clearTimer(slot)
    if (this.slots.get(key) === slot) this.slots.delete(key)
    if (slot.connection.onclose) slot.connection.onclose = null
  }

  private drop(key: string, slot: Slot): Promise<void> {
    this.forget(key, slot)
    return slot.connection.close().catch(() => {})
  }

  private clearTimer(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
  }
}

function slotKey(thread: string, name: string): string {
  return `${thread}\u0000${name}`
}
