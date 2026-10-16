// 三个引擎各走一遍的验收：不显示窗口，起一次桌面外壳，对着由真的适配器主进程管着的三引擎隔离设备
// （scripts/device-fixture.mjs --managed --engines claude,pi,dsh：真的 Claude Code、Pi、DeepSeek Harness，
// 模型是回环上的假模型），在界面里把三家各走一遍。量法在 src/probe-engines*.mts，各家各步该是什么在
// src/probe-engines-judge.mts。每一步三家的结果并排打一行 LITCH_ENGINES {…}，最后是一张表。
//
// Claude Code 和 dsh 各要一份隔离的命令行，用环境变量给（不会去 PATH 里找，那里的是这台机器的主人自己在用的）：
//   CHA_CLAUDE_CLI   流水线上是装到 .artifacts/host-cli 的那一份
//   CHA_DSH_CLI      流水线上是装到 .artifacts/host-dsh 的那一份
// 缺哪个：默认不跑、报错（少走一家不能算过）。带 --skip-missing 才把缺的那一家跳过去，
// 结果里明着写跳过了谁、为什么，最后那一行也写着“不完整”。
//   --local                   换一种对面：不由夹具起设备，而是让外壳像装好的应用那样自己去起“自带的那份适配器”
//                             （先 npm run client:stage:adapter；环境由 scripts/client-local-fixture.mjs --engines 备，
//                             经假的登录 shell 交给服务）。量的东西一样。真实窗口验收装好的应用之前先跑这一种
//   --engines claude,pi,dsh   只走其中几家（Pi 一直在）
//   --steps approve,decline   排查时只走其中几步（步骤的名字就是每一行里的 step；建会话那一步照走）。
//                             这样跑出来的不算一遍完整的验收，最后那一行会写明
//   --verbose                 把外壳的输出原样带出来
//   --json                    最后把量到的东西整份打出来
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// electron 这个包的默认导出就是它的可执行文件的路径
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const verbose = process.argv.includes('--verbose')
const skipMissing = process.argv.includes('--skip-missing')
const local = process.argv.includes('--local')

const ENGINES = {
  claude: { id: 'claude-code', variable: 'CHA_CLAUDE_CLI', name: 'Claude Code' },
  dsh: { id: 'dsh', variable: 'CHA_DSH_CLI', name: 'DeepSeek Harness' },
}
const stepsAt = process.argv.indexOf('--steps')
const onlySteps = stepsAt < 0 ? '' : (process.argv[stepsAt + 1] ?? '')
const at = process.argv.indexOf('--engines')
const asked = at < 0 ? ['claude', 'pi', 'dsh'] : (process.argv[at + 1] ?? '').split(',')
const unknown = asked.filter((name) => name !== 'pi' && !ENGINES[name])
if (unknown.length > 0 || asked.filter(Boolean).length === 0) {
  console.error(`--engines 后面写要走的引擎，用逗号隔开（claude、pi、dsh）${unknown.join(' ')}`)
  process.exit(1)
}

/** 这一家的命令行给了没有、能不能执行。能用是 null，不能用是为什么 */
function missing(name) {
  const { variable } = ENGINES[name]
  const cli = process.env[variable]?.trim()
  if (!cli) return `没有给 ${variable}`
  try {
    accessSync(cli, constants.X_OK)
    return null
  } catch {
    return `${variable} 指的不是一个可执行的文件：${cli}`
  }
}
const skipped = asked
  .filter((name) => ENGINES[name])
  .flatMap((name) => {
    const why = missing(name)
    return why ? [{ name, title: ENGINES[name].name, why }] : []
  })
if (skipped.length > 0 && !skipMissing) {
  console.error('三引擎验收没有跑：缺隔离的命令行。')
  for (const entry of skipped) console.error(`  - ${entry.title}：${entry.why}`)
  console.error(
    '给法：CHA_CLAUDE_CLI=<隔离的 claude> CHA_DSH_CLI=<隔离的 dsh> npm run client:check:engines\n' +
      '（流水线上是 npm install --prefix .artifacts/host-cli … 装出来的那两份；见 .github/workflows/ci.yml）\n' +
      '只想走有的那几家：加 -- --skip-missing，结果里会写明跳过了谁。',
  )
  process.exit(1)
}
const wanted = asked.filter((name) => !skipped.some((entry) => entry.name === name))
if (!wanted.includes('pi')) wanted.push('pi')

