// 量 Claude 入口处理流式增量的开销随回答变长怎么涨：一个回答越长，每条增量是不是越贵。
// 隔离的 Claude 入口加真的 Claude Code CLI 加回环上的假模型（scripts/bench-delta-claude-model.mjs），
// 同一种增量按几种条数各跑几轮。全在临时目录里，不碰用户的会话、状态目录和 Claude 配置，
// 不用任何模型凭据；不进流水线，要量的时候手工跑。
//
// 用法：CHA_CLAUDE_CLI=<隔离的 claude> npm run bench:delta -- --entry claude [选项]
//      （会先构建；已经构建过的可以直接 node scripts/bench-delta-claude.mjs [选项]）
// CLI 只用 CHA_CLAUDE_CLI 指的那一份，没设就不量，不会改用 PATH 里的 claude（那是用户自己在用的）。
//   --deltas A,B,C   一个回答里假模型吐多少条增量，每个值各量一组（默认 1000,3000,10000）
//   --chars A,B      每条增量多少个字，每个值各量一组（默认 4,40）
//   --kind 种类      增量是什么：text 正文（默认）、thinking 思考、tool 一次 Write 工具调用的参数；
//                    tools 不量增量，量的是一个回合里接连调很多次工具、每次结果都很大：--deltas 是调几次
//                    （默认 30,100,300），--chars 是每次结果多少个字（默认 20000）。每次都是 Bash 把同一个
//                    备好的文件 cat 出来，入口那头是一条命令条目的开始和完成，加一条带全部输出的增量
//   --interval N     增量之间隔多少毫秒（默认 0，一条接一条不等）
//   --rounds N       每组跑几轮，报的是各轮的中位（默认 3）
//   --cpu-prof 目录  入口带着 Node 的采样剖析跑，退出时把热点写进这个目录（.cpuprofile，
//                    用 scripts/bench-delta-hot.mjs 看）；带着它量到的数偏大，只用来找热点
//   --json 文件      把每一轮的原始结果另存一份
//   --engine 文件    入口的主文件，默认是仓库里构建出来的 packages/claude/dist/claude/src/adapter.mjs；
//                    要和另一份构建对照时指过去（那一份要放在某个 packages/claude 下面，才找得到依赖）
//
// 量法（一条增量要过三个进程才到这里：假模型 → Claude Code CLI → 守护进程 → 入口 → 这里。
// 守护进程是入口起的 native-process-guard，夹在中间转发 CLI 的输入输出；CLI 不是我们的代码，单独记）：
//   入口 CPU  入口进程的 process.cpuUsage()。守护进程和 CLI 的 CPU 是 ps 报的累计 CPU 时间（精度 10 毫秒；
//             回合结束后它们就退出了，所以隔一百毫秒读一次、取最后读到的）。三样都从假模型开吐那一刻
//             算到回合结束，起 CLI、握手这些回合固定的开销不在里面。“每条”是它除以条数：
//             线性的话各种条数下“每条”差不多；随条数涨就是有和已有长度成正比的活。
//   总时长    从发出 turn/start 到收到 turn/completed，就是客户端收齐这个回答要多久（含起 CLI 的时间）。
//             旁边是假模型吐完用了多久：比它多出来的是后面几个进程里的积压。
//   核对      假模型把吐出去的全文的长度和摘要报回来。客户端把收到的增量接起来算一遍，
//             回合结束后再读一次会话（thread/read）把落库的那一条算一遍，三个要一样。
// 机器忙的时候 CPU 时间也会偏大（缓存被挤、核被抢），结果开头和末尾各印一次系统负载。
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const engineMain = resolve(
  option('engine', join(repo, 'packages/claude/dist/claude/src/adapter.mjs')),
)
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

// 进程表里 CLI 的程序文件是解析符号链接之后的路径（npm 装出来的 .bin/claude 是个链接）
const cliProgram = realpathSync(claudeCli)

/** 用逗号隔开的一组数，每个都不小于 least */
function numbers(name, fallback, least) {
  const values = String(option(name, fallback)).split(',').map(Number)
  if (values.some((value) => !Number.isInteger(value) || value < least))
    throw new Error(`--${name} 要写成用逗号隔开的整数，每个不小于 ${least}`)
  return values
}
const KIND = option('kind', 'text')
if (!['text', 'thinking', 'tool', 'tools'].includes(KIND))
  throw new Error('--kind 只能是 text、thinking、tool、tools')
