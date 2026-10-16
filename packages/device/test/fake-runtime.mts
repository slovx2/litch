// 假的运行时进程：给“真的适配器主进程加真的设备进程”的测试用（service.test.mts）。
// 主进程怎么对待真的引擎进程，就怎么对待它：先带 --runtime-info 跑一遍环境检查，再带
// `app-server --listen unix://路径` 常驻。它在那个套接字上按运行时的线上格式说话
// （HTTP 升级成 WebSocket，每帧一条 JSON），不碰任何真的 harness，也不发任何模型请求。
//
// 测试靠这几样控制它、观察它：
// - 套接字旁边有名为 busy 的文件时，会话列表里有一个正在跑回合的会话
// - `fixture/env` 返回这个进程的某个环境变量（或者它的摘要）和进程号：看设置里的环境变量有没有生效、进程换没换
// - 命令行路径的环境变量指向不存在的文件时，环境检查照真引擎的原话报“未找到”
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'

/** 各 harness 的命令行路径经哪个环境变量给，和适配器主进程里的那张表一致 */
const CLI_VARIABLE: Record<string, string> = {
  'claude-code': 'CHA_CLAUDE_CLI',
  pi: 'PI_CLI',
  dsh: 'CHA_DSH_CLI',
}

const PROTOCOL = '0.157.1'

function serve(engine: string, socket: string): void {
  const directory = dirname(socket)
  const handlers: Record<string, (params: any) => unknown> = {
    initialize: () => ({
      userAgent: `fake/${PROTOCOL} (test; test) ${engine}`,
      codexHome: directory,
      platformFamily: 'unix',
      platformOs: 'test',
    }),
    'runtime/info': () => ({
      engine,
      protocolVersion: PROTOCOL,
      cliBuild: '1.2.3',
      capabilities: [],
      releaseReady: false,
    }),
    'thread/list': () => ({
      data: existsSync(join(directory, 'busy'))
        ? [{ id: `${engine}-busy`, updatedAt: 1, status: { type: 'active', activeFlags: [] } }]
        : [],
      nextCursor: null,
      backwardsCursor: null,
    }),
    'model/list': () => ({ data: [{ id: `${engine}-model` }], nextCursor: null }),
    'fixture/env': (params) => {
      const value = process.env[String(params.name)] ?? null
      // digest：只给摘要，查密钥有没有生效时用，免得密钥本身经线上传回去
      const shown =
        params.digest === true && value !== null
          ? createHash('sha256').update(value).digest('hex')
          : value
      return { value: shown, pid: process.pid }
    },
  }
  const server = http.createServer()
  const sockets = new WebSocketServer({ server, perMessageDeflate: false })
  sockets.on('connection', (ws) => {
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (typeof frame.method !== 'string' || frame.id === undefined) return
      const handler = handlers[frame.method]
      ws.send(
        JSON.stringify(
          handler
            ? { id: frame.id, result: handler(frame.params ?? {}) }
            : { id: frame.id, error: { code: -32601, message: `不支持 ${frame.method}` } },
        ),
      )
    })
  })
  // 主进程探测就绪时只连一下就断，不升级成 WebSocket
  server.on('clientError', (_error, connection) => connection.destroy())
  server.listen(socket, () => process.stderr.write(`fake runtime started ${engine}\n`))
  const stop = () => {
    for (const ws of sockets.clients) ws.terminate()
    server.close(() => process.exit(0))
    server.closeAllConnections()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

/** 进程入口。engine 是这份假运行时扮演的 harness */
export function run(engine: string): void {
  const argv = process.argv.slice(2)
  if (argv.includes('--runtime-info')) {
    const cli = process.env[CLI_VARIABLE[engine] ?? '']
    if (cli && !existsSync(cli)) {
      process.stderr.write(`Error: 宿主 CLI 不可执行或未找到: ${cli}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(
      `${JSON.stringify({ engine, protocolVersion: PROTOCOL, nodeVersion: process.versions.node })}\n`,
    )
    return
  }
  if (argv.includes('--pty-self-check')) {
    process.stdout.write('pty-self-check ok\n')
    return
  }
  const listen = argv[argv.indexOf('--listen') + 1] ?? ''
  if (argv[0] !== 'app-server' || !listen.startsWith('unix://')) {
    process.stderr.write(`假运行时不认识这样的启动参数：${argv.join(' ')}\n`)
    process.exitCode = 2
    return
  }
  serve(engine, listen.slice('unix://'.length))
}
