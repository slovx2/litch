// 首回合验收：不显示窗口，起一次桌面外壳，对着由真的适配器主进程管着的隔离设备
// （scripts/device-fixture.mjs --managed --engines …，模型是回环上的假模型），每个真的 harness 上
// 从界面新建会话、发头一句、收到回话（量法和判定在 src/probe-first-turn.mts）。
// 原生 codex 那一家另看假模型那一头：外壳建会话时带的工具定义（浏览器、macOS 上的 Computer Use、测试用的回声，
// 整份）codex 收下了、原样交给了模型。0.8.0 带的定义过不了 codex 的校验，在 Codex 上一个会话都建不成，
// 当时没有一条自检在真的 codex 上从界面建过会话，这一条就是补它的。
//
// 各家的命令行用环境变量给，不去 PATH 里找（那里的是这台机器的主人自己在用的）：
//   CHA_CODEX_CLI      原生 codex（流水线上可以是 npm install --prefix .artifacts/host-codex @openai/codex@<精确版本>
//                      装出来的 node_modules/.bin/codex）
//   CHA_CLAUDE_CLI     Claude Code；CHA_DSH_CLI dsh；CHA_OPENCODE_CLI OpenCode；CHA_ACP_CLI opencode（经 ACP 接）
// Pi 一直在（随仓库装好的那一份）。
//   --engines codex,claude,dsh,opencode,acp   走哪几家（默认 codex）。要了却没给命令行：报错，不算过
//   --skip-missing                             缺命令行的那几家跳过去，最后一行写明“不完整”
//   --verbose                                  把外壳的输出原样带出来
// 要先在根目录 npm run build（引擎包、设备进程和命令行），本机要有 go。
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_TOOL_NAMESPACE } from '../../../packages/protocol/src/client-tools.mts'
import { ENGINES } from '../../../scripts/client-fixture-engines.mjs'

const require = createRequire(import.meta.url)
// electron 这个包的默认导出就是它的可执行文件的路径
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const verbose = process.argv.includes('--verbose')
const skipMissing = process.argv.includes('--skip-missing')
const startedAt = Date.now()

/** 各家的命令行在哪个环境变量里：和夹具（device-fixture.mjs）认的是同一张表 */
const VARIABLES = Object.fromEntries(
  Object.entries(ENGINES).map(([name, engine]) => [name, engine.variable]),
)
const at = process.argv.indexOf('--engines')
const asked = (at < 0 ? 'codex' : (process.argv[at + 1] ?? '')).split(',').filter(Boolean)
const unknown = asked.filter((name) => name !== 'pi' && !VARIABLES[name])
if (unknown.length > 0 || asked.length === 0) {
  console.error(
    `--engines 后面写要走的引擎，用逗号隔开（${Object.keys(VARIABLES).join('、')}）${unknown.join(' ')}`,
  )
  process.exit(1)
}
/** 这一家的命令行能不能用：能用是 null，不能用是为什么 */
function missing(name) {
  const cli = process.env[VARIABLES[name]]?.trim()
  if (!cli) return `没有给 ${VARIABLES[name]}`
  try {
    accessSync(cli, constants.X_OK)
    return null
  } catch {
    return `${VARIABLES[name]} 指的不是一个可执行的文件：${cli}`
  }
}
const skipped = asked
  .filter((name) => VARIABLES[name])
  .flatMap((name) => (missing(name) ? [`${name}——${missing(name)}`] : []))
if (skipped.length > 0 && !skipMissing) {
  console.error(`首回合验收没有跑：缺隔离的命令行。\n  - ${skipped.join('\n  - ')}`)
  console.error('只想走有的那几家：加 -- --skip-missing，结果里会写明跳过了谁。')
  process.exit(1)
}
const wanted = asked.filter((name) => name !== 'pi' && !missing(name))

/** 起夹具，等它打出就绪的那一行 */
function startFixture(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/device-fixture.mjs', ...args], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise((done) => child.on('exit', done))
    let output = ''
    let ready = false
    const onData = (chunk) => {
      output += chunk
      if (ready) return
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_DEVICE_FIXTURE '))
      if (!line) return
      ready = true
      resolve({
        info: JSON.parse(line.slice('LITCH_DEVICE_FIXTURE '.length)),
        log: () => output,
        // 等它真的退出：它要请主进程把运行时和设备进程收掉、把临时目录删了
        stop() {
          child.kill('SIGTERM')
          return Promise.race([exited, new Promise((done) => setTimeout(done, 60_000))])
        },
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`夹具没起来（退出码 ${code}）：\n${output}`)))
  })
}

/** 命令行里带着这个目录的进程（夹具的临时目录是现建的，名字不会和别人的撞上） */
function processesUnder(root) {
  const table =
    spawnSync('/bin/ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
    }).stdout ?? ''
  return table
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter((found) => found?.[2].includes(root))
    .map(([, pid, command]) => ({ pid: Number(pid), command: command.slice(0, 160) }))
}

