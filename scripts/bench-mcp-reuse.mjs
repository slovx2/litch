// 量 Claude 入口跨回合复用 MCP 连接前后，每个回合准备 MCP 要多久。
// 隔离的 Claude 入口加真的 Claude Code CLI 加回环上的假模型，会话配置里两个 MCP 服务：
// 一个 stdio（手写的 fixtures/mcp-count-server.mjs，可以让它晚一点才开始应答，模拟起得慢的服务），
// 一个 Streamable HTTP（本脚本里手写的，每个 HTTP 请求可以加一段延迟，模拟网络往返）。
// 每个回合假模型让 CLI 把两个服务的工具各调一次。同一组回合按“复用”（缺省设置）和“不复用”
// （CHA_CLAUDE_MCP_IDLE_MINUTES=0，即以前每个回合重连的做法）各跑一遍。
// 全在临时目录里，不碰用户的会话、状态目录和 Claude 配置，不用任何模型凭据；不进流水线，手工跑。
//
// 用法：npm run build && CHA_CLAUDE_CLI=<隔离的 claude> node scripts/bench-mcp-reuse.mjs [选项]
//   --turns N          每种做法跑几个回合（默认 8），第一个回合两种做法都要现连，报的是其余回合的中位
//   --latency 毫秒     HTTP 服务每个请求加的延迟（默认 30）
//   --stdio-delay 毫秒 stdio 服务起来之后过多久才开始应答（默认 0）
//
// 量法：
//   MCP 准备  入口自己记的调试日志（native.mcp.prepared）：两个服务从开始准备到都能交给 CLI 用了多久。
//             复用时是一起 ping 一次，现连时是挨个起进程（stdio）、握手（HTTP）。工具清单是 CLI 起来之后才拉的，不在里面
//   首个请求  从发出 turn/start 到假模型收到这个回合的第一个请求：起 CLI、准备 MCP、CLI 初始化（含拉工具清单）都在里面
//   回合      从发出 turn/start 到收到 turn/completed
//   stdio 份数 整组回合里 stdio 服务一共被起了几份；HTTP 服务一共收到几次 initialize
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  const value = Number(index < 0 ? fallback : process.argv[index + 1])
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} 要写成不小于 0 的数`)
  return value
}
const TURNS = Math.max(2, Math.floor(option('turns', 8)))
const LATENCY = option('latency', 30)
const STDIO_DELAY = option('stdio-delay', 0)
const engineMain = join(repo, 'packages/claude/dist/claude/src/adapter.mjs')
if (!existsSync(engineMain)) {
  console.error(`没有找到入口的主文件 ${engineMain}，请先运行 npm run build`)
  process.exit(1)
}
const claudeCli = process.env.CHA_CLAUDE_CLI?.trim()
if (!claudeCli || !existsSync(claudeCli)) {
  console.error(
    '请把 CHA_CLAUDE_CLI 设为隔离的 Claude Code CLI 的路径（不会改用 PATH 里的 claude）',
  )
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'bench-mcp-'))
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const listen = (server) =>
  new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)))
const body = async (req) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString() || '{}')
}

// ---------- HTTP MCP 服务：一行 JSON-RPC 一个 POST，应答直接是 JSON（Streamable HTTP 允许） ----------
const http = { initialize: 0, sessions: 0 }
const mcpHttp = createServer(async (req, res) => {
  await pause(LATENCY)
  // 不提供服务端推送的 SSE 流；关会话（DELETE）也照收
  if (req.method === 'GET') return res.writeHead(405).end()
  if (req.method === 'DELETE') return res.writeHead(200).end()
  const message = await body(req)
  if (message.id === undefined) return res.writeHead(202).end()
  const reply = (result) => {
    const headers = { 'Content-Type': 'application/json' }
    if (message.method === 'initialize') headers['Mcp-Session-Id'] = `bench-${++http.sessions}`
    res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }
  if (message.method === 'initialize') {
    http.initialize++
    return reply({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'bench-http', version: '1.0.0' },
    })
  }
  if (message.method === 'ping') return reply({})
  if (message.method === 'tools/list')
    return reply({
      tools: [
        {
          name: 'echo',
          description: 'Echo back',
          inputSchema: { type: 'object', properties: {} },
          _meta: { 'anthropic/alwaysLoad': true },
        },
      ],
    })
  if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'ok' }] })
  res
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } }))
})
const httpPort = await listen(mcpHttp)

// ---------- 假模型：用户的话来了就让 CLI 把两个服务的工具各调一次，工具结果回来就收场 ----------
const TOOLS = ['mcp__stdio__echo', 'mcp__http__echo']
let firstRequest = null
let streams = 0
const usage = { input_tokens: 100, output_tokens: 20 }
const model = createServer(async (req, res) => {
  const request = await body(req)
  const json = (value) =>
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
  if (req.url === '/api/hello') return json({})
  if (req.url?.startsWith('/v1/messages/count_tokens')) return json({ input_tokens: 100 })
  if (!req.url?.startsWith('/v1/messages')) return res.writeHead(404).end()
  firstRequest ??= Date.now()
  const message = {
    id: `msg_bench_${++streams}`,
    type: 'message',
    role: 'assistant',
    model: request.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage,
  }
  if (request.stream !== true)
    return json({ ...message, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message })
  const last = request.messages?.at(-1)
  const blocks = Array.isArray(last?.content) ? last.content : []
  const offered = new Set((request.tools ?? []).map((tool) => tool.name))
  const asking = last?.role === 'user' && !blocks.some((block) => block.type === 'tool_result')
  const calls = asking ? TOOLS.filter((name) => offered.has(name)) : []
  calls.forEach((name, index) => {
    event('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: `toolu_bench_${streams}_${index}`, name, input: {} },
    })
    event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '{}' } })
    event('content_block_stop', { index })
  })
  if (!calls.length) {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
    event('content_block_stop', { index: 0 })
  }
  event('message_delta', {
    delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage,
  })
  event('message_stop', {})
  res.end()
})
const modelPort = await listen(model)

// ---------- 入口：一种做法起一个，stdio 上说 JSON-RPC ----------
const countServer = pathToFileURL(join(repo, 'packages/claude/test/fixtures/mcp-count-server.mjs'))
const countedStarts = (log) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.includes('"started"')).length
    : 0

async function runMode(mode) {
  const dir = join(root, mode)
  const home = join(dir, 'home')
  const cwd = join(dir, 'project')
  for (const path of [home, cwd, join(home, 'claude')]) mkdirSync(path, { recursive: true })
  const debugLog = join(dir, 'debug.jsonl')
  const stdioLog = join(dir, 'stdio.jsonl')
  const engine = spawn(process.execPath, [engineMain, 'app-server', '--listen', 'stdio://'], {
    // 环境只给必需的几项，不继承用户的任何凭据和配置；模型端只有回环上的假模型
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: dir,
      CODEX_HOME: join(home, 'codex'),
      CHA_CLAUDE_HOME: join(dir, 'state'),
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      CLAUDE_CODE_TMPDIR: join(dir, 'ct'),
      CHA_CLAUDE_CLI: claudeCli,
      ANTHROPIC_API_KEY: 'bench-not-a-secret',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CHA_CLAUDE_DEFAULT_MODEL: 'claude-sonnet-4-6',
      CHA_CLAUDE_DEBUG_LOG: debugLog,
      NODE_NO_WARNINGS: '1',
      ...(mode === 'off' ? { CHA_CLAUDE_MCP_IDLE_MINUTES: '0' } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  engine.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-4000)
  })
  const pending = new Map()
  const completed = new Map()
  let sequence = 0
  createInterface({ input: engine.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.id !== undefined && message.method === undefined) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else if (message.id !== undefined)
      engine.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'bench' } })}\n`,
      )
    else if (message.method === 'turn/completed')
      completed.get(message.params.turn.id)?.(message.params.turn)
  })
  const request = (method, params) =>
    new Promise((done, fail) => {
      const id = ++sequence
      const timer = setTimeout(() => fail(new Error(`${method} 超时\n${stderr}`)), 60_000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) fail(new Error(`${method}: ${message.error.message}`))
        else done(message.result)
      })
      engine.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  try {
    // 握手后的探测只看用户级配置，这里的服务都在会话配置里，不受它影响；退订了也就不探
    await request('initialize', {
      clientInfo: { name: 'bench-mcp', title: null, version: '1.0.0' },
      capabilities: { optOutNotificationMethods: ['mcpServer/startupStatus/updated'] },
    })
    const { thread } = await request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: {
        mcp_servers: {
          stdio: {
            command: process.execPath,
            args: [
              '-e',
              `setTimeout(() => import(${JSON.stringify(countServer.href)}), ${STDIO_DELAY})`,
            ],
            env: { FIXTURE_LOG_PATH: stdioLog },
          },
          http: { url: `http://127.0.0.1:${httpPort}/mcp` },
        },
      },
    })
    const initializeBefore = http.initialize
    const turns = []
    for (let index = 0; index < TURNS; index++) {
      firstRequest = null
      const started = Date.now()
      const { turn } = await request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '两个服务的工具各调一次' }],
      })
      const result = await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`回合超时\n${stderr}`)), 60_000)
        completed.set(turn.id, (value) => {
          clearTimeout(timer)
          done(value)
        })
      })
      if (result.status !== 'completed') throw new Error(`回合没有正常结束：${result.status}`)
      turns.push({ firstRequestMs: firstRequest - started, turnMs: Date.now() - started })
    }
    // 调试日志是攒着写的，回合结束之后再等一下
    await pause(200)
    const events = readFileSync(debugLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const prepared = events.filter((entry) => entry.event === 'native.mcp.prepared')
    const ready = events.filter((entry) => entry.event === 'native.mcp.ready')
    for (const [index, turn] of turns.entries()) {
      turn.mcpMs = prepared[index]?.ms
      turn.reused = ready.slice(index * 2, index * 2 + 2).every((entry) => entry.reused)
    }
    return {
      mode,
      turns,
      stdioStarts: countedStarts(stdioLog),
      httpInitialize: http.initialize - initializeBefore,
    }
  } finally {
    engine.stdin.end()
    const exited = new Promise((done) => engine.once('exit', done))
    const force = setTimeout(() => engine.kill('SIGKILL'), 10_000)
    await exited
    clearTimeout(force)
  }
}

