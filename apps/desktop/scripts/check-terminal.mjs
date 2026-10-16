// 终端面板的验收：不显示窗口，起三次桌面外壳，各对着一种对面。
//   --mock     模拟核心（假 shell）：面板的开合、标签、输入回显、慢出字、刷屏、全屏、皮肤、语言
//   --device   隔离的多 harness 设备（scripts/device-fixture.mjs）：可重连的终端
//   --entry    单个 harness 的入口（scripts/client-fixture.mjs）：随连接结束的终端
// 不带参数就是三种依次跑。量法在 src/probe-terminal*.mts。
//
// 时间上的线（按键回显、帧间隔、中断多久生效）有严和宽两套（src/probe-terminal-judge.mts）：
// 平时按严的；LITCH_CHECK_LENIENT=1 或者在流水线上（CI=true）按宽的，回显和帧间隔只报数，只拦“卡死了”。
// 功能对不对的检查两套一样严。
// 拿 taskpolicy -b 模拟慢机器的时候要带上 LITCH_CHECK_LENIENT=1：系统把后台进程的定时器合并到大约 200 毫秒一拍，
// 帧间隔和回显量出来就是这一拍的长短，严的线必然不过，那不是终端慢。
//
// 断线是真的断：外壳连的不是夹具的套接字，是这里起的一个转发口，页面打一行 LITCH_SIGNAL link down
// 就把转发着的连接掐掉、之后的也不接，直到 LITCH_SIGNAL link up。只有验收这样连，产品里没有这一层。
// 夹具起的 shell 用的是夹具自己的临时主目录，不读用户的 shell 配置和历史。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// electron 这个包的默认导出就是它的可执行文件的路径
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
const only = ['mock', 'device', 'entry'].filter((name) => process.argv.includes(`--${name}`))
const wanted = only.length > 0 ? only : ['mock', 'device', 'entry']
const verbose = process.argv.includes('--verbose')

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
        // 等它真的退出：它要把运行时和设备进程收掉、把临时目录删了
        stop() {
          child.kill('SIGTERM')
          return Promise.race([exited, new Promise((done) => setTimeout(done, 15_000))])
        },
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`夹具没起来（退出码 ${code}）：\n${output}`)))
  })
}

/** 在夹具的套接字前面起一个转发口。down() 掐掉现有的连接并且不再接新的，up() 恢复 */
function startRelay(target, dir) {
  const path = join(dir, 'relay.sock')
  const pairs = new Set()
  let open = true
  const server = createServer((near) => {
    if (!open) {
      near.destroy()
      return
    }
    const far = connect(target)
    const pair = { near, far }
    pairs.add(pair)
    const drop = () => {
      pairs.delete(pair)
      near.destroy()
      far.destroy()
    }
    near.on('error', drop)
    far.on('error', drop)
    near.on('close', drop)
    far.on('close', drop)
    near.pipe(far)
    far.pipe(near)
  })
  return new Promise((resolve) => {
    server.listen(path, () =>
      resolve({
        path,
        down() {
          open = false
          for (const { near, far } of [...pairs]) {
            near.destroy()
            far.destroy()
          }
        },
        up() {
          open = true
        },
        close: () => new Promise((done) => server.close(done)),
      }),
    )
  })
}

/** 发一个请求、等它的应答的小客户端：只够从外面看一眼设备上还有哪些进程 */
function openPeer(socket) {
  const { WebSocket } = require('ws')
  return new Promise((resolve, reject) => {
    // 路径不写进地址：地址里的路径会被转义，临时目录带空格或汉字时连的就不是那个文件了
    const ws = new WebSocket('ws://localhost/', {
      perMessageDeflate: false,
      createConnection: () => connect(socket),
    })
    const pending = new Map()
    let seq = 1
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.id === undefined || message.method) return
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    })
    ws.once('error', reject)
    ws.once('open', () =>
      resolve({
        call: (method, params = {}) =>
          new Promise((done, fail) => {
            const id = seq++
            pending.set(id, (reply) =>
              reply.error ? fail(new Error(reply.error.message)) : done(reply.result),
            )
            ws.send(JSON.stringify({ id, method, params }))
          }),
        notify: (method) => ws.send(JSON.stringify({ method })),
        close: () => ws.close(),
      }),
    )
  })
}

/**
 * 设备上现在有哪些属于设备的进程：从另一条连接去列，和界面那条没关系。
 * 列完把它们都结束掉：验收里选了“留着”的终端本来就该还在跑，夹具收场之前不能留着它们。
 */
async function listAndEndProcesses(socket) {
  const peer = await openPeer(socket)
  try {
    await peer.call('initialize', {
      clientInfo: { name: 'litch-check-peer', title: null, version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        litchExtensions: ['harness', 'deviceProcesses'],
      },
    })
    peer.notify('initialized')
    const { data } = await peer.call('litch/process/list')
    for (const entry of data) {
      await peer
        .call('litch/process/kill', { processHandle: entry.processHandle, remove: true })
        .catch(() => {})
    }
    return data
  } finally {
    peer.close()
  }
}

// 中途被叫停（Ctrl+C、被上层结束）：把正在跑的外壳结束掉，runOne 照常收尾（夹具、转发口、临时目录），
// 收完就退出，剩下的不跑了。不这样的话外壳会没了父进程接着跑，临时目录也留着
let stopped = false
let running = null
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true
    running?.kill('SIGKILL')
  })
}

