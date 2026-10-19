import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import {
  clientToolNamespaces,
  isClientToolNamespace,
  noClientToolExecutor,
  pickClientToolExecutor,
} from '../../shared/src/client-tool-executor.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import type { OpencodeApi } from './api.mjs'
import type { LiveThread, OpencodeServer } from './server.mjs'

// 动态工具（thread/start.dynamicTools），含客户端工具（clientTools 扩展，protocol/extensions/client-tools.json）。
//
// 怎么交给 OpenCode 的模型：适配器自己开一个回环上的 MCP 服务（Streamable HTTP，只认适配器生成的口令），
// 每个带了动态工具的会话一个地址（/mcp/<会话号>），用 OpenCode 的 POST /mcp 按会话所在的目录挂上去，
// 服务名 litch_<会话号的摘要>。OpenCode 的 MCP 是按目录实例的，同一目录下的会话都看得到所有挂上的服务，
// 所以每次发消息都带上权限规则（消息的 tools 会整个替换会话的规则）：先禁掉所有 litch_ 开头的工具，
// 再放开自己这个服务的。子代理的会话只继承禁止的规则，看不到这些工具。
// 没有用 OpenCode 插件的 tool()：插件的工具在目录实例建起来时就定了，不能按会话不同，
// 而 litch_machine、litch_computer 的说明是按会话（所在设备、桌面平台）生成的。
//
// 命名空间带的 instructions（挂上时要加进系统提示的规则）放在这个 MCP 服务 initialize 应答的 instructions 里：
// OpenCode 把连着的 MCP 服务的说明拼进系统提示（<mcp_instructions>，在用户的 AGENTS.md 之后），只拼会话的权限规则
// 没把它的工具全禁掉的那些，所以只有这个会话看得到自己的（发命令开的回合也一样）；子代理的会话看不到。
//
// 模型调用时 OpenCode 经 MCP 的 tools/call 找到这里：照 client-tools.json 挑执行方（发起回合的连接，
// 否则最早订阅的声明了的连接，都没有当场回 noExecutor），向它发标准的 item/tool/call，答复转成 MCP 的结果
// （图片成为 OpenCode 的附件，交给模型）。MCP 工具 OpenCode 要先问权限：放开的那条规则是“允许”，
// 所以不经 OpenCode 自己的审批，要不要问用户由执行方定。执行方断开、回合停止都按失败结束，不改交给别人。

/** 一个动态工具：模型看到的名字是 `<服务名>_<mcpName>` */
export interface DynamicToolSpec {
  /** MCP 里的工具名（不带服务名） */
  mcpName: string
  namespace: string | null
  tool: string
  description: string
  inputSchema: Record<string, unknown>
}

/** 所有会话的服务名都以它开头；权限规则按它禁掉别的会话的 */
export const SERVER_PREFIX = 'litch_'
const SERVER_PATTERN = /^litch_[0-9a-f]{10}_/

/** 会话的 MCP 服务名。按会话号算，适配器重启后还是这个名字（再挂一次就替换掉旧的） */
export function serverName(threadId: string): string {
  return `${SERVER_PREFIX}${createHash('sha256').update(threadId).digest('hex').slice(0, 10)}`
}

// OpenCode 把 MCP 工具名拼成“服务名_工具名”交给模型，不合 [a-zA-Z0-9_-] 的字符换成下划线；
// 有的提供方限工具名 64 个字符，服务名占了 17 个，这里的名字最多 40 个，超了或者撞了就用摘要。
const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')
const MAX_NAME = 40

/** 交给模型的说明：标出是哪个命名空间的哪个工具，命名空间的说明接在它第一个工具前面（同 Claude、Pi 入口） */
const describe = (namespace: string | null, tool: string, about: string, text: string) =>
  `[${namespace ?? 'functions'}.${tool}] ${about ? `${about}\n\n` : ''}${text}`

