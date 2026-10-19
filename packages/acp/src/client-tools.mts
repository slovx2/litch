// 动态工具（thread/start.dynamicTools），含客户端工具（clientTools 扩展，protocol/extensions/client-tools.json）。
//
// 怎么交给 ACP agent：ACP 的 session/new、session/load、session/resume、session/fork 都带 mcpServers，规范要求
// 每个 agent 都接得住 stdio 的那种。带了动态工具的会话，适配器每次建会话、接回会话时挂一个名叫 litch 的
// stdio MCP 服务：命令是当前的 node 跑本包的 mcp-bridge.mjs，它只是一根管子，经本地套接字（Windows 上是
// 命名管道）接回这个 ACP 入口进程，MCP 本身在这里答（initialize、tools/list、tools/call）。没用 http：
// stdio 是每个 agent 都有的，http 要 agent 声明了才行，而且要在本机多开一个端口。
//
// 模型调用时 agent 经 MCP 的 tools/call 找到这里：照 client-tools.json 挑执行方（发起回合的连接，否则最早订阅的
// 声明了的连接，都没有当场回 noExecutor），向它发标准的 item/tool/call，答复转成 MCP 的结果交回 agent。
// 对话里的条目照别的入口画成 dynamicToolCall，条目号就是 item/tool/call 的 callId（设备进程把它记成提案的
// callId）。agent 自己也会为这次调用报 tool_call（标题、大类各家不一样），能认出来的那一条就是这次调用的条目，
// 认不出的另起一条（projection.mts 的 claimDynamic、addDynamic）。
//
// 命名空间的 instructions（挂上时要进系统提示的规矩）放在 MCP initialize 应答的 instructions 里，
// 读不读看 agent（Gemini CLI 读，拼在它的记忆末尾）。
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import {
  clientToolNamespaces,
  isClientToolNamespace,
  noClientToolExecutor,
  pickClientToolExecutor,
} from '../../shared/src/client-tool-executor.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import type { LiveThread } from './server.mjs'

/** 一个动态工具：MCP 里叫 mcpName，agent 多半再拼上服务名（Gemini、OpenCode 给模型的是 litch_<mcpName>） */
export interface DynamicToolSpec {
  mcpName: string
  namespace: string | null
  tool: string
  description: string
  inputSchema: Record<string, unknown>
}

/** 挂给 agent 的 MCP 服务名。只有一个：每个会话的服务是分开起的，名字不用分 */
export const MCP_SERVER_NAME = 'litch'
/** 交给桥的口令放在这个环境变量里 */
export const BRIDGE_TOKEN_ENV = 'LITCH_ACP_MCP_TOKEN'

// 工具名只用字母数字下划线连字符（MCP 和各家模型接口都认的）；最长 40 个字，服务名拼上之后也在 64 以内。
// 超了或者撞了就用摘要。和 OpenCode 入口一样：命名空间去掉 litch_ 前缀，再接工具名。
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
 * 各命名空间的 instructions，按出现的先后用空行隔开，每段前一行 `# Tool instructions: <命名空间>`
 * （和别家入口同一种格式），同一段只放一次；一个都没有是空串
 */