/** 起一个夹具脚本，等它打出就绪的那一行。返回那一行里的内容和结束它的函数 */
function startFixture(script, args, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise((done) => child.on('exit', done))
    let output = ''
    let ready = false
    const onData = (chunk) => {
      output += chunk
      if (ready) return
      const line = output.split('\n').find((entry) => entry.startsWith(`${marker} `))
      if (!line) return
      ready = true
      resolve({
        info: JSON.parse(line.slice(marker.length + 1)),
        log: () => output,
        // 等它真的退出：它要请主进程把三个运行时和设备进程收掉、把临时目录删了
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
  // 给 ps 一个 UTF-8 的区域设置：不给的话命令行里的汉字会被它写成转义
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

// 中途被叫停（Ctrl+C、被上层结束）：把正在跑的外壳结束掉，下面照常收尾（夹具、临时目录）
let stopped = false
let running = null
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true
    running?.kill('SIGKILL')
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'litch-eng-'))
const outside = []
const fixture = await (local
  ? startFixture(
      'scripts/client-local-fixture.mjs',
      ['--engines', wanted.join(',')],
      'LITCH_LOCAL_FIXTURE',
    )
  : startFixture(
      'scripts/device-fixture.mjs',
      ['--managed', '--engines', wanted.join(',')],
      'LITCH_DEVICE_FIXTURE',
    )
).catch((error) => {
  console.error(`三引擎验收没过：${error.message}`)
  rmSync(scratch, { recursive: true, force: true })
  process.exit(1)
})
const { root, socket, engines } = fixture.info
let output = ''
// 对着夹具起的设备：把聚合面的地址交给外壳。对着自带的适配器：带上夹具给的那几个变量（状态目录、
// 假的登录 shell、适配器在哪），外壳自己去起服务；别的指路的变量一个不带，免得盖过登录 shell 给的
const { CHA_CLAUDE_CLI: _claude, CHA_DSH_CLI: _dsh, ...inherited } = process.env
const child = spawn(electron, [appDir], {
  env: {
    ...(local ? inherited : process.env),
    LITCH_SMOKE: 'engines',
    LITCH_SMOKE_ENGINES: JSON.stringify(engines),
    LITCH_SMOKE_STEPS: onlySteps,
    ...(local
      ? { ...fixture.info.env, LITCH_ENTRY: '' }
      : { LITCH_PROFILE: join(scratch, 'profile'), LITCH_ENTRY: socket }),
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
    // 每一步三家并排的那一行，出来一行带出来一行（最后不完整的那一行先不带）
    const lines = output
      .split('\n')
      .slice(0, -1)
      .filter((line) => line.startsWith('LITCH_ENGINES '))
    for (const line of lines.slice(printed)) console.log(line)
    printed = lines.length
  })
}
// 外壳自己有时限（15 分钟），到点会把走到哪一步报出来；这里是它连报都没报时的最后一道
const startedAt = Date.now()
let killed = false
const timer = setTimeout(() => {
  killed = true
  child.kill('SIGKILL')
}, 1_080_000)
const code = await new Promise((done) => child.on('exit', done))
clearTimeout(timer)
running = null
if (killed) {
  outside.push(`外壳 ${Math.round((Date.now() - startedAt) / 1000)} 秒没有结束，被强行结束了`)
}
const line = output.split('\n').find((item) => item.startsWith('LITCH_SMOKE '))
let result = null
try {
  result = line ? JSON.parse(line.slice('LITCH_SMOKE '.length)) : null
} catch {
  // 结果行不完整
}

// 界面上看到的之外，到工作目录里看一眼：批准的那条命令留下了它的文件，各家写的文件都在、内容对
const steps = result?.probe?.steps ?? {}
const went = (step, id) => steps[step]?.[id] && !steps[step][id].error
if (
  engines.ids.some((id) => went('approve', id)) &&
  !existsSync(join(engines.cwd, 'fixture-ran.txt'))
) {
  outside.push('批准了命令，工作目录里却没有它该留下的 fixture-ran.txt')
}
for (const id of engines.ids.filter((entry) => went('write', entry))) {
  const file = join(engines.cwd, `agent-written.${id}.txt`)
  const body = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (body !== 'written by the fixture agent\n') {
    outside.push(`${id} 写的文件不对：${file} ${body === null ? '不存在' : JSON.stringify(body)}`)
  }
}

const fixtureLog = fixture.log()
await fixture.stop()
// 夹具停了之后：它起的主进程、三个运行时、设备进程、引擎的命令行都该没了，临时目录也删了
const left = processesUnder(root)
if (left.length > 0) {
  outside.push(
    `夹具停了之后还有进程带着它的临时目录：${left.map((entry) => `${entry.pid} ${entry.command}`).join('｜')}`,
  )
  // 是这一遍自己起的（命令行里带着这一遍现建的目录），按进程号结束
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
  console.error('三引擎验收被中途叫停了，已经收尾')
  process.exit(130)
}

const failed = [...(result?.failed ?? (result ? [] : ['没有拿到结果'])), ...outside]
const known = result?.probe?.known ?? []
const table = result?.probe?.table ?? {}
const ids = engines.ids
if (Object.keys(table).length > 0) {
  console.log(`\n步骤 ｜ ${ids.join(' ｜ ')}`)
  for (const [step, row] of Object.entries(table)) {
    console.log(`${step} ｜ ${ids.map((id) => row[id] ?? '—').join(' ｜ ')}`)
  }
}
if (known.length > 0) {
  console.log('\n适配器那一头已知的毛病，这一遍还是老样子的（不算没过）：')
  for (const entry of known) console.log(`  - ${entry}`)
}
const partial = [
  ...(skipped.length > 0
    ? [`跳过了 ${skipped.map((entry) => `${entry.title}——${entry.why}`).join('；')}`]
    : []),
  ...(onlySteps ? [`只走了这几步：${onlySteps}`] : []),
]
  .map((entry) => `（不完整：${entry}）`)
  .join('')
const ok = failed.length === 0 && code === 0
if (ok) {
  console.log(
    `\n三引擎验收通过${local ? '（自带的适配器）' : ''}：走了 ${ids.join('、')}${partial}`,
  )
} else {
  console.error(
    `\n三引擎验收没过${local ? '（自带的适配器）' : ''}（退出码 ${code}）：走了 ${ids.join('、')}${partial}`,
  )
  for (const entry of failed) console.error(`  - ${entry}`)
  console.error(
    output
      .split('\n')
      .filter((entry) => !entry.startsWith('LITCH_SMOKE ') && !entry.startsWith('LITCH_ENGINES '))
      .slice(-30)
      .join('\n'),
  )
  console.error(
    `夹具的输出：\n${fixtureLog
      .split('\n')
      .filter((entry) => !/^LITCH_(DEVICE|LOCAL)_FIXTURE /.test(entry))
      .slice(-30)
      .join('\n')}`,
  )
}
if (process.argv.includes('--json') && result) console.log(JSON.stringify(result.probe, null, 2))
process.exit(ok ? 0 : 1)