/** 校验并摊平 thread/start.dynamicTools（function 和 namespace 两种）；不合规矩的抛参数错误 */
export function dynamicToolSpecs(raw: unknown): DynamicToolSpec[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new ProtocolError(-32602, 'dynamicTools 必须是数组')
  const flat: Array<Omit<DynamicToolSpec, 'mcpName'>> = []
  const add = (value: any, namespace: string | null, about: string) => {
    if (value?.type !== 'function') throw new ProtocolError(-32602, '动态工具必须是 function')
    const tool = requiredString(value.name, 'tool.name')
    if (!value.inputSchema || typeof value.inputSchema !== 'object')
      throw new ProtocolError(-32602, '动态工具缺少 inputSchema')
    const text = typeof value.description === 'string' ? value.description : ''
    flat.push({
      namespace,
      tool,
      description: describe(namespace, tool, about, text),
      inputSchema: value.inputSchema,
    })
  }
  for (const value of raw as any[]) {
    if (value?.type === 'function') add(value, null, '')
    else if (value?.type === 'namespace' && Array.isArray(value.tools)) {
      const namespace = requiredString(value.name, 'namespace.name')
      const about = typeof value.description === 'string' ? value.description.trim() : ''
      value.tools.forEach((tool: any, index: number) => {
        add(tool, namespace, index === 0 ? about : '')
      })
    } else throw new ProtocolError(-32602, '动态工具必须是 function 或 namespace')
  }
  const identities = new Set<string>()
  const names = new Set<string>()
  return flat.map((spec) => {
    const identity = JSON.stringify([spec.namespace, spec.tool])
    if (identities.has(identity)) throw new ProtocolError(-32602, '动态工具名称重复')
    identities.add(identity)
    const readable = sanitize(
      spec.namespace ? `${spec.namespace.replace(/^litch_/, '')}_${spec.tool}` : spec.tool,
    )
    const mcpName =
      readable.length <= MAX_NAME && !names.has(readable)
        ? readable
        : `t_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
    names.add(mcpName)
    return { ...spec, mcpName }
  })
}

/**
 * 命名空间带的 instructions：按出现的先后，同一段话只放一次；一段都没有是 null。形状在建会话时已经由
 * dynamicToolSpecs 核对过，这里只挑认得的
 */
export function toolInstructions(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null
  const sections: string[] = []
  const seen = new Set<string>()
  for (const spec of raw as any[]) {
    if (spec?.type !== 'namespace' || typeof spec.instructions !== 'string') continue
    const text = spec.instructions.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    sections.push(`# Tool instructions: ${String(spec.name)}\n${text}`)
  }
  return sections.length ? sections.join('\n\n') : null
}

/**
 * 发消息时 tools 里加的规则（OpenCode 照先后，最后一条对得上的算数）：别的会话挂的服务一律禁掉，
 * 再放开 allowed 这个会话的服务（有动态工具的会话传自己）。null 是只禁不放。
 */
export function toolRules(allowed: string | null): Record<string, boolean> {
  return {
    [`${SERVER_PREFIX}*`]: false,
    ...(allowed ? { [`${serverName(allowed)}_*`]: true } : {}),
  }
}

/** 同一份规则写成 OpenCode 会话的权限规则（建会话时直接带上，第一句话是命令时也生效） */
export function toolRuleset(rules: Record<string, boolean>) {
  return Object.entries(rules).map(([permission, allow]) => ({
    permission,
    pattern: '*',
    action: allow ? 'allow' : 'deny',
  }))
}

// 键排序后的 JSON：OpenCode 记下的参数和 MCP 调用带来的参数对得上就是同一次调用
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as any)[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

interface Running {
  itemId: string
  name: string
  input: string
  at: number
}

/** 等 OpenCode 的事件报出这次调用对应的工具部件最多等多久；等不到就另起一个调用号 */
const CLAIM_MS = 3000
/** 调用跑着时多久给 OpenCode 报一次进度：它的 MCP 客户端每次收到进度就重新计时，长的调用不会超时 */
const PROGRESS_MS = 15000
/** 挂 MCP 服务时给的超时：连上要多久、两次进度之间最多隔多久 */
const MCP_TIMEOUT_MS = 60000

export class ClientTools {
  private readonly server: OpencodeServer
  /** 每条连接握手时声明能执行的客户端工具命名空间：连接标识 → 命名空间 */
  private readonly declared = new Map<string, ReadonlySet<string>>()
  private readonly cache = new Map<string, DynamicToolSpec[]>()
  /** 已经开始跑、还没对上 MCP 调用的工具部件（按会话） */
  private readonly running = new Map<string, Running[]>()
  private readonly waiters = new Set<() => void>()
  /** 正在执行的 MCP 调用：会话号 + JSON-RPC 请求号 → 取消 */
  private readonly calls = new Map<string, AbortController>()
  private readonly secret = randomBytes(24).toString('base64url')
  private http: Server | null = null
  private listening: Promise<string> | null = null

  constructor(server: OpencodeServer) {
    this.server = server
  }

  /** initialize：记下这条连接能执行的命名空间 */
  declare(peer: RpcPeer, params: unknown): void {
    this.declared.set(peer.id, clientToolNamespaces(params))
  }

  drop(peerId: string): void {
    this.declared.delete(peerId)
  }

  /** thread/start 带来的动态工具记到会话上（适配器重启、会话恢复后还在）；先校验，不合规矩的抛错 */
  remember(threadId: string, raw: unknown): void {
    const specs = dynamicToolSpecs(raw)
    if (!specs.length) return
    this.server.store.setMeta('dynamicTools', threadId, raw)
    this.cache.set(threadId, specs)
  }

  /** 分叉出来的会话带着原会话的动态工具 */
  copy(from: string, to: string): void {
    const raw = this.server.store.getMeta('dynamicTools', from)
    if (raw) this.remember(to, raw)
  }

  specs(threadId: string): DynamicToolSpec[] {
    const cached = this.cache.get(threadId)
    if (cached) return cached
    const raw = this.server.store.getMeta('dynamicTools', threadId)
    let specs: DynamicToolSpec[] = []
    try {
      specs = raw ? dynamicToolSpecs(raw) : []
    } catch {}
    this.cache.set(threadId, specs)
    return specs
  }

  /**
   * OpenCode 的工具名（服务名_工具名）是不是这个会话的动态工具。服务名的摘要不看：分叉出来的会话里
   * 原会话的调用挂在原会话的服务名下，工具是同一份
   */
  lookup(threadId: string, name: string): DynamicToolSpec | null {
    if (!SERVER_PATTERN.test(name)) return null
    const mcpName = name.replace(SERVER_PATTERN, '')
    return this.specs(threadId).find((spec) => spec.mcpName === mcpName) ?? null
  }

  /** 这个会话发消息时 tools 里要加的规则 */
  rules(threadId: string): Record<string, boolean> {
    return toolRules(this.specs(threadId).length ? threadId : null)
  }

  /**
   * 发消息之前：这个会话有动态工具的话，确认它的 MCP 服务挂在会话所在的目录实例上，没挂（第一次、serve 重启过、
   * 目录实例被收拾过）就挂上。挂不上不拦着这一轮，模型只是看不到这些工具。
   */
  async ensure(api: OpencodeApi, live: LiveThread): Promise<void> {
    const threadId = live.projection.thread.id
    if (!this.specs(threadId).length) return
    const name = serverName(threadId)
    try {
      const status = await api.request('GET', '/mcp', {
        directory: live.directory,
        timeoutMs: 5000,
      })
      if (status?.[name]?.status === 'connected') return
      const url = await this.listen()
      const added = await api.request('POST', '/mcp', {
        directory: live.directory,
        timeoutMs: MCP_TIMEOUT_MS,
        body: {
          name,
          config: {
            type: 'remote',
            url: `${url}/mcp/${encodeURIComponent(threadId)}`,
            headers: { authorization: `Bearer ${this.secret}` },
            oauth: false,
            timeout: MCP_TIMEOUT_MS,
          },
        },
      })
      // 应答是各服务的状态（服务名 → { status }）
      if (added?.[name]?.status !== 'connected')
        throw new Error(`状态 ${JSON.stringify(added?.[name] ?? null)}`)
    } catch (error) {
      console.error(`[opencode] 会话 ${threadId} 的动态工具没有挂上: ${(error as Error).message}`)
    }
  }

  /** 投影里一个动态工具的部件开始跑了：记下来，MCP 调用进来时按它取调用号（就是条目号） */
  started(threadId: string, itemId: string, name: string, input: unknown): void {
    const now = Date.now()
    const list = (this.running.get(threadId) ?? []).filter((entry) => now - entry.at < 120_000)
    list.push({ itemId, name: name.replace(SERVER_PATTERN, ''), input: canonical(input), at: now })
    this.running.set(threadId, list)
    for (const wake of [...this.waiters]) wake()
  }

  // MCP 调用对应的工具部件：同一会话、同一工具、参数一样、还没被认领的最早那个。事件可能比调用晚到一点，等一会儿
  private async claim(threadId: string, name: string, args: unknown): Promise<string | null> {
    const input = canonical(args)
    const deadline = Date.now() + CLAIM_MS
    for (;;) {
      const list = this.running.get(threadId) ?? []
      const index = list.findIndex((entry) => entry.name === name && entry.input === input)
      if (index >= 0) return list.splice(index, 1)[0]?.itemId ?? null
      const left = deadline - Date.now()
      if (left <= 0) return null
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(wake, left)
        this.waiters.add(wake)
      })
    }
  }

  // 第一次要挂服务时才开监听，只听回环
  private listen(): Promise<string> {
    this.listening ??= new Promise<string>((resolve, reject) => {
      const http = createServer((request, response) => void this.serve(request, response))
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => {
        const address = http.address()
        if (!address || typeof address === 'string') return reject(new Error('MCP 服务没有地址'))
        this.http = http
        resolve(`http://127.0.0.1:${address.port}`)
      })
    }).catch((error) => {
      this.listening = null
      throw error
    })
    return this.listening
  }

  async close(): Promise<void> {
    for (const controller of this.calls.values()) controller.abort()
    const http = this.http
    this.http = null
    this.listening = null
    if (!http) return
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  // —— MCP 服务（Streamable HTTP，无状态：不发会话号，不开服务端推送的 GET 流）——

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([^/?]+)$/.exec(request.url ?? '')
    if (request.headers.authorization !== `Bearer ${this.secret}` || !match?.[1]) {
      response.writeHead(match ? 401 : 404).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end()
      return
    }
    const threadId = decodeURIComponent(match[1])
    let body: any
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(rpcError(null, -32700, '不是 JSON'))
      return
    }
    const messages: any[] = Array.isArray(body) ? body : [body]
    const requests = messages.filter((message) => message?.id !== undefined && message?.method)
    for (const message of messages)
      if (message?.method === 'notifications/cancelled')
        this.calls.get(`${threadId}\n${message.params?.requestId}`)?.abort()
    if (!requests.length) {
      response.writeHead(202).end()
      return
    }
    // 调工具要等执行方，回 SSE：跑着的时候报进度，OpenCode 那边不会超时
    const call = requests.length === 1 && requests[0].method === 'tools/call' ? requests[0] : null
    if (call) return this.streamCall(threadId, call, response)
    const replies = requests.map((message) => this.answer(threadId, message))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]))
  }

  private answer(threadId: string, message: any): unknown {
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result })
    switch (message.method) {
      case 'initialize': {
        const instructions = toolInstructions(this.server.store.getMeta('dynamicTools', threadId))
        return ok({
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'litch', version: '1.0.0' },
          ...(instructions ? { instructions } : {}),
        })
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({
          tools: this.specs(threadId).map((spec) => ({
            name: spec.mcpName,
            description: spec.description,
            inputSchema: spec.inputSchema,
          })),
        })
      default:
        return JSON.parse(rpcError(message.id, -32601, `不支持 ${message.method}`))
    }
  }

  private async streamCall(
    threadId: string,
    message: any,
    response: ServerResponse,
  ): Promise<void> {
    const key = `${threadId}\n${message.id}`
    const controller = new AbortController()
    this.calls.set(key, controller)
    response.on('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (payload: unknown) => {
      if (!response.writableEnded)
        response.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    const token = message.params?._meta?.progressToken
    let progress = 0
    const timer =
      token === undefined
        ? null
        : setInterval(
            () =>
              send({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: token, progress: ++progress },
              }),
            PROGRESS_MS,
          )
    try {
      const result = await this.call(
        threadId,
        String(message.params?.name ?? ''),
        message.params?.arguments ?? {},
        controller.signal,
      )
      send({ jsonrpc: '2.0', id: message.id, result: mcpResult(result) })
    } catch (error) {
      send(JSON.parse(rpcError(message.id, -32602, (error as Error).message)))
    } finally {
      if (timer) clearInterval(timer)
      this.calls.delete(key)
      response.end()
    }
  }

  /** 模型调了一个动态工具：交给执行方，等它答 */
  private async call(
    threadId: string,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ClientToolCallResponse> {
    const spec = this.specs(threadId).find((entry) => entry.mcpName === name)
    if (!spec) throw new Error(`没有这个工具: ${name}`)
    const live = await this.server.load(threadId)
    const callId = (await this.claim(threadId, name, args)) ?? `call_${randomUUID()}`
    const turnId = live.projection.active?.id ?? ''
    const starter =
      live.starter && live.starter.turnId === turnId
        ? (this.server.peers.get(live.starter.peerId) ?? null)
        : null
    const subscribers = this.server.subscribers(threadId)
    let targets: RpcPeer[]
    if (isClientToolNamespace(spec.namespace)) {
      // 客户端工具只交给声明了这个命名空间的连接，挑不出来当场失败，不交给别人
      const namespace = spec.namespace as string
      const executor = pickClientToolExecutor(
        namespace,
        starter,
        subscribers,
        (peer) => this.declared.get(peer.id) ?? new Set(),
      )
      if (!executor) return noClientToolExecutor(namespace)
      targets = [executor]
    } else {
      // 别的动态工具只交给一条连接：发起回合的还连着就给它，否则给最早订阅的那条
      const target = starter ?? subscribers[0]
      if (!target)
        return {
          success: false,
          contentItems: [
            { type: 'inputText', text: '没有连着能执行这个工具的客户端，这次调用没有执行。' },
          ],
        }
      targets = [target]
    }
    try {
      const answer = await this.server.requests.send(
        targets,
        threadId,
        'item/tool/call',
        () => ({
          threadId,
          turnId,
          callId,
          namespace: spec.namespace,
          tool: spec.tool,
          arguments: args,
        }),
        // 工具调用可能有副作用：只交给这一条，不补送给后来订阅的连接
        { signal, replayable: false },
      )
      return toolResponse(answer)
    } catch (error) {
      // 执行方断开、回合停止、答复不合格式：这次调用按失败结束，不改交给别的连接
      const message = (error as Error).message
      return isClientToolNamespace(spec.namespace)
        ? clientToolFailure(
            'failed',
            `这次调用没有完成（${message}）。不要原样重试；需要的话先告诉用户发生了什么。`,
          )
        : {
            success: false,
            contentItems: [{ type: 'inputText', text: `工具调用没有完成：${message}` }],
          }
    }
  }
}

/** 执行方的答复（标准的 item/tool/call 应答）核对一遍；图片只能是 data: 地址 */
function toolResponse(value: unknown): ClientToolCallResponse {
  const result = value as Partial<ClientToolCallResponse> | null
  if (!result || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems))
    throw new Error('客户端的答复不合格式')
  for (const item of result.contentItems) {
    if (item?.type === 'inputText' && typeof item.text === 'string') continue
    if (item?.type === 'inputImage' && /^data:[^;,]+;base64,/.test(String(item.imageUrl ?? '')))
      continue
    throw new Error('客户端的答复里有不支持的内容')
  }
  return { success: result.success, contentItems: result.contentItems }
}

/** 转成 MCP 的工具结果。失败的 OpenCode 只取文字给模型，所以失败说明一定在文字里 */
function mcpResult(response: ClientToolCallResponse) {
  return {
    isError: !response.success,
    content: response.contentItems.map((item) => {
      if (item.type === 'inputText') return { type: 'text', text: item.text }
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(item.imageUrl)
      return { type: 'image', mimeType: match?.[1] ?? 'image/png', data: match?.[2] ?? '' }
    }),
  }
}

const rpcError = (id: unknown, code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