/** 起一次外壳跑一种验收。返回它打出来的结果，和外面另外查到的不合格项 */
async function runOne(kind) {
  const scratch = mkdtempSync(join(tmpdir(), 'litch-term-'))
  const profile = join(scratch, 'profile')
  const fixture =
    kind === 'device'
      ? await startFixture('scripts/device-fixture.mjs', ['--workspaces'], 'LITCH_DEVICE_FIXTURE')
      : kind === 'entry'
        ? await startFixture('scripts/client-fixture.mjs', [], 'LITCH_FIXTURE')
        : null
  // 入口夹具报的是 unix:// 开头的地址，设备夹具报的是套接字的路径
  const target = fixture
    ? (fixture.info.socket ?? fixture.info.entry).replace(/^unix:\/\//, '')
    : null
  const relay = target ? await startRelay(target, scratch) : null
  const outside = []
  const child = spawn(electron, [appDir], {
    env: {
      ...process.env,
      LITCH_SMOKE: kind === 'mock' ? 'terminal' : `terminal-${kind}`,
      LITCH_PROFILE: profile,
      ...(relay ? { LITCH_ENTRY: relay.path } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running = child
  if (stopped) child.kill('SIGKILL')
  let output = ''
  let handled = 0
  child.stdout.on('data', (chunk) => {
    output += chunk
    if (verbose) process.stdout.write(chunk)
    // 只认写完整了的行
    const signals = output
      .slice(0, output.lastIndexOf('\n') + 1)
      .split('\n')
      .flatMap((line) => line.match(/^LITCH_SIGNAL link (down|up)$/)?.[1] ?? [])
    for (const signal of signals.slice(handled)) {
      if (signal === 'down') relay?.down()
      else relay?.up()
    }
    handled = signals.length
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
    if (verbose) process.stderr.write(chunk)
  })
  // 外壳自己有时限（模拟核心 4 分钟，另两种 7 分钟），到点会把走到哪一步报出来；这里是它连报都没报时的最后一道
  const startedAt = Date.now()
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    child.kill('SIGKILL')
  }, 480_000)
  const code = await new Promise((done) => child.on('exit', done))
  clearTimeout(timer)
  running = null
  if (killed) {
    outside.push(
      `外壳 ${Math.round((Date.now() - startedAt) / 1000)} 秒没有结束，被强行结束了；它一共输出了 ${output.length} 个字`,
    )
  }
  const line = output.split('\n').find((entry) => entry.startsWith('LITCH_SMOKE '))
  let result = null
  try {
    result = line ? JSON.parse(line.slice('LITCH_SMOKE '.length)) : null
  } catch {
    // 结果行不完整
  }
  if (kind === 'device') {
    // 界面说“结束了”的在设备上真的没了，说“留着”的真的还在跑
    try {
      const alive = await listAndEndProcesses(target)
      const running = new Set(
        alive.filter((entry) => entry.running).map((entry) => entry.processHandle),
      )
      for (const handle of result?.probe?.outside?.gone ?? []) {
        if (alive.some((entry) => entry.processHandle === handle)) {
          outside.push(`选了“结束”的终端在设备上还在：${handle}`)
        }
      }
      for (const handle of result?.probe?.outside?.kept ?? []) {
        if (!running.has(handle)) outside.push(`选了“留着”的终端在设备上没在跑：${handle}`)
      }
    } catch (error) {
      outside.push(`没能从外面列出设备上的进程：${error.message}`)
    }
  }
  await relay?.close()
  const fixtureLog = fixture?.log() ?? ''
  await fixture?.stop()
  // 临时的用户数据目录和转发口都在这里面
  rmSync(scratch, { recursive: true, force: true })
  if (existsSync(scratch)) outside.push(`临时目录没删掉：${scratch}`)
  const failed = [...(result?.failed ?? (result ? [] : ['没有拿到结果'])), ...outside]
  return { kind, code, result, failed, output, fixtureLog }
}

const NAMES = { mock: '模拟核心', device: '隔离设备（可重连的终端）', entry: '单个 harness 的入口' }
let allOk = true
for (const kind of wanted) {
  if (stopped) break
  const run = await runOne(kind)
  if (stopped) {
    console.error('终端验收被中途叫停了，已经收尾')
    process.exit(130)
  }
  const ok = run.failed.length === 0 && run.code === 0
  allOk &&= ok
  const lenient = run.result?.probe?.lenient ? '（宽的线：回显和帧间隔只报数）' : ''
  const numbers = run.result?.probe?.numbers ? `${run.result.probe.numbers}${lenient}` : ''
  if (ok) {
    console.log(`终端验收通过：${NAMES[kind]}${numbers ? `｜${numbers}` : ''}`)
  } else {
    console.error(`终端验收没过：${NAMES[kind]}（退出码 ${run.code}）`)
    for (const entry of run.failed) console.error(`  - ${entry}`)
    if (numbers) console.error(`  量到的：${numbers}`)
    console.error(
      run.output
        .split('\n')
        .filter((entry) => !entry.startsWith('LITCH_SMOKE '))
        .slice(-40)
        .join('\n'),
    )
    if (run.fixtureLog)
      console.error(`夹具的输出：\n${run.fixtureLog.split('\n').slice(-30).join('\n')}`)
  }
  if (process.argv.includes('--json') && run.result) {
    console.log(JSON.stringify(run.result.probe, null, 2))
  }
}
process.exit(allOk ? 0 : 1)