// ---------- 跑、报 ----------
const load = () =>
  loadavg()
    .map((value) => value.toFixed(2))
    .join(' ')
console.log(
  `回合数 ${TURNS}，HTTP 每请求延迟 ${LATENCY} ms，stdio 晚 ${STDIO_DELAY} ms 应答；系统负载 ${load()}`,
)
const results = []
try {
  for (const mode of ['reuse', 'off']) results.push(await runMode(mode))
} finally {
  mcpHttp.close()
  model.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
const LABEL = { reuse: '复用', off: '不复用' }
const columns = [
  ['MCP 准备', 'mcpMs'],
  ['首个请求', 'firstRequestMs'],
  ['回合', 'turnMs'],
]
console.log('\n第 2 个回合起的中位（毫秒）；括号里是第 1 个回合')
console.log(['做法', ...columns.map(([label]) => label.trim())].join('\t'))
for (const { mode, turns } of results) {
  const rest = turns.slice(1)
  console.log(
    [
      LABEL[mode],
      ...columns.map(([, key]) => `${median(rest.map((turn) => turn[key]))} (${turns[0][key]})`),
    ].join('\t'),
  )
}
console.log('\n整组回合里')
for (const { mode, turns, stdioStarts, httpInitialize } of results) {
  const reused = turns.slice(1).filter((turn) => turn.reused).length
  console.log(
    `${LABEL[mode]}：stdio 服务起了 ${stdioStarts} 份，HTTP 服务握手 ${httpInitialize} 次，第 2 个回合起两个都复用的回合 ${reused}/${turns.length - 1}`,
  )
}
console.log(`\n系统负载 ${load()}`)
