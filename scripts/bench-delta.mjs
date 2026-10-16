// 量 Pi 入口处理流式增量的开销随回答变长怎么涨：一个回答越长，每条增量是不是越贵。
// 隔离的 Pi 运行时加回环上的假模型（scripts/bench-delta-model.mjs），同一种增量按几种条数各跑几轮。
// 全在临时目录里，不碰用户的会话和状态目录，不用任何模型凭据；不进流水线，要量的时候手工跑。
//
// 用法：npm run bench:delta -- [选项]（会先构建；已经构建过的可以直接 node scripts/bench-delta.mjs [选项]）
//   --entry 入口     量哪个入口：pi（默认，就是这份脚本）、claude（转给 scripts/bench-delta-claude.mjs，
//                    选项相同，另要用 CHA_CLAUDE_CLI 指一份隔离的 Claude Code CLI，量法写在那一份开头）
//   --deltas A,B,C   一个回答里假模型吐多少条增量，每个值各量一组（默认 1000,3000,10000,30000）
//   --chars A,B      每条增量多少个字，每个值各量一组（默认 4,40）
//   --kind 种类      增量是什么：text 正文（默认）、thinking 思考、tool 一次 write 工具调用的参数，
//                    或者 calls：不是增量，是一个回合里连着调很多次工具、每次的结果都很大（每次读同一个文件），
//                    量条目的增减随回合变长怎么涨。这时 --deltas 是调用的次数（默认 100,300），
//                    --chars 是文件有多少个字（默认 20000），“每条”是每次调用
//   --interval N     增量之间隔多少毫秒（默认 0，一条接一条不等）
//   --rounds N       每组跑几轮，报的是各轮的中位（默认 3）
//   --cpu-prof 目录  运行时带着 Node 的采样剖析跑，退出时把热点写进这个目录（.cpuprofile，
//                    用开发者工具或 scripts/bench-delta-hot.mjs 看）；带着它量到的数偏大，只用来找热点
//   --json 文件      把每一轮的原始结果另存一份
//   --engine 文件    运行时的入口，默认是仓库里构建出来的 packages/pi/dist/pi/src/adapter.mjs；
//                    要和另一份构建对照时指过去（那一份要放在 packages/pi 下面，才找得到依赖）
//
// 量法：
//   CPU    运行时进程的 process.cpuUsage()，回合前后各取一次相减（用户态加内核态）。
//          “每条”是它除以条数：回合本身的固定开销（开头那一行“空回合”量的就是它）也摊在里面，
//          条数少的时候占得多。线性的话各种条数下“每条”差不多；随条数涨就是有和已有长度成正比的活。
//   总时长 从发出 turn/start 到收到 turn/completed，就是客户端收齐这个回答要多久。旁边那一栏是假模型
//          吐完用了多久：运行时跟不上假模型时，总时长比它多出来的就是运行时里的积压。
//   核对   假模型把吐出去的全文的长度和摘要报回来。客户端把收到的增量接起来算一遍，
//          回合结束后再读一次会话（thread/read）把落库的那一条算一遍，三个要一样。
// 机器忙的时候 CPU 时间也会偏大（缓存被挤、核被抢），结果开头和末尾各印一次系统负载。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { WebSocket } from 'ws'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const ENTRY = option('entry', 'pi')
if (!['pi', 'claude'].includes(ENTRY)) throw new Error('--entry 只能是 pi、claude')
// Claude 入口是另一份脚本量的（中间隔着真的 CLI，假模型说的协议也不一样）；它量完自己退出，不会回到这里
if (ENTRY === 'claude') await import('./bench-delta-claude.mjs')
const engineMain = resolve(option('engine', join(repo, 'packages/pi/dist/pi/src/adapter.mjs')))
if (!existsSync(engineMain)) {
  console.error(`没有找到运行时的入口 ${engineMain}，请先运行 npm run build`)
  process.exit(1)
}
const piPackage = join(repo, 'packages/pi/node_modules/@earendil-works/pi-coding-agent')
const piEntry = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).main
const piCli = join(piPackage, dirname(piEntry), 'cli.js')

/** 用逗号隔开的一组数，每个都不小于 least */
function numbers(name, fallback, least) {
  const values = String(option(name, fallback)).split(',').map(Number)
  if (values.some((value) => !Number.isInteger(value) || value < least))
    throw new Error(`--${name} 要写成用逗号隔开的整数，每个不小于 ${least}`)
  return values
}
const KIND = option('kind', 'text')
if (!['text', 'thinking', 'tool', 'calls'].includes(KIND))
  throw new Error('--kind 只能是 text、thinking、tool、calls')
