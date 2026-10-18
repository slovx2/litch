// 跑在 dsh 进程里的 cordis 插件：把适配器给每个会话的客户端工具注册成 dsh 的工具，调用交回适配器。
// 适配器起 dsh 时经 --patch 插进来（client-tools.mts 的 ClientToolBridge.patch），config 是 {host, port, token}。
// 线路的规矩写在 client-tools.mts 开头。
//
// 这个文件由 dsh 自己的 Node 直接加载，所以只引用 Node 自带的模块，不引用适配器的别的文件，也不引用 dsh 的包
// （插件文件的位置解析不到 dsh 的依赖）：工具定义按 dsh 的 ToolDefinition 形状直接写，不经 defineTool。
// 对着 dsh 0.2.0-rc.2 写的：agent/created、agent.ctx.tools.register（只对这个会话可见）、ctx.agents、
// ctx.get('attachments').saveImage。
import { connect, type Socket } from 'node:net'

export const name = 'litch-client-tools'
export const inject = ['tools', 'agents']

interface Config {
  host: string
  port: number
  token: string
}
interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
}
interface Installed {
  version: number
  dispose: () => void
}

// 连不上适配器时隔多久再连
const RETRY_MS = 1000
// 问工具清单等多久：agent 建好时 dsh 等着这一步，适配器卡住了也不能让会话起不来
const TOOLS_TIMEOUT_MS = 5000

// 工具结果交给 dsh 的规范值：内容块原样放着，render 时交出去。
// dsh 只接受它的 JSON Schema 子集（type/oneOf/properties/required/additionalProperties/items/enum/const）
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { content: { type: 'array', items: {} } },
  required: ['content'],
  additionalProperties: false,
}

