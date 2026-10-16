import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'
import { assertNotification, assertResponse, assertServerRequest } from './schema.mjs'

// 审批用例共用的设施：真实 Pi SDK 加回环上的假模型，独立的临时代理目录，结束时全部清掉。
// 服务端请求不自动回答，由用例决定谁答、什么时候答、答什么。

// fail：这次请求以 400 失败（客户端库不会自动重试），值是错误信息
export type Reply = { text?: string; tools?: Array<{ name: string; args: unknown }>; fail?: string }
export type Step = Reply | ((body: any) => Reply | Promise<Reply>)

export const APPROVALS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]
const STANDARD = ['accept', 'acceptForSession', 'decline', 'cancel']
const WITH_NOTE = ['accept', 'acceptForSession', 'decline', 'declineWithNote', 'cancel']

export const text = (value: string) => [{ type: 'text', text: value }]
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 模型请求里带着的工具结果，按先后 */
export function toolResults(body: any): string[] {
  return body.messages
    .filter((message: any) => message.role === 'tool')
    .map((message: any) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
}

export interface HarnessOptions {
  /** 打没打开审批，默认打开 */
  approvals?: boolean
  /** 起服务之前往代理目录里放东西（MCP 配置、用户扩展） */
  prepare?: (agentDir: string, root: string) => Promise<void>
}

export async function approvalHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-approval-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(agentDir)
  await mkdir(cwd)
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  // 排了步骤的模型请求按步骤应答，没排的回一句话。
  const requests: any[] = []
  const steps: Step[] = []
  const http = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const step = steps.shift() ?? { text: `回答${requests.length}` }
    const reply = typeof step === 'function' ? await step(body) : step
    if (res.destroyed) return
    if (reply.fail) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: reply.fail } }))
      return
    }
    const base = { id: `mock_${requests.length}`, object: 'chat.completion.chunk', created: 1 }
    const calls = reply.tools?.map((tool, index) => ({
      index,
      id: `call_${requests.length}_${index}`,
      type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.args) },
    }))
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      `data: ${JSON.stringify({ ...base, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(
      chunk(
        { role: 'assistant', ...(calls ? { tool_calls: calls } : { content: reply.text ?? 'ok' }) },
        null,
      ),
    )
    res.write(
      chunk({}, calls ? 'tool_calls' : 'stop', {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        gate: {
          baseUrl: `http://127.0.0.1:${(http.address() as any).port}/v1`,
          api: 'openai-completions',
          apiKey: 'test-only',
          models: [
            {
              id: 'gate',
              name: 'Gate',
              reasoning: false,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
  )
  await options.prepare?.(agentDir, root)
  const server = new PiServer(join(root, 'state'), { approvals: options.approvals !== false })
  const invalid: string[] = []
  const checked = (check: () => void) => {
    try {
      check()
    } catch (error) {
      invalid.push(String(error))
    }
  }
  let sequence = 0

  /** 一条连接。extensions 是它握手时声明认识的扩展 */
  const connect = async (id: string, extensions: string[] = []) => {
    const messages: any[] = []
    const noted = extensions.includes('declineWithNote')
    const peer: RpcPeer = {
      id,
      close() {},
      send(message: WireMessage) {
        const wire = message as any
        messages.push(wire)
        if (wire.method && wire.id === undefined)
          checked(() => assertNotification(wire.method, wire.params))
        if (!wire.method || wire.id === undefined) return
        // 没声明扩展的连接上，服务端请求必须逐字段符合标准协议；声明了的连接上审批请求多出来的
        // 只能是决定列表里的“拒绝并附说明”，去掉之后同样要符合标准协议。
        const approval = APPROVALS.includes(wire.method)
        checked(() => {
          if (!approval || !noted) return assertServerRequest(wire.method, wire.params)
          assert.deepEqual(wire.params.availableDecisions, WITH_NOTE, `${id} 收到的决定列表`)
          const { availableDecisions: _listed, ...standard } = wire.params
          assertServerRequest(
            wire.method,
            wire.method === APPROVALS[0] ? { ...standard, availableDecisions: STANDARD } : standard,
          )
        })
        if (approval && !noted)
          checked(() =>
            assert.deepEqual(
              wire.params.availableDecisions,
              wire.method === APPROVALS[0] ? STANDARD : undefined,
              `${id} 没声明扩展，收到的应当是标准的决定列表`,
            ),
          )
      },
    }
    const until = async (what: string, find: (m: any) => boolean): Promise<any> => {
      for (let waited = 0; waited < 20000; waited += 10) {
        const found = messages.find(find)
        if (found) return found
        await pause(10)
      }
      throw new Error(`${id} 等待超时：${what}`)
    }
    const call = async (method: string, params: any = {}): Promise<any> => {
      const requestId = ++sequence
      await server.handle(peer, { jsonrpc: '2.0', id: requestId, method, params })
      return messages.find((m) => m.id === requestId && !m.method)
    }
    const ok = async (method: string, params: any = {}): Promise<any> => {
      const reply = await call(method, params)
      assert.equal(reply?.error, undefined, `${method}: ${JSON.stringify(reply?.error)}`)
      assertResponse(method, reply.result)
      return reply.result
    }
    const approvals = () => messages.filter((m) => APPROVALS.includes(m.method))
    let taken = 0
    await ok('initialize', {
      clientInfo: { name: id, version: '0' },
      capabilities: { litchExtensions: extensions },
    })
    return {
      peer,
      messages,
      until,
      call,
      ok,
      approvals,
      notifications: (method: string) => messages.filter((m) => m.method === method && !m.id),
      /** 下一条还没取过的审批请求，按到达的先后 */
      async approval(what = '审批请求'): Promise<any> {
        const index = taken++
        await until(what, () => approvals().length > index)
        return approvals()[index]
      },
      answer: (request: any, result: unknown) =>
        server.handle(peer, { jsonrpc: '2.0', id: request.id, result } as any),
      decide: (request: any, decision: unknown) =>
        server.handle(peer, { jsonrpc: '2.0', id: request.id, result: { decision } } as any),
      async start(threadId: string, input: string, params: any = {}): Promise<string> {
        return (await ok('turn/start', { threadId, input: text(input), ...params })).turn.id
      },
      async completed(turnId: string): Promise<any> {
        const done = await until(
          `回合 ${turnId} 结束`,
          (m) => m.method === 'turn/completed' && m.params.turn.id === turnId,
        )
        return done.params.turn
      },
      /** 某个条目最后一次 item/completed 里的样子 */
      item(itemId: string): any {
        return messages.findLast(
          (m) => m.method === 'item/completed' && m.params.item.id === itemId,
        )?.params.item
      },
    }
  }
  let closed = false
  // 关掉适配器这一头（只关一次）：用例要看“适配器退出时”的行为时自己先调。
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    await server.close()
  }
  return {
    root,
    agentDir,
    cwd,
    server,
    requests,
    steps,
    invalid,
    connect,
    shutdown,
    async dispose(): Promise<void> {
      await shutdown()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      await rm(root, { recursive: true, force: true })
    },
  }
}