const CALLS = KIND === 'calls'
const DELTAS = numbers('deltas', CALLS ? '100,300' : '1000,3000,10000,30000', 1)
const CHARS = numbers('chars', CALLS ? '20000' : '4,40', 1)
const [INTERVAL] = numbers('interval', '0', 0)
const [ROUNDS] = numbers('rounds', '3', 1)
const profDir = option('cpu-prof', null)
const jsonPath = option('json', null)

// 套接字路径有长度上限，临时目录的名字要短
const root = mkdtempSync(join(tmpdir(), 'litch-bd-'))
const dirs = {
  home: join(root, 'home'),
  agent: join(root, 'agent'),
  work: join(root, 'work'),
  state: join(root, 'h/pi'),
}
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
const socket = join(dirs.state, 'runtime.sock')

const now = () => process.hrtime.bigint()
const elapsedMs = (from, to = now()) => Number(to - from) / 1e6
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// ---------- 假模型（单独的线程） ----------
const model = new Worker(new URL('./bench-delta-model.mjs', import.meta.url))
/** 假模型报回来的：每个请求吐出去的全文多长、摘要是什么、吐了多久 */
const emitted = []
const modelWaiters = new Map()
model.on('message', (message) => {
  if (message.type === 'emitted') emitted.push(message)
  modelWaiters.get(message.type)?.(message)
})
const modelSays = (type) => new Promise((done) => modelWaiters.set(type, done))
const { port: modelPort } = await modelSays('listening')
async function setPlan(deltas, chars, kind = KIND) {
  const planned = modelSays('planned')
  model.postMessage({ type: 'plan', deltas, chars, kind, intervalMs: INTERVAL })
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
            reasoning: KIND === 'thinking',
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
  JSON.stringify({
    defaultProvider: 'gate',
    defaultModel: 'gate',
    retry: { enabled: false },
    // 假模型报的用量是假的，自动压缩不该来插一脚；量 calls 时回合里的工具结果有几兆
    compaction: { enabled: false },
  }),
)

// ---------- 运行时 ----------
// 预装的那一小段：父进程发来消息就把 CPU 读数发回去
const CPU_PROBE = `data:text/javascript,${encodeURIComponent(
  "process.on('message',()=>process.send(process.cpuUsage()))",
)}`
let log = ''
let cleaning = false
if (profDir) mkdirSync(resolve(profDir), { recursive: true })
const engine = spawn(
  process.execPath,
  [
    ...(profDir ? ['--cpu-prof', '--cpu-prof-dir', resolve(profDir)] : []),
    ...['--import', CPU_PROBE],
    ...[engineMain, 'app-server', '--listen', `unix://${socket}`],
  ],
  {
    // 环境只给必需的几项，不继承用户的任何凭据和配置
    env: {
      PATH: process.env.PATH,
      HOME: dirs.home,
      TMPDIR: root,
      CHA_PI_HOME: dirs.state,
      PI_CODING_AGENT_DIR: dirs.agent,
      PI_CLI: piCli,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  },
)
engine.stdout.resume()
engine.stderr.on('data', (data) => {
  log = (log + data).slice(-4000)
})
engine.on('exit', (code, signal) => {
  if (!cleaning) void cleanup(1, `运行时退出了（${signal ?? `退出码 ${code}`}）\n${log}`)
})

/** 运行时到现在用掉的 CPU 时间（毫秒，用户态加内核态） */
const cpuMs = () =>
  new Promise((done) => {
    engine.once('message', (usage) => done((usage.user + usage.system) / 1000))
    engine.send({})
  })

/** 先客气地结束（带着剖析时它要在退出前把结果写出来），等一会儿还在就强杀；等它真的退出了再往下走 */
function stopEngine() {
  if (engine.exitCode !== null || engine.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const force = setTimeout(() => engine.kill('SIGKILL'), profDir ? 30_000 : 3000)
    engine.once('exit', () => {
      clearTimeout(force)
      done()
    })
    engine.kill('SIGTERM')
  })
}

async function cleanup(code, detail) {
  if (cleaning) return
  cleaning = true
  if (detail) console.error(detail)
  await stopEngine()
  await model.terminate()
  rmSync(root, { recursive: true, force: true })
  process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void cleanup(1))

