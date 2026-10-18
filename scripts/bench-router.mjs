// 量设备进程的路由层（聚合面）给消息加了多少延迟和开销（多了一跳转发，要确认它不拖慢流式输出）。
// 同一个 Pi 运行时、同一个回环上的假模型，两种接法各跑一遍再比：
//   直连：客户端 ── Pi 入口
//   经设备进程：客户端 ── 聚合面（设备进程）── Pi 入口
// 全在临时目录里，不碰用户的会话和状态目录，不用任何模型凭据；不进流水线，要量的时候手工跑。
//
// 用法：npm run bench:router -- [选项]（会先构建；已经构建过的可以直接 node scripts/bench-router.mjs [选项]）
//   --deltas N       一个回合里假模型吐多少条增量（默认 5000）
//   --intervals A,B  增量之间隔多少毫秒，每个值各量一组（默认 0,1；0 是一条接一条不等）
//   --sessions N     并发那一组同时开几个会话（默认 4）
//   --requests N     请求往返那一组每轮发多少次（默认 1000）
//   --rounds N       每组跑几轮，报的是各轮的中位（默认 5）
//   --json 文件      把每一轮的原始结果另存一份
//
// 量法：
//   延迟   假模型把发出时刻写在每条增量的字里（scripts/bench-router-model.mjs），客户端在收到那条通知的
//          回调一开头读钟，两个时刻相减。两头是同一台机器上的同一个钟。直连量到的是运行时自己的耗时，
//          经设备进程的比它多出来的就是路由层加的。
//   总时长 从发出 turn/start 到收到 turn/completed。
//   CPU    设备进程和运行时各自的 process.cpuUsage()，回合前后各取一次相减。取数靠启动时预装的一小段：
//          收到父进程的消息就把读数发回来，别的什么都不做。
//   往返   一次只发一个请求，等到应答再发下一个。thread/list 在聚合面上是设备层自己合并的，
//          thread/read 是按会话转发的，两样都量；最后再读一个带全部回合的大应答，
//          看聚合面改写会话对象（整包解析再整包写出）要多久。
// 读数的时候要留意两件事：
//   机器忙的时候延迟类的数会偏大，结果开头和末尾各印一次系统负载，负载高时量到的数不要当真。
//   增量太密时先到头的是运行时自己（它只有一个线程，处理一条增量要几十微秒，量它的是 bench-delta.mjs）：
//   几个会话同时一条接一条不等地吐（间隔 0），量到的延迟主要是运行时里的积压，两种接法差多少淹在里面。
//   要看路由层在并发下加了多少，用运行时跟得上的节奏，各隔 1 毫秒就跟得上。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { WebSocket } from 'ws'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engineMain = join(repo, 'packages/pi/dist/pi/src/adapter.mjs')
const deviceMain = join(repo, 'packages/device/dist/device/src/main.mjs')
for (const [path, name] of [
  [engineMain, 'packages/pi'],
  [deviceMain, 'packages/device'],
]) {
  if (existsSync(path)) continue
  console.error(`没有找到 ${name} 的构建产物，请先运行 npm run build`)
  process.exit(1)
}
const piPackage = join(repo, 'packages/pi/node_modules/@earendil-works/pi-coding-agent')
const piEntry = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).main
const piCli = join(piPackage, dirname(piEntry), 'cli.js')

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const count = (name, fallback) => {
  const value = Number(option(name, fallback))
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} 要写正整数`)
  return value
}
const DELTAS = count('deltas', 5000)
const SESSIONS = count('sessions', 4)
const REQUESTS = count('requests', 1000)
const ROUNDS = count('rounds', 5)
const INTERVALS = String(option('intervals', '0,1')).split(',').map(Number)
if (INTERVALS.some((value) => !Number.isFinite(value) || value < 0))
  throw new Error('--intervals 要写成用逗号隔开的毫秒数，比如 0,1')
const jsonPath = option('json', null)

// 套接字路径有长度上限，临时目录的名字要短
const root = mkdtempSync(join(tmpdir(), 'litch-bx-'))
const dirs = {
  home: join(root, 'home'),
  agent: join(root, 'agent'),
  work: join(root, 'work'),
  state: join(root, 'h/pi'),
  device: join(root, 'h/device'),
}
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
const sockets = {
  direct: join(dirs.state, 'runtime.sock'),
  device: join(dirs.device, 'device.sock'),
}

const now = () => process.hrtime.bigint()
const elapsedMs = (from, to = now()) => Number(to - from) / 1e6
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

// ---------- 假模型（单独的线程） ----------
const model = new Worker(new URL('./bench-router-model.mjs', import.meta.url))
/** 假模型报回来的：每个请求实际吐了多久 */
const emitted = []
const modelWaiters = new Map()
model.on('message', (message) => {
  if (message.type === 'emitted') emitted.push(message)
  modelWaiters.get(message.type)?.(message)
})
const modelSays = (type) => new Promise((done) => modelWaiters.set(type, done))
const { port: modelPort } = await modelSays('listening')
async function setPlan(deltas, intervalMs) {
  const planned = modelSays('planned')
  model.postMessage({ type: 'plan', deltas, intervalMs })
  await planned
}

writeFileSync(
  join(dirs.agent, 'models.json'),
  JSON.stringify({
    providers: {
      gate: {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        api: 'openai-completions',
        apiKey: 'fixture-only',
        models: [
          {
            id: 'gate',
            name: 'Gate',
            reasoning: false,
            input: ['text'],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
)
writeFileSync(
  join(dirs.agent, 'settings.json'),
  JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
)

// ---------- 子进程 ----------
// 预装的那一小段：父进程发来消息就把 CPU 读数发回去
const CPU_PROBE = `data:text/javascript,${encodeURIComponent(
  "process.on('message',()=>process.send(process.cpuUsage()))",
)}`
const children = []
const logs = new Map()
let cleaning = false

function launch(name, args, env) {
  const child = spawn(process.execPath, ['--import', CPU_PROBE, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  child.stderr.on('data', (data) => logs.set(name, ((logs.get(name) ?? '') + data).slice(-4000)))
  child.on('exit', (code, signal) => {
    if (cleaning) return
    void cleanup(1, `${name} 退出了（${signal ?? `退出码 ${code}`}）\n${logs.get(name) ?? ''}`)
  })
  return child
}

/** 一个子进程到现在用掉的 CPU 时间（毫秒，用户态加内核态） */
const cpuMs = (child) =>
  new Promise((done) => {
    child.once('message', (usage) => done((usage.user + usage.system) / 1000))
    child.send({})
  })

/** 先客气地结束，等一会儿还在就强杀；等它真的退出了再往下走，免得留下进程 */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.once('exit', () => {
      clearTimeout(force)
      done()
    })
    child.kill('SIGTERM')
  })
}

async function cleanup(code, detail) {
  if (cleaning) return
  cleaning = true
  if (detail) console.error(detail)
  await Promise.all(children.map(stop))
  await model.terminate()
  rmSync(root, { recursive: true, force: true })
  process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void cleanup(1))

// 环境只给必需的几项，不继承用户的任何凭据和配置
const baseEnv = { PATH: process.env.PATH, HOME: dirs.home, TMPDIR: root }
const engine = launch('pi', [engineMain, 'app-server', '--listen', `unix://${sockets.direct}`], {
  ...baseEnv,
  CHA_PI_HOME: dirs.state,
  PI_CODING_AGENT_DIR: dirs.agent,
  PI_CLI: piCli,
})