const TOOLS = KIND === 'tools'
const DELTAS = numbers('deltas', TOOLS ? '30,100,300' : '1000,3000,10000', 1)
const CHARS = numbers('chars', TOOLS ? '20000' : '4,40', 1)
const [INTERVAL] = numbers('interval', '0', 0)
const [ROUNDS] = numbers('rounds', '3', 1)
const profDir = option('cpu-prof', null)
const jsonPath = option('json', null)

// 套接字路径有长度上限，临时目录的名字要短
const root = mkdtempSync(join(tmpdir(), 'litch-bc-'))
const dirs = { home: join(root, 'home'), work: join(root, 'work'), state: join(root, 's') }
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
mkdirSync(join(dirs.home, 'claude'))
const socket = join(dirs.state, 'runtime.sock')

const now = () => process.hrtime.bigint()
const elapsedMs = (from, to = now()) => Number(to - from) / 1e6
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// ---------- 假模型（单独的线程） ----------
const model = new Worker(new URL('./bench-delta-claude-model.mjs', import.meta.url))
const modelWaiters = new Map()
model.on('message', (message) => modelWaiters.get(message.type)?.(message))
const modelSays = (type) => new Promise((done) => modelWaiters.set(type, done))
const { port: modelPort } = await modelSays('listening')
let files = 0
/**
 * tools：每次 cat 出来的文件的内容，chars 个字，首尾不是空白（CLI 会去掉命令输出末尾的换行）。
 * 只用 ASCII：CLI 把超过约 30KB 的命令输出存进文件、只交一段预览，汉字三个字节一个，两万字就超了
 */
function toolOutput(chars) {
  const line = 'line 42: const sum = (a, b) => a + b // the output of a long command\n'
  let text = ''
  for (let index = 0; index < chars - 1; index++) text += line[index % line.length]
  return `${text}.`
}
async function setPlan(deltas, chars, kind) {
  const planned = modelSays('planned')
  // 工具调用那一种写的文件、tools 那一种 cat 的文件，每个回合换一个名字
  const path = join(dirs.work, `bench-${++files}.txt`)
  if (kind === 'tools') writeFileSync(path, toolOutput(chars))
  model.postMessage({ type: 'plan', deltas, chars, kind, intervalMs: INTERVAL, path })
  await planned
}

// ---------- 入口 ----------
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
    // 环境只给必需的几项，不继承用户的任何凭据和配置；模型端只有回环上的假模型
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dirs.home,
      TMPDIR: root,
      CODEX_HOME: join(dirs.home, 'codex'),
      CHA_CLAUDE_HOME: dirs.state,
      CLAUDE_CONFIG_DIR: join(dirs.home, 'claude'),
      CHA_CLAUDE_CLI: claudeCli,
      ANTHROPIC_API_KEY: 'bench-not-a-secret',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CHA_CLAUDE_DEFAULT_MODEL: 'claude-sonnet-4-6',
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  },
)
engine.stdout.resume()
engine.stderr.on('data', (data) => {
  log = (log + data).slice(-4000)
})
engine.on('exit', (code, signal) => {
  if (!cleaning) void cleanup(1, `入口退出了（${signal ?? `退出码 ${code}`}）\n${log}`)
})

/** 入口到现在用掉的 CPU 时间（毫秒，用户态加内核态） */
const cpuMs = () =>
  new Promise((done) => {
    engine.once('message', (usage) => done((usage.user + usage.system) / 1000))
    engine.send({})
  })
const ps = (args) =>
  new Promise((done) => execFile('ps', args, (_error, stdout) => done(String(stdout ?? ''))))
/** 进程表：给一个进程号，回它现在的子进程（进程号和程序文件） */
async function processTree() {
  const rows = (await ps(['-axo', 'pid=,ppid=,comm='])).split('\n')
  const table = rows.flatMap((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), program: match[3] }] : []
  })
  return (parent) => table.filter((row) => row.parent === parent)
}
/** 几个进程到现在各用掉多少 CPU（毫秒）；已经不在了的没有。ps 报的是 [时:]分:秒.百分秒 */
async function cpuOf(pids) {
  const usage = new Map()
  for (const row of (await ps(['-o', 'pid=,time=', '-p', pids.join(',')])).split('\n')) {
    const [pid, time] = row.trim().split(/\s+/)
    const seconds = time?.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
    if (time) usage.set(Number(pid), seconds * 1000)
  }
  return usage
}