// ---------- 客户端 ----------
/** 连到 unix 套接字上的入口。路径不写进地址（会被转义），地址只是摆设 */
async function connect() {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return await new Promise((done, fail) => {
        const ws = new WebSocket('ws://localhost/', {
          perMessageDeflate: false,
          createConnection: () => net.createConnection(socket),
        })
        ws.once('open', () => done(ws))
        ws.once('error', fail)
      })
    } catch {
      await pause(100)
    }
  }
  throw new Error(`等了 30 秒，${socket} 还连不上`)
}
const ws = await connect()
let nextId = 1
const pending = new Map()
/** 收到一条通知：frame 是解析后的消息，at 是收到那一刻的钟 */
let listen = null
ws.on('message', (data) => {
  const at = now()
  const frame = JSON.parse(data.toString())
  if (frame.method !== undefined) {
    // 量的这几样里对面不该有请求过来；真有就回错误，不让它等
    if (frame.id !== undefined)
      ws.send(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'bench' } }))
    else listen?.(frame, at)
    return
  }
  const entry = pending.get(frame.id)
  pending.delete(frame.id)
  if (frame.error) entry?.fail(new Error(`${entry.method}：${frame.error.message}`))
  else entry?.done(frame.result)
})
const call = (method, params = {}) =>
  new Promise((done, fail) => {
    const id = nextId++
    pending.set(id, { done, fail, method })
    ws.send(JSON.stringify({ id, method, params }))
  })
await call('initialize', {
  clientInfo: { name: 'litch-bench', title: null, version: '0.0.0' },
  capabilities: { experimentalApi: true, requestAttestation: false },
})
ws.send(JSON.stringify({ method: 'initialized' }))

// ---------- 量 ----------
/** 三种增量各自到客户端是哪条通知；工具调用的参数不往客户端发增量，只有条目的开始和完成 */
const DELTA_METHOD = {
  text: 'item/agentMessage/delta',
  thinking: 'item/reasoning/summaryTextDelta',
  tool: null,
  calls: null,
}
/** calls 那种让模型反复读的文件（在工作目录里），名字和假模型里的一样 */
const CALLS_FILE = 'bench-read.txt'
/** 一个 chars 个字的文件：一行六十个字上下，别超过 Pi 的 read 一次给的量（两千行、50KB），它就原样给回来 */
function callsFile(chars) {
  const line = '读到的这一行是工具结果的一部分，回合里每次调用都把它带回来。const n = 42;\n'
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars)
}
/** 回合结束后落库的那一条里的全文 */
function storedText(turn, kind) {
  if (kind === 'thinking') return turn.items.find((item) => item.type === 'reasoning')?.summary[0]
  // 新写的文件，条目上放的是文件正文
  if (kind === 'tool')
    return turn.items.find((item) => item.type === 'fileChange')?.changes[0]?.diff
  return turn.items.find((item) => item.type === 'agentMessage')?.text
}

/** 新开一个会话跑一个回合：假模型吐 deltas 条、每条 chars 个字（calls 是调 deltas 次工具、每次读 chars 个字） */
async function round(deltas, chars, kind = KIND) {
  const file = kind === 'calls' ? callsFile(chars) : null
  if (file !== null) writeFileSync(join(dirs.work, CALLS_FILE), file)
  await setPlan(deltas, chars, kind)
  const threadId = (await call('thread/start', { cwd: dirs.work, model: 'gate/gate' })).thread.id
  const method = DELTA_METHOD[kind]
  let received = 0
  let frames = 0
  const hash = createHash('sha256')
  let failure = null
  const finished = new Promise((done) => {
    listen = (frame, at) => {
      // 新建会话的通知有时落在应答后面、赶到这里来，它不是这个回合的
      if (frame.method === 'thread/started') return
      frames++
      if (frame.method === method) {
        received++
        hash.update(frame.params.delta)
      } else if (frame.method === 'turn/completed') {
        const turn = frame.params.turn
        if (turn.status !== 'completed')
          failure = `${turn.status}（${turn.error?.message ?? '没有说原因'}）`
        done(at)
      }
    }
  })
  emitted.length = 0
  const before = await cpuMs()
  const started = now()
  await call('turn/start', { threadId, input: [{ type: 'text', text: 'bench' }] })
  let timer
  const ended = await Promise.race([
    finished,
    new Promise((_, fail) => {
      timer = setTimeout(
        () => fail(new Error('回合一直没有结束')),
        deltas * (kind === 'calls' ? 1000 : INTERVAL + 20) + 120_000,
      )
    }),
  ])
  clearTimeout(timer)
  listen = null
  const engineCpuMs = (await cpuMs()) - before
  // 先看回合有没有出错：出了错的那个请求假模型可能根本没收到，下面就等不到它报“吐完了”
  if (failure) throw new Error(`回合没有正常结束：${failure}`)
  // 假模型报“吐完了”和回合结束是两条路，谁先到不一定
  while (emitted.length < 1) await pause(1)
  const sent = emitted[0]
  if (method && (received !== deltas || hash.digest('hex') !== sent.sha256))
    throw new Error(`客户端收到的增量和假模型吐的对不上（该有 ${deltas} 条，收到 ${received} 条）`)
  const thread = (await call('thread/read', { threadId, includeTurns: true })).thread
  if (file !== null) {
    // 调够了次数，落库的每次调用都带着整个文件
    const results = thread.turns
      .at(-1)
      .items.filter((item) => item.type === 'mcpToolCall')
      .map((item) => item.result?.content?.[0]?.text)
    if (sent.calls !== deltas || results.length !== deltas || results.some((text) => text !== file))
      throw new Error(`落库的调用和假模型发的对不上（该有 ${deltas} 次，各 ${chars} 个字）`)
    sent.length = chars * deltas
  } else {
    const stored = storedText(thread.turns.at(-1), kind)
    if (typeof stored !== 'string' || sha256(stored) !== sent.sha256)
      throw new Error(`落库的全文和假模型吐的对不上（该有 ${sent.length} 个字）`)
  }
  return {
    engineCpuMs,
    perDeltaUs: (engineCpuMs * 1000) / deltas,
    totalMs: elapsedMs(started, ended),
    emitMs: sent.emitMs,
    frames,
    length: sent.length,
  }
}