export function toolInstructions(raw: unknown): string {
  if (!Array.isArray(raw)) return ''
  const sections: string[] = []
  for (const value of raw as any[]) {
    if (value?.type !== 'namespace' || typeof value.instructions !== 'string') continue
    const text = value.instructions.trim()
    const section = text ? `# Tool instructions: ${String(value.name)}\n${text}` : ''
    if (section && !sections.includes(section)) sections.push(section)
  }
  return sections.join('\n\n')
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * agent 报的一次工具调用（tool_call，或权限请求里带的 toolCall）是不是这个会话的动态工具。ACP 不给工具名，
 * 只能看标题：各家把 MCP 工具写成“litch_<工具>”（OpenCode 等，和模型看到的名字一样）、
 * “<工具> (litch MCP Server)”（Gemini CLI、Qwen Code）、“mcp_litch_<工具>”“mcp__litch__<工具>”这几种。
 * 认不出的（比如 Gemini CLI 在参数里有 command 时把命令当标题）按普通工具画，调用进来时再认领（claimDynamic）。
 */
export function matchDynamicTool(
  specs: readonly DynamicToolSpec[],
  toolCall: any,
): DynamicToolSpec | null {
  const title = typeof toolCall?.title === 'string' ? toolCall.title : ''
  if (!title.includes(MCP_SERVER_NAME)) return null
  const server = escapeRegExp(MCP_SERVER_NAME)
  for (const spec of specs) {
    const name = escapeRegExp(spec.mcpName)
    const pattern = new RegExp(
      `(?:^|[^A-Za-z0-9_-])(?:(?:mcp_{1,2})?${server}(?:__|_|\\.|/|:)${name}(?![A-Za-z0-9_-])|${name} \\(${server}\\b)`,
    )
    if (pattern.test(title)) return spec
  }
  return null
}

/** 键排序后的 JSON：agent 报的原始参数和 MCP 调用带来的参数对得上就是同一次调用 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as any)[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** 执行方的答复（标准的 item/tool/call 应答）核对一遍；图片只能是 data: 地址 */
export function toolResponse(value: unknown): ClientToolCallResponse {
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

/** 转成 MCP 的工具结果。失败说明一定在文字里（有的 agent 失败时只取文字给模型） */
export function mcpResult(response: ClientToolCallResponse) {
  return {
    isError: !response.success,
    content: response.contentItems.map((item) => {
      if (item.type === 'inputText') return { type: 'text', text: item.text }
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(item.imageUrl)
      return { type: 'image', mimeType: match?.[1] ?? 'image/png', data: match?.[2] ?? '' }
    }),
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

/** 桥的程序：和入口在同一个目录（构建产物里是 dist/acp/src/mcp-bridge.mjs） */
const BRIDGE_SCRIPT = fileURLToPath(new URL('./mcp-bridge.mjs', import.meta.url))
/** MCP 调用进来时等 agent 报出对应的 tool_call 最多等多久；等不到就另起一个条目 */
const CLAIM_MS = 2000
/** 调用跑着时多久给 agent 报一次进度：MCP 客户端多半按两次消息之间的间隔算超时 */
const PROGRESS_MS = 15000

/** ACP 的一个 stdio MCP 服务（session/new 等的 mcpServers 的一项） */
export interface StdioMcpServer {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

/** 一个桥：挂给某个会话的那份工具。新建、分叉时会话号要等 agent 应答了才知道，先是 null */
interface Bridge {
  threadId: string | null
  specs: DynamicToolSpec[]
  instructions: string
}

/** AcpServer 给这里用的那几样 */
export interface ClientToolsHost {
  readonly store: {
    getMeta(scope: string, id: string): any
    setMeta(scope: string, id: string, data: unknown): void
  }
  readonly peers: Map<string, RpcPeer>
  readonly live: Map<string, LiveThread>
  subscribers(threadId: string): RpcPeer[]
  notify(threadId: string, method: string, params: any): void
  /** 向客户端发请求等它答（不补送给后来订阅的连接）；signal 中止时撤回 */
  askClient(
    targets: RpcPeer[],
    threadId: string,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<any>
}

export class ClientTools {
  private readonly host: ClientToolsHost
  /** 每条连接握手时声明能执行的客户端工具命名空间：连接标识 → 命名空间 */
  private readonly declared = new Map<string, ReadonlySet<string>>()
  private readonly cache = new Map<string, DynamicToolSpec[]>()
  private readonly bridges = new Map<string, Bridge>()
  /** 会话号 → 它的桥的标识：接回会话时用同一个，桥的个数不随接回的次数涨 */
  private readonly keys = new Map<string, string>()
  /** 等 agent 报 tool_call 的调用：有新的工具条目时叫醒它们去认领 */
  private readonly waiters = new Set<() => void>()
  private readonly sockets = new Set<Socket>()
  private readonly secret = randomBytes(24).toString('base64url')
  private server: Server | null = null
  private listening: Promise<string> | null = null
  private directory: string | null = null

  constructor(host: ClientToolsHost) {
    this.host = host
  }

  /** initialize：记下这条连接能执行的命名空间 */
  declare(peer: RpcPeer, params: unknown): void {
    this.declared.set(peer.id, clientToolNamespaces(params))
  }

  drop(peerId: string): void {
    this.declared.delete(peerId)
  }

  /** thread/start 带来的动态工具记到会话上（适配器重启、会话接回后还在）；不合规矩的抛错 */
  remember(threadId: string, raw: unknown): void {
    const specs = dynamicToolSpecs(raw)
    if (!specs.length) return
    this.host.store.setMeta('dynamicTools', threadId, raw)
    this.cache.set(threadId, specs)
  }

  /** 会话记着的那份原样的 dynamicTools；没有是 null */
  raw(threadId: string): unknown {
    return this.host.store.getMeta('dynamicTools', threadId)
  }

  specs(threadId: string): DynamicToolSpec[] {
    const cached = this.cache.get(threadId)
    if (cached) return cached
    const raw = this.raw(threadId)
    let specs: DynamicToolSpec[] = []
    try {
      specs = raw ? dynamicToolSpecs(raw) : []
    } catch {}
    this.cache.set(threadId, specs)
    return specs
  }

  /** agent 报的这次工具调用是不是这个会话的动态工具（看标题，见 matchDynamicTool） */
  detect(threadId: string, toolCall: unknown): DynamicToolSpec | null {
    const specs = this.specs(threadId)
    return specs.length ? matchDynamicTool(specs, toolCall) : null
  }

  /** 有新的工具条目了：等着认领的调用再找一遍 */
  wake(): void {
    for (const wake of [...this.waiters]) wake()
  }

  /**
   * 给一次 session/new、load、resume、fork 准备 mcpServers：raw 是要挂的动态工具（没有就是空的，不挂）。
   * 会话号已知的（接回）直接记上；不知道的（新建、分叉）返回桥的标识，agent 应答之后用 bind 补上。
   */
  async mount(
    threadId: string | null,
    raw: unknown,
  ): Promise<{ servers: StdioMcpServer[]; key: string | null }> {
    const specs = dynamicToolSpecs(raw)
    if (!specs.length) return { servers: [], key: null }
    const path = await this.listen()
    const key = (threadId && this.keys.get(threadId)) || randomUUID()
    this.bridges.set(key, { threadId, specs, instructions: toolInstructions(raw) })
    if (threadId) this.keys.set(threadId, key)
    return {
      key,
      servers: [
        {
          name: MCP_SERVER_NAME,
          command: process.execPath,
          args: [BRIDGE_SCRIPT, path, key],
          env: [{ name: BRIDGE_TOKEN_ENV, value: this.secret }],
        },
      ],
    }
  }

  /** agent 应答了：桥记上会话号。会话没建成（threadId 是 null）的桥作废 */
  bind(key: string | null, threadId: string | null): void {
    if (!key) return
    const bridge = this.bridges.get(key)
    if (!bridge) return
    if (!threadId) {
      this.bridges.delete(key)
      return
    }
    bridge.threadId = threadId
    this.keys.set(threadId, key)
  }

  // 第一次要挂桥时才开监听。套接字放在临时目录下新建的、只有自己能进的目录里（macOS 的套接字路径
  // 不能超过 104 个字节，状态目录可能很长）；Windows 用命名管道，靠口令挡住别人
  private listen(): Promise<string> {
    this.listening ??= new Promise<string>((resolve, reject) => {
      let path: string
      if (process.platform === 'win32') path = `\\\\.\\pipe\\litch-acp-${randomUUID()}`
      else {
        this.directory = mkdtempSync(join(tmpdir(), 'litch-acp-'))
        path = join(this.directory, 'mcp.sock')
      }
      const server = createServer((socket) => this.accept(socket))
      server.once('error', reject)
      server.listen(path, () => {
        this.server = server
        resolve(path)
      })
    }).catch((error) => {
      this.listening = null
      throw error
    })
    return this.listening
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    this.listening = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
    this.directory = null
  }

  // —— 一个桥连上来：头一行是 { key, token }，之后是一行一条的 MCP 消息 ——

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    // 这条桥上还没答完的 tools/call：请求号 → 取消
    const calls = new Map<string, AbortController>()
    let bridge: Bridge | null = null
    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
    }
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.sockets.delete(socket)
      for (const controller of calls.values()) controller.abort()
      calls.clear()
    })
    lines.on('line', (line) => {
      if (!line.trim()) return
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        if (bridge) send(rpcError(null, -32700, '不是 JSON'))
        else socket.destroy()
        return
      }
      if (!bridge) {
        const found = this.bridges.get(String(message?.key ?? ''))
        if (message?.token !== this.secret || !found) socket.destroy()
        else bridge = found
        return
      }
      for (const one of Array.isArray(message) ? message : [message])
        this.handle(bridge, one, send, calls)
    })
  }

  private handle(
    bridge: Bridge,
    message: any,
    send: (message: unknown) => void,
    calls: Map<string, AbortController>,
  ): void {
    if (message?.method === 'notifications/cancelled') {
      calls.get(String(message.params?.requestId))?.abort()
      return
    }
    // 别的通知（notifications/initialized 这些）、对面答我们的（我们不发请求）都不用管
    if (message?.id === undefined || typeof message?.method !== 'string') return
    const ok = (result: unknown) => send({ jsonrpc: '2.0', id: message.id, result })
    switch (message.method) {
      case 'initialize':
        ok({
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: 'Litch', version: '1.0.0' },
          ...(bridge.instructions ? { instructions: bridge.instructions } : {}),
        })
        return
      case 'ping':
        ok({})
        return
      case 'tools/list':
        ok({
          tools: bridge.specs.map((spec) => ({
            name: spec.mcpName,
            description: spec.description,
            inputSchema: spec.inputSchema,
          })),
        })
        return
      case 'tools/call':
        void this.toolsCall(bridge, message, send, calls)
        return
      default:
        send(rpcError(message.id, -32601, `不支持 ${message.method}`))
    }
  }

  private async toolsCall(
    bridge: Bridge,
    message: any,
    send: (message: unknown) => void,
    calls: Map<string, AbortController>,
  ): Promise<void> {
    const name = String(message.params?.name ?? '')
    const spec = bridge.specs.find((entry) => entry.mcpName === name)
    if (!spec) {
      send(rpcError(message.id, -32602, `没有这个工具: ${name}`))
      return
    }
    if (!bridge.threadId) {
      send(rpcError(message.id, -32603, '会话还没建好，稍后再试'))
      return
    }
    const key = String(message.id)
    const controller = new AbortController()
    calls.set(key, controller)
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
      const args = message.params?.arguments ?? {}
      const response = await this.call(bridge.threadId, spec, args, controller.signal)
      send({ jsonrpc: '2.0', id: message.id, result: mcpResult(response) })
    } catch (error) {
      send(rpcError(message.id, -32603, (error as Error).message))
    } finally {
      if (timer) clearInterval(timer)
      calls.delete(key)
    }
  }

  // agent 为这次调用报的 tool_call：有的在调用之前报（Gemini CLI 先报再执行），有的晚一点，等一会儿
  private async claim(live: LiveThread, spec: DynamicToolSpec, args: unknown): Promise<any | null> {
    const threadId = live.projection.thread.id
    const notify = (method: string, params: any) => this.host.notify(threadId, method, params)
    const deadline = Date.now() + CLAIM_MS
    for (;;) {
      const item = live.projection.claimDynamic(spec, args, notify)
      if (item || !live.projection.active) return item
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

  /** 模型调了一个动态工具：交给执行方，等它答。条目在这里收尾 */
  private async call(
    threadId: string,
    spec: DynamicToolSpec,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ClientToolCallResponse> {
    const live = this.host.live.get(threadId)
    if (!live) throw new Error('会话没有在这个入口上打开')
    const { projection } = live
    const notify = (method: string, params: any) => this.host.notify(threadId, method, params)
    const startedMs = Date.now()
    const item = (await this.claim(live, spec, args)) ?? projection.addDynamic(spec, args, notify)
    const callId = item?.id ?? `call_${randomUUID()}`
    const turnId = projection.active?.id ?? ''
    const response = await this.deliver(live, spec, args, callId, turnId, signal)
    if (item) projection.finishDynamic(item, response, Date.now() - startedMs, notify)
    return response
  }

  private async deliver(
    live: LiveThread,
    spec: DynamicToolSpec,
    args: unknown,
    callId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<ClientToolCallResponse> {
    const threadId = live.projection.thread.id
    const starter =
      live.starter && live.starter.turnId === turnId
        ? (this.host.peers.get(live.starter.peerId) ?? null)
        : null
    const subscribers = this.host.subscribers(threadId)
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
      const answer = await this.host.askClient(
        targets,
        threadId,
        'item/tool/call',
        { threadId, turnId, callId, namespace: spec.namespace, tool: spec.tool, arguments: args },
        signal,
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
