import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import type { DshServer } from '../src/server.mjs'
import {
  type MockBlock,
  type MockModel,
  type MockResponder,
  startMockModel,
} from './mock-model.mjs'
import { assertNotification, assertResponse, assertServerRequest } from './schema.mjs'

// 假客户端：记录通知，按 handler 应答服务端发起的反向请求；往来消息一律按协议 schema 校验。
// schema 违例先收集、最后统一断言：在发送路径上直接抛错会被服务端当成回合失败吞掉。
export const violations = new Set<string>()
const checked = (check: () => void) => {
  try {
    check()
  } catch (error) {
    violations.add(String((error as Error).message).slice(0, 600))
  }
}

export function client(server: DshServer) {
  const notifications: any[] = []
  const requests: any[] = []
  const waiting = new Map<string, (message: any) => void>()
  // 返回 undefined 表示先不答，由用例之后用 respond 来答（多条连接时要定谁先答）。
  let answer: (request: any) => unknown = () => ({})
  const peer: RpcPeer = {
    id: randomUUID(),
    close() {},
    send(message: WireMessage) {
      const wire = message as any
      if (wire.method && wire.id !== undefined) {
        checked(() => assertServerRequest(wire.method, wire.params))
        requests.push(wire)
        const result = answer(wire)
        if (result !== undefined) void server.handle(peer, { jsonrpc: '2.0', id: wire.id, result })
      } else if (wire.method) {
        checked(() => assertNotification(wire.method, wire.params))
        notifications.push(wire)
      } else waiting.get(String(wire.id))?.(wire)
    },
  }
  return {
    peer,
    notifications,
    requests,
    onRequest(handler: (request: any) => unknown) {
      answer = handler
    },
    // 回答一条先前没答的服务端请求。
    respond(request: any, result: unknown): Promise<void> {
      return server.handle(peer, { jsonrpc: '2.0', id: request.id, result })
    },
    // 失败时抛出的错误带上 JSON-RPC 错误码，便于断言"不适用"与"方法不存在"的区别。
    async call(method: string, params: unknown = {}): Promise<any> {
      const id = randomUUID()
      const reply = new Promise<any>((resolve) => waiting.set(id, resolve))
      await server.handle(peer, { jsonrpc: '2.0', id, method, params })
      const message = await reply
      if (message.error)
        throw Object.assign(new Error(`${method}: ${message.error.message}`), {
          code: message.error.code,
          data: message.error.data,
        })
      checked(() => assertResponse(method, message.result))
      return message.result
    },
    async until(method: string, match: (params: any) => boolean = () => true): Promise<any> {
      for (let waited = 0; waited < 20000; waited += 20) {
        const found = notifications.find((entry) => entry.method === method && match(entry.params))
        if (found) return found.params
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`等待通知超时: ${method}`)
    },
  }
}

// 隔离环境：临时目录、回环模型、假密钥、独立的 dsh 状态目录；子进程继承这些变量，不读取个人配置。
export async function isolate(script: MockBlock[][] | MockResponder): Promise<{
  root: string
  cwd: string
  model: MockModel
  restore(): Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-harness-adapter-dsh-')))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const model = await startMockModel(script)
  const saved = { ...process.env }
  Object.assign(process.env, {
    DEEPSEEK_BASE_URL: model.url,
    DEEPSEEK_API_KEY: 'mock-not-a-real-key',
    DSH_AGENTS_HOME: join(root, 'agents-home'),
    // dsh 自己的配置目录：入口默认用用户的 ~/.dsh，测试一律指进临时目录（位置和改用 ~/.dsh 之前一样，在 <home>/dsh-home）
    DSH_HOME: join(root, 'home', 'dsh-home'),
  })
  return {
    root,
    cwd,
    model,
    async restore() {
      await model.close()
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
      await rm(root, { recursive: true, force: true })
    },
  }
}