// ---------- 结果 ----------
const median = (values) => {
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.ceil(sorted.length / 2) - 1]
}
/** 按显示宽度补齐，汉字算两格 */
function cell(text, width) {
  const shown = [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
  return ' '.repeat(Math.max(0, width - shown)) + text
}
const load = () =>
  loadavg()
    .map((value) => value.toFixed(2))
    .join(' ')
const COLUMNS = [
  ['条数', (row) => String(row.deltas), 8],
  ['全文字数', (row) => String(row.length), 10],
  ['运行时 CPU ms', (row) => row.engineCpuMs.toFixed(1), 15],
  ['每条 µs', (row) => row.perDeltaUs.toFixed(1), 10],
  ['回合总时长 ms', (row) => row.totalMs.toFixed(1), 16],
  ['假模型吐完 ms', (row) => row.emitMs.toFixed(1), 16],
]

const report = {
  options: { DELTAS, CHARS, KIND, INTERVAL, ROUNDS, profiled: Boolean(profDir) },
  groups: [],
}
try {
  report.loadBefore = loadavg()
  console.log(
    `Node ${process.version}，系统负载 ${load()}；${CALLS ? '一个回合里连着调很多次工具（“条数”是调用次数，“字数”是全部结果加起来）' : `增量是${{ text: '正文', thinking: '思考', tool: '工具调用的参数' }[KIND]}`}，间隔 ${INTERVAL} 毫秒，每组 ${ROUNDS} 轮取中位${profDir ? '（带着采样剖析，数偏大）' : ''}`,
  )
  // 先跑两遍不计数的，把运行时的代码跑热
  for (let warm = 0; warm < 2; warm++) await round(CALLS ? 10 : 500, CHARS[0])
  // 只有一条增量的回合：回合本身的固定开销
  const idle = []
  for (let index = 0; index < Math.max(3, ROUNDS); index++)
    idle.push((await round(1, CHARS[0], 'text')).engineCpuMs)
  report.idleCpuMs = median(idle)
  console.log(`空回合（只有一条增量）运行时 CPU ${report.idleCpuMs.toFixed(1)} ms`)
  for (const chars of CHARS) {
    console.log(`\n${CALLS ? '每次调用的结果' : '每条'} ${chars} 个字`)
    console.log(`  ${COLUMNS.map(([title, , width]) => cell(title, width)).join('')}`)
    for (const deltas of DELTAS) {
      const rounds = []
      for (let index = 0; index < ROUNDS; index++) rounds.push(await round(deltas, chars))
      const row = { deltas }
      for (const key of Object.keys(rounds[0])) row[key] = median(rounds.map((item) => item[key]))
      report.groups.push({ chars, deltas, median: row, rounds })
      console.log(`  ${COLUMNS.map(([, show, width]) => cell(show(row), width)).join('')}`)
    }
  }
  report.loadAfter = loadavg()
  console.log(`\n结束时系统负载 ${load()}`)
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  if (profDir) console.log(`热点在 ${resolve(profDir)}（运行时退出时写出）`)
  await cleanup(0)
} catch (error) {
  await cleanup(1, `没有量成：${error?.stack ?? error}\n${log}`)
}
