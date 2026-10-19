import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { OpencodeServer } from '../src/server.mjs'
import { type MockModel, type MockResponder, startMockModel } from './mock-model.mjs'
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

// 测试用的 OpenCode：CHA_OPENCODE_CLI 指定的，没有就用官方安装脚本装到的位置；都不可执行时整组跳过。
export const opencodeCli: string | null = (() => {
  for (const path of [
    process.env.CHA_OPENCODE_CLI,
    join(homedir(), '.opencode/bin/opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ]) {
    if (!path) continue
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {}
  }
  return null
})()
export const skip = opencodeCli ? false : '没有装 OpenCode（可用 CHA_OPENCODE_CLI 指定）'

export function client(server: OpencodeServer, declare: string[] = []) {
  const notifications: any[] = []
  const requests: any[] = []
  const waiting = new Map<string, (message: any) => void>()
  // 返回 undefined 表示先不答，由用例之后用 respond 来答。
  let answer: (request: any) => unknown = () => ({})
  const peer: RpcPeer = {
    id: randomUUID(),
    close() {},
    send(message: WireMessage) {
      const wire = message as any
      if (wire.method && wire.id !== undefined) {
        checked(() => assertServerRequest(wire.method, standard(wire)))
        requests.push(wire)
        const result = answer(wire)
        if (result !== undefined) void server.handle(peer, { jsonrpc: '2.0', id: wire.id, result })
      } else if (wire.method) {
        checked(() => assertNotification(wire.method, wire.params))
        // 记下发出那一刻的样子（真实线路上发出时就序列化了，之后投影再改条目也不影响）
        notifications.push(structuredClone(wire))
      } else waiting.get(String(wire.id))?.(wire)
    },
  }
  // 声明了 declineWithNote 的连接上，审批请求的决定列表里多出“拒绝并附说明”：一定要有，去掉之后照标准协议校验；
  // 没声明的连接上不许出现。
  const noted = declare.includes('declineWithNote')
  const standard = (wire: any) => {
    const listed = wire.params?.availableDecisions
    if (!Array.isArray(listed)) return wire.params
    if (noted !== listed.includes('declineWithNote'))
      throw new Error(
        `${wire.method}: 决定列表与是否声明 declineWithNote 不符: ${JSON.stringify(listed)}`,
      )
    return {
      ...wire.params,
      availableDecisions: listed.filter((entry: unknown) => entry !== 'declineWithNote'),
    }
  }
  const self = {
    peer,
    notifications,
    requests,
    onRequest(handler: (request: any) => unknown) {
      answer = handler
    },
    respond(request: any, result: unknown): Promise<void> {
      return server.handle(peer, { jsonrpc: '2.0', id: request.id, result })
    },
    // 失败时抛出的错误带上 JSON-RPC 错误码，便于断言“不适用”与“方法不存在”的区别。
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
    async initialize(optOut: string[] = []): Promise<any> {
      return self.call('initialize', {
        clientInfo: { name: 'test', title: null, version: '0' },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: optOut,
          ...(declare.length ? { litchExtensions: declare } : {}),
        },
      })
    },
    async until(
      method: string,
      match: (params: any) => boolean = () => true,
      timeoutMs = 30000,
    ): Promise<any> {
      for (let waited = 0; waited < timeoutMs; waited += 20) {
        const found = notifications.find((entry) => entry.method === method && match(entry.params))
        if (found) return found.params
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`等待通知超时: ${method}`)
    },
    async request(method: string, timeoutMs = 30000): Promise<any> {
      for (let waited = 0; waited < timeoutMs; waited += 20) {
        const found = requests.find((entry) => entry.method === method)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`等待反向请求超时: ${method}`)
    },
    of(method: string, threadId?: string): any[] {
      return notifications
        .filter((entry) => entry.method === method)
        .map((entry) => entry.params)
        .filter((params) => !threadId || params.threadId === threadId)
    },
  }
  return self
}

// 把真实模型、真实配置挡在外面的环境变量：各家模型的密钥、OpenCode 自己的设置
const LEAKY =
  /^(OPENCODE_|ANTHROPIC|OPENAI|AZURE|AWS_|GOOGLE|GEMINI|VERTEX|DEEPSEEK|OPENROUTER|GROQ|MISTRAL|XAI|TOGETHER|FIREWORKS|CEREBRAS|GITHUB_TOKEN|GH_TOKEN|HF_|HUGGING|COHERE|PERPLEXITY|ZHIPU|MOONSHOT|DASHSCOPE|CHA_)/

export interface Isolated {
  root: string
  cwd: string
  home: string
  model: MockModel
  server: OpencodeServer
  restore(): Promise<void>
}

// 隔离环境：HOME 和 XDG_* 全指到临时目录，OpenCode 的配置写一个指向回环假模型的提供方；
// 关掉联网拉模型清单、自动更新、LSP 下载、分享和默认插件，npm 指到一个连不上的地址（OpenCode 会去装插件包）。
// 项目目录是一个 git 仓库：OpenCode 的快照（回合差异、回退恢复文件）只在 git 仓库里做。
export async function isolate(
  respond: MockResponder,
  options: { permission?: Record<string, unknown>; files?: Record<string, string> } = {},
): Promise<Isolated> {
  if (!opencodeCli) throw new Error('没有 OpenCode')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cha-opencode-')))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await mkdir(join(cwd, name, '..'), { recursive: true })
    await writeFile(join(cwd, name), content)
  }
  const xdg = (name: string) => join(root, 'xdg', name)
  const env: Record<string, string> = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: xdg('config'),
    XDG_DATA_HOME: xdg('data'),
    XDG_STATE_HOME: xdg('state'),
    XDG_CACHE_HOME: xdg('cache'),
    CHA_OPENCODE_CLI: opencodeCli,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    npm_config_registry: 'http://127.0.0.1:9/',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  for (const dir of [
    env.HOME,
    ...Object.values(env).filter((v) => v.startsWith(join(root, 'xdg'))),
  ])
    await mkdir(dir as string, { recursive: true })
  const model = await startMockModel(respond)
  await mkdir(join(env.XDG_CONFIG_HOME as string, 'opencode'), { recursive: true })
  await writeFile(
    join(env.XDG_CONFIG_HOME as string, 'opencode/opencode.json'),
    JSON.stringify({
      model: 'mock/m1',
      small_model: 'mock/m1',
      share: 'disabled',
      autoupdate: false,
      ...(options.permission ? { permission: options.permission } : {}),
      provider: {
        mock: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Mock',
          options: { baseURL: model.url, apiKey: 'mock-not-a-real-key' },
          models: {
            m1: {
              name: 'Mock M1',
              reasoning: true,
              tool_call: true,
              attachment: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              limit: { context: 100000, output: 4000 },
              variants: { high: { reasoningEffort: 'high' }, low: { reasoningEffort: 'low' } },
            },
          },
        },
      },
    }),
  )
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) if (LEAKY.test(key)) delete process.env[key]
  Object.assign(process.env, env)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'ignore', env: process.env })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const home = join(root, 'adapter')
  const server = new OpencodeServer(home)
  return {
    root,
    cwd,
    home,
    model,
    server,
    async restore() {
      await server.close().catch(() => {})
      await model.close()
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
      await rm(root, { recursive: true, force: true })
    },
  }
}

export const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