// ---------- 客户端 ----------
class Client {
  constructor(ws, extra) {
    this.ws = ws
    /** 这种接法下每个不带会话标识的请求要另外带的参数（聚合面要用 harness 指路） */
    this.extra = extra
    this.nextId = 1
    this.pending = new Map()
    /** 收到一条通知：frame 是解析后的消息，at 是收到那一刻的钟 */
    this.listen = null
    ws.on('message', (data) => {
      const at = now()
      const frame = JSON.parse(data.toString())
      if (frame.method !== undefined) {
        // 量的这几样里对面不该有请求过来；真有就回错误，不让它等
        if (frame.id !== undefined)
          ws.send(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'bench' } }))
        else this.listen?.(frame, at)
        return
      }
      const entry = this.pending.get(frame.id)
      this.pending.delete(frame.id)
      if (frame.error) entry?.fail(new Error(`${entry.method}：${frame.error.message}`))
      else entry?.done({ result: frame.result, at, bytes: data.length })
    })
  }

  /** 连到 unix 套接字上的入口。路径不写进地址（会被转义），地址只是摆设 */
  static async open(path, extra) {
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const ws = await new Promise((done, fail) => {
          const socket = new WebSocket('ws://localhost/', {
            perMessageDeflate: false,
            createConnection: () => net.createConnection(path),
          })
          socket.once('open', () => done(socket))
          socket.once('error', fail)
        })
        const client = new Client(ws, extra)
        // 两种接法握手时声明的一样：聚合面会把客户端的声明原样带给运行时，直连时也这样报，运行时发的东西才相同
        await client.call('initialize', {
          clientInfo: { name: 'litch-bench', title: null, version: '0.0.0' },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            litchExtensions: ['harness'],
          },
        })
        ws.send(JSON.stringify({ method: 'initialized' }))
        return client
      } catch {
        await pause(100)
      }
    }
    throw new Error(`等了 30 秒，${path} 还连不上`)
  }

  /** 发一个请求，返回应答、收到应答那一刻的钟、应答在线上有多大 */
  timed(method, params = {}) {
    return new Promise((done, fail) => {
      const id = this.nextId++
      this.pending.set(id, { done, fail, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async call(method, params) {
    return (await this.timed(method, params)).result
  }
}

// ---------- 量 ----------
/** 排好序的一组数里的分位数（就近取，不插值） */
const quantile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
const median = (values) => quantile(Float64Array.from(values).sort(), 0.5)
function summarize(values) {
  const sorted = Float64Array.from(values).sort()
  return {
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  }
}

/** 开 sessions 个会话，同时各跑一个回合，量每条增量从假模型到客户端用了多久 */
async function streamRound(client, sessions, deltas, intervalMs) {
  await setPlan(deltas, intervalMs)
  const threads = []
  for (let index = 0; index < sessions; index++) {
    const params = { cwd: dirs.work, model: 'gate/gate', ...client.extra }
    threads.push((await client.call('thread/start', params)).thread.id)
  }
  const latencies = []
  const partial = new Map()
  const failures = []
  let frames = 0
  let left = sessions
  const finished = new Promise((done) => {
    client.listen = (frame, at) => {
      // 新建会话的通知有时落在应答后面、赶到这里来，它不是这个回合的
      if (frame.method === 'thread/started') return
      frames++
      const params = frame.params
      if (frame.method === 'item/agentMessage/delta') {
        // 一条通知里通常正好是一个记号；万一被拆开或者并在一起，按分号切
        let text = (partial.get(params.threadId) ?? '') + params.delta
        for (let end = text.indexOf(';'); end >= 0; end = text.indexOf(';')) {
          latencies.push(elapsedMs(BigInt(text.slice(text.indexOf('@') + 1, end)), at))
          text = text.slice(end + 1)
        }
        partial.set(params.threadId, text)
      } else if (frame.method === 'turn/completed') {
        if (params.turn.status !== 'completed')
          failures.push(`${params.turn.status}（${params.turn.error?.message ?? '没有说原因'}）`)
        if (--left === 0) done(at)
      }
    }
  })
  emitted.length = 0
  const before = await Promise.all([cpuMs(device), cpuMs(engine)])
  const started = now()
  const input = [{ type: 'text', text: 'bench' }]
  await Promise.all(threads.map((threadId) => client.call('turn/start', { threadId, input })))
  let timer
  const ended = await Promise.race([
    finished,
    new Promise((_, fail) => {
      timer = setTimeout(
        () => fail(new Error('回合一直没有结束')),
        deltas * (intervalMs + 5) + 60_000,
      )
    }),
  ])
  clearTimeout(timer)
  client.listen = null
  const after = await Promise.all([cpuMs(device), cpuMs(engine)])
  // 先看回合有没有出错：出了错的那个请求假模型可能根本没收到，下面就等不到它报“吐完了”
  if (failures.length) throw new Error(`回合没有正常结束：${failures.join('、')}`)
  // 假模型报“吐完了”和回合结束是两条路，谁先到不一定
  while (emitted.length < sessions) await pause(1)
  if (latencies.length !== sessions * deltas)
    throw new Error(`该收到 ${sessions * deltas} 条增量，实际 ${latencies.length} 条`)
  return {
    threads,
    ...summarize(latencies),
    totalMs: elapsedMs(started, ended),
    emitMs: Math.max(...emitted.map((item) => item.emitMs)),
    frames,
    deviceCpuMs: after[0] - before[0],
    engineCpuMs: after[1] - before[1],
  }
}

/** 一次一个地发 requests 个请求，量每个从发出到收到应答用了多久 */
async function rttRound(client, method, params, requests) {
  const samples = new Float64Array(requests)
  let bytes = 0
  const before = await Promise.all([cpuMs(device), cpuMs(engine)])
  for (let index = 0; index < requests; index++) {
    const sent = now()
    const reply = await client.timed(method, params)
    samples[index] = elapsedMs(sent, reply.at)
    bytes = reply.bytes
  }
  const after = await Promise.all([cpuMs(device), cpuMs(engine)])
  return {
    ...summarize(samples),
    bytes,
    deviceCpuMs: after[0] - before[0],
    engineCpuMs: after[1] - before[1],
  }
}

// ---------- 起设备进程，两种接法各连一条 ----------
// 启动命令行和 Go 层拉起它时用的一样
const device = launch(
  'device',
  [
    deviceMain,
    ...['--listen', `unix://${sockets.device}`, '--state', dirs.device],
    ...['--upstream', `pi=unix://${sockets.direct}`],
  ],
  baseEnv,
)
await new Promise((done) => {
  let output = ''
  device.stdout.on('data', (data) => {
    output += data
    if (output.split('\n').includes('LITCH_DEVICE_READY')) done()
  })
})
engine.stdout.resume()

const paths = [
  { key: 'direct', label: '直连', client: await Client.open(sockets.direct, {}) },
  {
    key: 'device',
    label: '经设备进程',
    client: await Client.open(sockets.device, { harness: 'pi' }),
  },
]
const info = await paths[1].client.call('runtime/info')
const unavailable = info.harnesses.find((harness) => harness.id === 'pi')?.unavailable
if (unavailable) await cleanup(1, `聚合面上的 Pi 不可用：${unavailable.message}`)

/** 两种接法轮流先跑，各跑 ROUNDS 轮 */
async function compare(run) {
  const rounds = { direct: [], device: [] }
  for (let round = 0; round < ROUNDS; round++) {
    const order = round % 2 === 0 ? paths : [...paths].reverse()
    for (const path of order) rounds[path.key].push(await run(path))
  }
  return rounds
}

// ---------- 结果 ----------
/** 按显示宽度补齐，汉字算两格 */
function cell(text, width) {
  const shown = [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
  return text + ' '.repeat(Math.max(0, width - shown))
}
const number = (value, digits) => value.toFixed(digits).padStart(12)
const load = () =>
  loadavg()
    .map((value) => value.toFixed(2))
    .join(' ')

const report = { options: { DELTAS, SESSIONS, REQUESTS, ROUNDS, INTERVALS }, scenarios: [] }

/** rows：[标题, 结果里的键, 小数位数] */
function print(title, rounds, rows) {
  report.scenarios.push({ title, rounds })
  console.log(`\n${title}（${ROUNDS} 轮，各项是各轮的中位）`)
  console.log(`  ${cell('', 22)}        直连  经设备进程          差`)
  for (const [label, key, digits] of rows) {
    const direct = median(rounds.direct.map((round) => round[key]))
    const routed = median(rounds.device.map((round) => round[key]))
    const gap = `${routed < direct ? '' : '+'}${(routed - direct).toFixed(digits)}`
    console.log(
      `  ${cell(label, 22)}${number(direct, digits)}${number(routed, digits)}${gap.padStart(12)}`,
    )
  }
}

const STREAM_ROWS = [
  ['延迟 中位数 ms', 'median', 3],
  ['延迟 p95 ms', 'p95', 3],
  ['延迟 p99 ms', 'p99', 3],
  ['延迟 最大 ms', 'max', 3],
  ['回合总时长 ms', 'totalMs', 1],
  ['假模型吐完用时 ms', 'emitMs', 1],
  ['客户端收到的帧数', 'frames', 0],
  ['设备进程 CPU ms', 'deviceCpuMs', 1],
  ['运行时 CPU ms', 'engineCpuMs', 1],
]
const RTT_ROWS = [
  ['往返 中位数 ms', 'median', 3],
  ['往返 p95 ms', 'p95', 3],
  ['往返 p99 ms', 'p99', 3],
  ['往返 最大 ms', 'max', 3],
  ['应答大小 字节', 'bytes', 0],
  ['设备进程 CPU ms', 'deviceCpuMs', 1],
  ['运行时 CPU ms', 'engineCpuMs', 1],
]

// ---------- 跑 ----------
try {
  report.loadBefore = loadavg()
  console.log(
    `Node ${process.version}，系统负载 ${load()}；${DELTAS} 条增量，${ROUNDS} 轮，往返 ${REQUESTS} 次`,
  )
  // 先各跑一遍不计数的：让运行时和设备进程把代码跑热，顺手各留一个会话给 thread/read 用
  const warm = {}
  for (const path of paths) {
    const round = await streamRound(path.client, 1, Math.min(DELTAS, 500), 0)
    warm[path.key] = round.threads[0]
    await rttRound(path.client, 'thread/list', { limit: 50 }, 100)
  }

  // 往返放在最前面量：这时候会话只有上面那两个，列表的大小在各轮之间不变
  const list = { limit: 50, sortKey: 'updated_at', sortDirection: 'desc' }
  print(
    `请求往返：thread/list × ${REQUESTS}（聚合面上由设备层合并）`,
    await compare((path) => rttRound(path.client, 'thread/list', list, REQUESTS)),
    RTT_ROWS,
  )
  print(
    `请求往返：thread/read × ${REQUESTS}（聚合面上按会话转发）`,
    await compare((path) =>
      rttRound(
        path.client,
        'thread/read',
        { threadId: warm[path.key], includeTurns: false },
        REQUESTS,
      ),
    ),
    RTT_ROWS,
  )
  /** 两种接法各自最近跑完的一个会话，里面有一条 DELTAS 个记号那么长的回答 */
  const long = {}
  for (const sessions of new Set([1, SESSIONS]))
    for (const intervalMs of INTERVALS)
      print(
        `流式：${sessions} 个会话同时，各 ${DELTAS} 条增量，间隔 ${intervalMs} 毫秒`,
        await compare(async (path) => {
          const round = await streamRound(path.client, sessions, DELTAS, intervalMs)
          long[path.key] = round.threads[0]
          return round
        }),
        STREAM_ROWS,
      )
  // 带会话对象的应答，聚合面要整包解析、换上设备层的归属再整包写出去：拿一个大的量它
  const BIG = Math.max(1, Math.round(REQUESTS / 5))
  print(
    `请求往返：thread/read 带全部回合 × ${BIG}（大应答，聚合面上要改写会话对象）`,
    await compare((path) =>
      rttRound(path.client, 'thread/read', { threadId: long[path.key], includeTurns: true }, BIG),
    ),
    RTT_ROWS,
  )
  report.loadAfter = loadavg()
  console.log(`\n结束时系统负载 ${load()}`)
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await cleanup(0)
} catch (error) {
  await cleanup(1, `没有量成：${error?.stack ?? error}\n${[...logs.values()].join('\n')}`)
}
