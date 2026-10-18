// 客户端工具（clientTools 扩展，protocol/extensions/client-tools.json）在 dsh 入口的做法。
//
// dsh 的 Web Remote 没有“动态工具”这回事，适配器也不改 dsh 本体：起 dsh 时用 --patch 插进一个我们自己的
// cordis 插件（plugin.mts，编译后是 dist/dsh/src/plugin.mjs）。插件在 dsh 进程里给每个会话（dsh 的 agent）
// 注册只对这个会话可见的工具（dsh 的 scoped 注册：agent.ctx.tools.register），模型调用时插件把调用交回适配器，
// 适配器照 client-tools.json 的规矩向客户端发标准的 item/tool/call，答复再交回插件、成为工具结果。
//
// 插件和适配器之间是一条回环 TCP 连接（127.0.0.1，端口和一次性令牌写在补丁文件里，补丁文件只有属主读得到）。
// 每行一个 JSON：
//   插件 → 适配器  hello {token}                      连上先报令牌，不对的直接断开
//                 tools {id, sessionId}              这个会话该有哪些工具（会话的 agent 建好时问，连上时把现有的都问一遍）
//                 call {id, sessionId, callId, name, arguments}   模型调了一个
//                 cancel {id}                        dsh 那边取消了这次调用（回合被打断）
//   适配器 → 插件  reply {id, ...}                    上面 tools、call 的应答
//                 install {id, sessionId, version, tools}  建会话时推过去（会话的 agent 在 session/create 时就建好了，
//                                                          那时问到的是空的）；插件装好回 ack {id}
// 工具清单带版本号：插件只认更新的那份，晚到的旧应答不会把刚推过去的盖掉。
import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { ClientToolCallResponse } from '../../protocol/src/client-tools.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'

/** 原生 codex 对命名空间说明的上限（超了它拒绝建会话），这里照样拒，免得在 dsh 上能建、换到原生 codex 就不行 */
export const NAMESPACE_DESCRIPTION_LIMIT = 1024

/** 交给 dsh 模型的一个工具 */
export interface DshClientTool {
  /** 模型看到的名字：`<命名空间>__<工具名>`，没有命名空间的是 `functions__<工具名>` */
  name: string
  namespace: string | null
  tool: string
  description: string
  parameters: Record<string, unknown>
}

// 上游模型接口对工具名的要求（Anthropic Messages、DeepSeek 都是这个）
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * thread/start.dynamicTools 摊平成一个个交给 dsh 模型的工具。命名空间的说明接在它第一个工具的说明前面
 * （和 Pi、Claude 入口一样：模型那边没有“命名空间”这一层）。形状不对的整份拒绝（-32602），不建会话。
 */
export function dshClientTools(raw: unknown): DshClientTool[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new ProtocolError(-32602, 'dynamicTools 必须是数组')
  const tools: DshClientTool[] = []
  const add = (spec: any, namespace: string | null, about: string) => {
    if (spec?.type !== 'function') throw new ProtocolError(-32602, '动态工具必须是 function')
    const tool = requiredString(spec.name, 'tool.name')
    if (
      !spec.inputSchema ||
      typeof spec.inputSchema !== 'object' ||
      Array.isArray(spec.inputSchema)
    )
      throw new ProtocolError(-32602, `动态工具 ${tool} 缺少 inputSchema`)
    const name = `${namespace ?? 'functions'}__${tool}`
    if (!TOOL_NAME.test(name))
      throw new ProtocolError(-32602, `动态工具名 ${name} 只能用字母、数字、_ 和 -，最长 64 个字`)
    if (tools.some((one) => one.name === name))
      throw new ProtocolError(-32602, `动态工具名称重复：${name}`)
    const description = typeof spec.description === 'string' ? spec.description : ''
    tools.push({
      name,
      namespace,
      tool,
      description: `[${namespace ?? 'functions'}.${tool}] ${about ? `${about}\n\n` : ''}${description}`,
      parameters: spec.inputSchema,
    })
  }
  for (const spec of raw as any[]) {
    if (spec?.type === 'function') add(spec, null, '')
    else if (spec?.type === 'namespace' && Array.isArray(spec.tools)) {
      const namespace = requiredString(spec.name, 'namespace.name')
      const about = typeof spec.description === 'string' ? spec.description.trim() : ''
      if (about.length > NAMESPACE_DESCRIPTION_LIMIT)
        throw new ProtocolError(
          -32602,
          `命名空间 ${namespace} 的说明超过 ${NAMESPACE_DESCRIPTION_LIMIT} 个字`,
        )
      spec.tools.forEach((tool: unknown, index: number) => {
        add(tool, namespace, index ? '' : about)
      })
    } else throw new ProtocolError(-32602, '动态工具必须是 function 或 namespace')
  }
  return tools
}