export function apply(ctx: any, config: Config): void {
  let socket: Socket | null = null
  let closed = false
  let next = 0
  const pending = new Map<string, { resolve: (value: any) => void; reject: (e: Error) => void }>()
  const installed = new Map<any, Installed>()

  const send = (message: unknown): boolean => {
    if (!socket) return false
    socket.write(`${JSON.stringify(message)}\n`)
    return true
  }
  // 发一个要应答的消息。返回消息号（撤回时用）和应答
  const request = (
    message: Record<string, unknown>,
    timeoutMs?: number,
  ): { id: string; reply: Promise<any> } => {
    const id = `p-${++next}`
    const reply = new Promise<any>((resolve, reject) => {
      if (!send({ ...message, id })) {
        reject(new Error('和 Litch 适配器的连接断开了'))
        return
      }
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(id)
            reject(new Error('Litch 适配器没有应答'))
          }, timeoutMs)
        : null
      const settle = () => timer && clearTimeout(timer)
      pending.set(id, {
        resolve: (value) => {
          settle()
          resolve(value)
        },
        reject: (error) => {
          settle()
          reject(error)
        },
      })
    })
    return { id, reply }
  }

  // 装上（或换掉）一个会话的工具。版本不比装着的新的不动：晚到的旧清单不盖新的
  const install = (agent: any, version: number, tools: Tool[]): void => {
    const current = installed.get(agent)
    if (current && current.version >= version) return
    current?.dispose()
    const owner = String(agent.session.id)
    // 一个工具装不上（dsh 不认它的参数结构之类）只跳过它，不能让会话起不来、也不能让 dsh 进程出错
    const disposers: (() => void)[] = []
    for (const tool of tools) {
      try {
        disposers.push(
          agent.ctx.tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: {
              schema: OUTPUT_SCHEMA,
              render: (_args: unknown, value: any) => value.content,
            },
            execute: (args: unknown, exec: any) => call(owner, tool.name, args, exec),
          }),
        )
      } catch (error) {
        ctx.logger?.warn?.(`litch-client-tools: ${tool.name} 没有装上：${String(error)}`)
      }
    }
    installed.set(agent, {
      version,
      dispose: () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 会话已经收掉了，注册随它一起没了
          }
        }
      },
    })
  }

  const pull = async (agent: any): Promise<void> => {
    if (!socket) return
    const reply = await request(
      { type: 'tools', sessionId: String(agent.session.id) },
      TOOLS_TIMEOUT_MS,
    ).reply.catch(() => null)
    if (reply && Array.isArray(reply.tools)) install(agent, Number(reply.version) || 0, reply.tools)
  }

  const call = async (owner: string, toolName: string, args: unknown, exec: any): Promise<any> => {
    const signal: AbortSignal | undefined = exec?.signal
    signal?.throwIfAborted()
    const { id, reply } = request({
      type: 'call',
      sessionId: owner,
      callId: String(exec?.callId ?? ''),
      name: toolName,
      arguments: args ?? {},
    })
    const onAbort = () => {
      const entry = pending.get(id)
      pending.delete(id)
      send({ type: 'cancel', id })
      entry?.reject(new Error('调用已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let answer: any
    try {
      answer = await reply
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (typeof answer.error === 'string') throw new Error(answer.error)
    const result = answer.result
    const items: any[] = Array.isArray(result?.contentItems) ? result.contentItems : []
    if (result?.success !== true) {
      const text = items
        .filter((item) => item?.type === 'inputText')
        .map((item) => item.text)
        .join('\n')
      throw new Error(text || '客户端工具执行失败')
    }
    return { content: await content(items) }
  }

  // 客户端答复的内容换成 dsh 的内容块。图片要先存进 dsh 的附件（它的图片块只认附件号），存不进的换成一句话
  const content = async (items: any[]): Promise<any[]> => {
    const blocks: any[] = []
    for (const item of items) {
      if (item?.type === 'inputText' && typeof item.text === 'string')
        blocks.push({ type: 'text', text: item.text })
      else if (item?.type === 'inputImage' && typeof item.imageUrl === 'string') {
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(item.imageUrl)
        const attachments = ctx.get('attachments')
        try {
          if (!match) throw new Error('只收 data: 地址的图片')
          if (!attachments) throw new Error('dsh 没有附件服务')
          const ref = await attachments.saveImage({
            data: Buffer.from(match[2] as string, 'base64'),
            mediaType: match[1],
            name: 'litch-client-tool',
          })
          blocks.push({ type: 'image', attachment: ref })
        } catch (error) {
          blocks.push({
            type: 'text',
            text: `[图片没能交给模型：${error instanceof Error ? error.message : String(error)}]`,
          })
        }
      }
    }
    return blocks
  }

  const open = (): void => {
    if (closed) return
    const connection = connect(config.port, config.host)
    let buffer = ''
    connection.setEncoding('utf8')
    connection.on('connect', () => {
      connection.write(`${JSON.stringify({ type: 'hello', token: config.token })}\n`)
      socket = connection
      // 连上之前就建好的会话（dsh 起来时恢复的、连上之前建的）这时补问一遍
      for (const agent of ctx.agents.list()) void pull(agent)
    })
    connection.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === 'reply') {
          const entry = pending.get(String(message.id))
          pending.delete(String(message.id))
          entry?.resolve(message)
        } else if (message.type === 'install') {
          const agent = ctx.agents.get(String(message.sessionId))
          if (agent && Array.isArray(message.tools))
            install(agent, Number(message.version) || 0, message.tools)
          send({ type: 'ack', id: message.id })
        }
      }
    })
    connection.on('error', () => {})
    connection.on('close', () => {
      if (socket === connection) socket = null
      for (const entry of pending.values()) entry.reject(new Error('和 Litch 适配器的连接断开了'))
      pending.clear()
      if (!closed) setTimeout(open, RETRY_MS)
    })
  }

  ctx.on('agent/created', async ({ agent }: any) => {
    await pull(agent)
  })
  ctx.on('agent/disposed', ({ agent }: any) => {
    installed.delete(agent)
  })
  ctx.effect(() => {
    open()
    return () => {
      closed = true
      socket?.destroy()
      socket = null
      for (const current of installed.values()) current.dispose()
      installed.clear()
    }
  }, 'litch-client-tools: bridge')
}
