import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { AcpServer } from '../src/server.mjs'
import { assertNotification, assertResponse, assertServerRequest } from './schema.mjs'

// 假客户端：记录通知，按 handler 应答服务端发起的反向请求；往来消息一律按协议 schema 校验（与 dsh 的测试同一做法）。
// schema 违例先收集、最后统一断言：在发送路径上直接抛错会被服务端当成回合失败吞掉。
export const violations = new Set<string>()
const checked = (check: () => void) => {
  try {
    check()
  } catch (error) {
    violations.add(String((error as Error).message).slice(0, 600))
  }
}

export function client(server: AcpServer) {
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

export const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))

export interface Isolated {
  root: string
  cwd: string
  home: string
  /** 起假 agent 用的环境：只有这几项和 PATH，不带个人配置 */
  env: NodeJS.ProcessEnv
  /** 假 agent 收到的每条消息 */
  received(): Promise<any[]>
  restore(): Promise<void>
}

// 隔离环境：临时目录当 HOME 和状态目录，agent 是 test/fake-agent.mts。extra 并进环境（FAKE_ACP_* 这些）。
export async function isolate(extra: Record<string, string> = {}): Promise<Isolated> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cha-acp-')))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const log = join(root, 'agent-messages.jsonl')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    CHA_ACP_AGENT: 'acp',
    CHA_ACP_CLI: process.execPath,
    CHA_ACP_ARGS: `"${FAKE_AGENT}"`,
    FAKE_ACP_STATE: join(root, 'agent-state.json'),
    FAKE_ACP_LOG: log,
    ...extra,
  }
  return {
    root,
    cwd,
    home: join(root, 'home'),
    env,
    async received() {
      const text = await readFile(log, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.message)
        .map((entry) => entry.message)
    },
    async restore() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

export type Scene = Isolated & { server: AcpServer; desktop: ReturnType<typeof client> }

/** 一个 ACP 引擎、一个假 agent、一个握过手的假客户端 */
export async function scene(extra: Record<string, string> = {}): Promise<Scene> {
  const env = await isolate(extra)
  const server = new AcpServer(env.home, env.env)
  const desktop = client(server)
  await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
  return { ...env, server, desktop }
}

export async function dispose(s: Scene): Promise<void> {
  await s.server.close()
  await s.restore()
}

export const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]

/** 起一个回合，等它收尾，回收尾时的回合 */
export async function turn(
  s: Scene,
  threadId: string,
  input: any[],
  extra: object = {},
): Promise<any> {
  const { turn: started } = await s.desktop.call('turn/start', { threadId, input, ...extra })
  const done = await s.desktop.until(
    'turn/completed',
    (p) => p.turn.id === started.id && p.threadId === threadId,
  )
  return done.turn
}