/** 插件文件的位置（构建产物里和本文件在同一目录） */
export const PLUGIN_PATH = fileURLToPath(new URL('./plugin.mjs', import.meta.url))

export interface BridgeHandlers {
  /** 这个会话现在该有的工具 */
  tools(sessionId: string): DshClientTool[]
  /** 模型调了一个工具。signal 在 dsh 那边取消时中止 */
  call(
    sessionId: string,
    callId: string,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ClientToolCallResponse>
}

// 推过去等插件回 ack 的上限：插件卡住了也不让建会话一直挂着（装不上的，插件下次问的时候还会装）
const INSTALL_TIMEOUT_MS = 5000

export class ClientToolBridge {
  private readonly handlers: BridgeHandlers
  private readonly token = randomBytes(24).toString('hex')
  private server: Server | null = null
  private listening: Promise<number> | null = null
  // 现在连着的插件（dsh 重启后是新的一条）
  private socket: Socket | null = null
  // 每个会话的工具清单的版本，改一次加一（见文件开头）
  private readonly versions = new Map<string, number>()
  private version = 0
  private readonly calls = new Map<string, AbortController>()
  private readonly acks = new Map<string, () => void>()
  private next = 0

  constructor(handlers: BridgeHandlers) {
    this.handlers = handlers
  }

  /** 插进 dsh 补丁文件的那一段（YAML；路径、令牌按 JSON 字符串写，YAML 认） */
  async patch(): Promise<string> {
    const port = await this.listen()
    const config = { host: '127.0.0.1', port, token: this.token }
    return [
      '- insert:',
      '    - id: litch-client-tools',
      `      name: ${JSON.stringify(PLUGIN_PATH)}`,
      `      config: ${JSON.stringify(config)}`,
      '',
    ].join('\n')
  }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket))
      this.server = server
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    return this.listening
  }

  /** 会话的工具变了（建会话时）：推给插件，等它装好。没连着就不推，插件连上时会问 */
  async install(sessionId: string): Promise<void> {
    const version = ++this.version
    this.versions.set(sessionId, version)
    const socket = this.socket
    if (!socket) return
    const id = `install-${++this.next}`
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(id)
        resolve()
      }, INSTALL_TIMEOUT_MS)
      this.acks.set(id, () => {
        clearTimeout(timer)
        this.acks.delete(id)
        resolve()
      })
      this.send(socket, {
        type: 'install',
        id,
        sessionId,
        version,
        tools: this.handlers.tools(sessionId),
      })
    })
  }

  private accept(socket: Socket): void {
    let buffer = ''
    let trusted = false
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      for (const controller of this.calls.values()) controller.abort()
      this.calls.clear()
      for (const ack of [...this.acks.values()]) ack()
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          socket.destroy()
          return
        }
        if (!trusted) {
          if (message?.type !== 'hello' || message.token !== this.token) {
            socket.destroy()
            return
          }
          trusted = true
          this.socket?.destroy()
          this.socket = socket
          continue
        }
        this.receive(socket, message)
      }
    })
  }

  private receive(socket: Socket, message: any): void {
    if (message.type === 'tools') {
      const sessionId = String(message.sessionId)
      this.send(socket, {
        type: 'reply',
        id: message.id,
        version: this.versions.get(sessionId) ?? 0,
        tools: this.handlers.tools(sessionId),
      })
    } else if (message.type === 'ack') this.acks.get(String(message.id))?.()
    else if (message.type === 'cancel') this.calls.get(String(message.id))?.abort()
    else if (message.type === 'call') void this.call(socket, message)
  }

  private async call(socket: Socket, message: any): Promise<void> {
    const id = String(message.id)
    const controller = new AbortController()
    this.calls.set(id, controller)
    let reply: Record<string, unknown>
    try {
      const result = await this.handlers.call(
        String(message.sessionId),
        String(message.callId),
        String(message.name),
        message.arguments,
        controller.signal,
      )
      reply = { type: 'reply', id, result }
    } catch (error) {
      reply = { type: 'reply', id, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.calls.delete(id)
    }
    if (!controller.signal.aborted && this.socket === socket) this.send(socket, reply)
  }

  private send(socket: Socket, message: unknown): void {
    socket.write(`${JSON.stringify(message)}\n`)
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
    this.server?.close()
    this.server = null
  }
}