/** 先客气地结束（带着剖析时它要在退出前把结果写出来），等一会儿还在就强杀；等它真的退出了再往下走 */
function stopEngine() {
  if (engine.exitCode !== null || engine.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const force = setTimeout(() => engine.kill('SIGKILL'), profDir ? 30_000 : 10_000)
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
  capabilities: { experimentalApi: true },
})
ws.send(JSON.stringify({ method: 'initialized' }))

// ---------- 量 ----------
/**
 * 几种增量各自到客户端是哪条通知；工具调用的参数不往客户端发增量，只有条目的开始和完成。
 * tools 的每次调用是一条命令的输出（原生运行时里命令的输出不是流式的，工具跑完随结果一次给）
 */
const DELTA_METHOD = {
  text: 'item/agentMessage/delta',
  thinking: 'item/reasoning/summaryTextDelta',
  tool: null,
  tools: 'item/commandExecution/outputDelta',
}
/** 回合结束后落库的那一条里的全文 */
function storedText(turn, kind) {
  if (kind === 'thinking') return turn.items.find((item) => item.type === 'reasoning')?.summary[0]
  if (kind === 'tools')
    return turn.items
      .filter((item) => item.type === 'commandExecution')
      .map((item) => item.aggregatedOutput)
      .join('')
  // 新写的文件，条目上放的是文件正文（落到盘上的那一份 CLI 会动末尾的空白，不拿它比）
  if (kind === 'tool')
    return turn.items.find((item) => item.type === 'fileChange')?.changes[0]?.diff
  return turn.items.find((item) => item.type === 'agentMessage')?.text
}