// 中途被叫停：把正在跑的外壳结束掉，下面照常收尾（夹具、临时目录）
let stopped = false
let running = null
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true
    running?.kill('SIGKILL')
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'litch-ft-'))
const fixture = await startFixture(['--managed', '--engines', ['pi', ...wanted].join(',')]).catch(
  (error) => {
    console.error(`首回合验收没过：${error.message}`)
    rmSync(scratch, { recursive: true, force: true })
    process.exit(1)
  },
)
const { root, socket, engines } = fixture.info
let output = ''
const child = spawn(electron, [appDir], {
  env: {
    ...process.env,
    LITCH_SMOKE: 'first-turn',
    LITCH_SMOKE_ENGINES: JSON.stringify(engines),
    LITCH_PROFILE: join(scratch, 'profile'),
    LITCH_ENTRY: socket,
    // 测试用的回声也登记上：建会话时带的就是外壳认得的全部工具定义，codex 对整份做校验
    LITCH_CLIENT_TOOLS_ECHO: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
running = child
if (stopped) child.kill('SIGKILL')
let printed = 0
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    output += chunk
    if (verbose) process.stderr.write(chunk)
    const lines = output
      .split('\n')
      .slice(0, -1)
      .filter((line) => line.startsWith('LITCH_FIRST_TURN '))
    for (const line of lines.slice(printed)) console.log(line)
    printed = lines.length
  })
}
// 外壳自己有时限（5 分钟）；这里是它连报都没报时的最后一道
let killed = false
const timer = setTimeout(() => {
  killed = true
  child.kill('SIGKILL')
}, 420_000)
const code = await new Promise((done) => child.on('exit', done))
clearTimeout(timer)
running = null
const line = output.split('\n').find((item) => item.startsWith('LITCH_SMOKE '))
let result = null
try {
  result = line ? JSON.parse(line.slice('LITCH_SMOKE '.length)) : null
} catch {
  // 结果行不完整
}

const outside = killed ? ['外壳到点没有结束，被强行结束了'] : []
// 原生 codex：假模型收到的请求里，工具表上要有外壳建会话时带的全部命名空间
const fixtureLog = fixture.log()
if (engines.ids.includes('codex')) {
  const seen = new Set(
    fixtureLog
      .split('\n')
      .filter((entry) => entry.startsWith('LITCH_FIXTURE_TOOLS '))
      .flatMap((entry) => JSON.parse(entry.slice('LITCH_FIXTURE_TOOLS '.length)).namespaces),
  )
  // 外壳认得的全部命名空间（开了 LITCH_CLIENT_TOOLS_ECHO，回声也在）；
  // Computer Use 的开关默认关着，建会话时不挂那组工具；
  // 操作这台电脑（litch_machine）只给远程设备上的会话，这里的夹具是本机设备，不该有
  const absent = [CLIENT_TOOL_NAMESPACE.machine, CLIENT_TOOL_NAMESPACE.computer]
  const expected = Object.values(CLIENT_TOOL_NAMESPACE).filter((name) => !absent.includes(name))
  const unexpected = [
    ...(seen.has(CLIENT_TOOL_NAMESPACE.machine)
      ? ['本机设备上的会话不该带 litch_machine，工具表里却有']
      : []),
    ...(seen.has(CLIENT_TOOL_NAMESPACE.computer)
      ? ['Computer Use 默认关着，工具表里却有 litch_computer']
      : []),
  ]
  outside.push(...unexpected)
  const lost = expected.filter((name) => !seen.has(name))
  if (lost.length > 0)
    outside.push(
      `codex 交给模型的工具表里没有 ${lost.join('、')}（有：${[...seen].join('、') || '空的'}）`,
    )
}

await fixture.stop()
// 夹具停了之后：它起的主进程、运行时、设备进程、codex 都该没了，临时目录也删了
const left = processesUnder(root)
if (left.length > 0) {
  outside.push(
    `夹具停了之后还有进程带着它的临时目录：${left.map((entry) => `${entry.pid} ${entry.command}`).join('｜')}`,
  )
  for (const entry of left) {
    try {
      process.kill(entry.pid, 'SIGKILL')
    } catch {
      // 已经没了
    }
  }
}
rmSync(scratch, { recursive: true, force: true })
if (stopped) {
  console.error('首回合验收被中途叫停了，已经收尾')
  process.exit(130)
}

const failed = [...(result?.failed ?? (result ? [] : ['没有拿到结果'])), ...outside]
const partial = skipped.length > 0 ? `（不完整：跳过了 ${skipped.join('；')}）` : ''
const seconds = Math.round((Date.now() - startedAt) / 1000)
if (failed.length === 0 && code === 0) {
  console.log(`\n首回合验收通过：走了 ${engines.ids.join('、')}，共 ${seconds} 秒${partial}`)
  process.exit(0)
}
console.error(`\n首回合验收没过（退出码 ${code}）：走了 ${engines.ids.join('、')}${partial}`)
for (const entry of failed) console.error(`  - ${entry}`)
console.error(
  output
    .split('\n')
    .filter((entry) => !entry.startsWith('LITCH_SMOKE ') && !entry.startsWith('LITCH_FIRST_TURN '))
    .slice(-30)
    .join('\n'),
)
console.error(
  `夹具的输出：\n${fixtureLog
    .split('\n')
    .filter((entry) => !entry.startsWith('LITCH_'))
    .slice(-30)
    .join('\n')}`,
)
process.exit(1)