/** 新开一个会话跑一个回合：假模型吐 deltas 条、每条 chars 个字 */
async function round(deltas, chars, kind = KIND) {
  await setPlan(deltas, chars, kind)
  const threadId = (
    await call('thread/start', {
      cwd: dirs.work,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
  ).thread.id
  const method = DELTA_METHOD[kind]
  let received = 0
  let frames = 0
  const hash = createHash('sha256')
  let failure = null
  const finished = new Promise((done) => {
    listen = (frame, at) => {
      frames++
      if (frame.method === method) {
        received++
        hash.update(frame.params.delta)
      } else if (frame.method === 'turn/completed' && frame.params.threadId === threadId) {
        const turn = frame.params.turn
        if (turn.status !== 'completed')
          failure = `${turn.status}（${turn.error?.message ?? '没有说原因'}）`
        done(at)
      }
    }
  })
  const before = new Set((await processTree())(engine.pid).map((row) => row.pid))
  const streaming = modelSays('streaming')
  const emitted = modelSays('emitted')
  const started = now()
  await call('turn/start', { threadId, input: [{ type: 'text', text: 'bench' }] })
  let timer
  const overdue = new Promise((_, fail) => {
    timer = setTimeout(
      () => fail(new Error('回合一直没有结束')),
      // tools 每次调用都要 CLI 带着越来越长的对话再问一次，给得宽一些
      deltas * (TOOLS ? 2000 : INTERVAL + 20) + 180_000,
    )
  })
  // 假模型收到要量的那个请求、还没开吐：这一刻给三个进程的 CPU 读数打底，再放行
  await Promise.race([streaming, finished, overdue])
  if (failure) throw new Error(`回合没有正常结束：${failure}`)
  // 入口起的是守护进程（native-process-guard，夹在中间转发 CLI 的输入输出），CLI 是它的子进程
  const childrenOf = await processTree()
  const guard = childrenOf(engine.pid).findLast((row) => !before.has(row.pid))?.pid
  // 守护进程自己还会起别的子进程（隔一阵看一次进程表的 ps），按程序文件认 CLI
  const cli = guard && childrenOf(guard).find((row) => row.program === cliProgram)?.pid
  if (!cli) throw new Error('没有找到这个回合的 CLI 进程')
  const base = await cpuOf([guard, cli])
  const last = new Map(base)
  // CLI 在回合结束后就退出：隔一阵读一次，留着读到过的最大的
  // （退出了还没被收走的进程 ps 报的是 0，不能拿它盖掉前面读到的）
  const sample = async () => {
    for (const [pid, used] of await cpuOf([guard, cli]))
      if (used > last.get(pid)) last.set(pid, used)
  }
  const sampler = setInterval(sample, 100)
  const engineBase = await cpuMs()
  const streamStarted = now()
  model.postMessage({ type: 'go' })
  let ended
  try {
    ended = await Promise.race([finished, overdue])
  } finally {
    clearTimeout(timer)
    clearInterval(sampler)
  }
  listen = null
  const engineCpuMs = (await cpuMs()) - engineBase
  await sample()
  // 先看回合有没有出错：出了错的那个请求假模型可能根本没吐完，下面就等不到它报“吐完了”
  if (failure) throw new Error(`回合没有正常结束：${failure}`)
  const sent = await emitted
  if (kind === 'tools') {
    // 全文是每次 cat 出来的那个文件接起来
    const whole = toolOutput(chars).repeat(deltas)
    Object.assign(sent, { length: whole.length, sha256: sha256(whole) })
  }
  if (method && (received !== deltas || hash.digest('hex') !== sent.sha256))
    throw new Error(`客户端收到的增量和假模型吐的对不上（该有 ${deltas} 条，收到 ${received} 条）`)
  const thread = (await call('thread/read', { threadId, includeTurns: true })).thread
  const stored = storedText(thread.turns.at(-1), kind)
  if (typeof stored !== 'string' || sha256(stored) !== sent.sha256)
    throw new Error(`落库的全文和假模型吐的对不上（该有 ${sent.length} 个字）`)
  const cliCpuMs = last.get(cli) - base.get(cli)
  const guardCpuMs = last.get(guard) - base.get(guard)
  return {
    engineCpuMs,
    perDeltaUs: (engineCpuMs * 1000) / deltas,
    cliCpuMs,
    cliPerDeltaUs: (cliCpuMs * 1000) / deltas,
    guardCpuMs,
    guardPerDeltaUs: (guardCpuMs * 1000) / deltas,
    totalMs: elapsedMs(started, ended),
    streamMs: elapsedMs(streamStarted, ended),
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
  ['入口 CPU ms', (row) => row.engineCpuMs.toFixed(1), 13],
  ['每条 µs', (row) => row.perDeltaUs.toFixed(1), 10],
  ['守护 CPU ms', (row) => row.guardCpuMs.toFixed(0), 13],
  ['每条 µs', (row) => row.guardPerDeltaUs.toFixed(1), 9],
  ['CLI CPU ms', (row) => row.cliCpuMs.toFixed(0), 12],
  ['每条 µs', (row) => row.cliPerDeltaUs.toFixed(1), 9],
  ['回合总时长 ms', (row) => row.totalMs.toFixed(0), 15],
  ['开吐到结束 ms', (row) => row.streamMs.toFixed(0), 15],
  ['假模型吐完 ms', (row) => row.emitMs.toFixed(0), 15],
]

const report = {
  options: { DELTAS, CHARS, KIND, INTERVAL, ROUNDS, profiled: Boolean(profDir) },
  groups: [],
}
try {
  report.loadBefore = loadavg()
  console.log(
    `Node ${process.version}，系统负载 ${load()}；增量是${{ text: '正文', thinking: '思考', tool: '工具调用的参数', tools: '一次次的工具调用（条数是调用次数）' }[KIND]}，间隔 ${INTERVAL} 毫秒，每组 ${ROUNDS} 轮取中位${profDir ? '（带着采样剖析，数偏大）' : ''}`,
  )
  // 先跑两遍不计数的，把入口的代码跑热
  for (let warm = 0; warm < 2; warm++) await round(TOOLS ? 10 : 500, CHARS[0])
  // 只有一条增量的回合：从开吐到回合结束的固定开销
  const idle = []
  for (let index = 0; index < Math.max(3, ROUNDS); index++) idle.push(await round(1, CHARS[0]))
  report.idleCpuMs = median(idle.map((item) => item.engineCpuMs))
  report.idleGuardCpuMs = median(idle.map((item) => item.guardCpuMs))
  report.idleCliCpuMs = median(idle.map((item) => item.cliCpuMs))
  console.log(
    `只有一条增量的回合（开吐到结束）：入口 CPU ${report.idleCpuMs.toFixed(1)} ms，守护进程 ${report.idleGuardCpuMs.toFixed(0)} ms，CLI ${report.idleCliCpuMs.toFixed(0)} ms`,
  )
  for (const chars of CHARS) {
    console.log(TOOLS ? `\n每次结果 ${chars} 个字` : `\n每条 ${chars} 个字`)
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
  if (profDir) console.log(`热点在 ${resolve(profDir)}（入口退出时写出）`)
  await cleanup(0)
} catch (error) {
  await cleanup(1, `没有量成：${error?.stack ?? error}\n${log}`)
}
