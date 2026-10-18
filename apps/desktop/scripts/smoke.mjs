// 起一次桌面外壳做自检，把结果整理成一行给人看。
//   npm run smoke          对着模拟核心：界面和核心经消息端口打通，流式增量到了界面
//   npm run smoke:entry    对着隔离的真实入口：核心经套接字连上，真实的会话到了界面
//   npm run check:remote   对着假的远程机器：经 ssh 添加、连上、断线重连、分阶段的失败、移除；
//                          再来一遍（--remote --service）：那台机器上装了适配器，连的是它的设备服务
//   npm run check:full     完整模式（一台设备上多个 harness）：先对着模拟核心，再对着隔离的多 harness 设备
//   npm run check:manage   设备与 harness 管理：先对着模拟核心，再对着带设置接口的隔离设备
//   npm run check:sidebar  侧栏自己（对着模拟核心）：收起的项目和设备那一行上的汇总。check:full 里也有它
//   npm run check:tasks    定时任务（对着模拟核心）：列表、新建、立即运行、去会话、会话顶上那一条
//   加 --packed            不用开发时的外壳，改成起装好的应用（先 npm run pack），验的是打包出来的那一份
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packedBinary } from './packed.mjs'

const require = createRequire(import.meta.url)
// electron 这个包的默认导出就是它的可执行文件的路径
const electron = require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))
// --scroll：对话区“不飘”的验收（对着模拟核心）；--scroll --entry：真实会话的滚动验收
// --compose：输入区和请求卡片的验收（对着模拟核心）；--compose --entry：对着真实入口发消息
// --sidebar：侧栏的验收（对着模拟核心）
// --tasks：定时任务的验收（对着模拟核心）
// --remote：远程设备的验收，对着假的远程机器（回环上的用户态 sshd，后面接隔离入口）
const usePacked = process.argv.includes('--packed')
if (usePacked && !existsSync(packedBinary())) {
  console.error('没有找到装好的应用，请先运行 npm run pack')
  process.exit(1)
}
const useEntry = process.argv.includes('--entry')
const useRemote = process.argv.includes('--remote')
// --remote --service：远程设备的第二遍，对面装了适配器（设备服务）的那几种情形
const useService = useRemote && process.argv.includes('--service')
// --full：完整模式的验收，对着隔离的多 harness 设备（scripts/device-fixture.mjs）；
// --full --mock：同样这些东西对着模拟核心看一遍，不起任何设备
const useFull = process.argv.includes('--full')
// --manage：设备与 harness 管理的验收，对着带设置接口的隔离设备（device-fixture.mjs --managed）；
// --manage --mock：对着模拟核心把详情页上的各种状态过一遍
const useManage = process.argv.includes('--manage')
const useDevice = (useFull || useManage) && !process.argv.includes('--mock')
const probe = useRemote
  ? useService
    ? 'remote-service'
    : 'remote'
  : useFull
    ? 'full'
    : useManage
      ? 'manage'
      : ['scroll', 'compose', 'sidebar', 'tasks'].find((name) => process.argv.includes(`--${name}`))
const mode = useRemote
  ? probe
  : useFull || useManage
    ? useDevice
      ? probe
      : `${probe}-mock`
    : probe
      ? useEntry
        ? `${probe}-entry`
        : probe
      : useEntry
        ? 'entry'
        : 'mock'

/** 起隔离入口，等它把会话造好。返回入口的地址和结束它的函数 */
function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/client-fixture.mjs'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const onData = (chunk) => {
      output += chunk
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_FIXTURE '))
      if (line) {
        const { entry } = JSON.parse(line.slice('LITCH_FIXTURE '.length))
        resolve({ entry, stop: () => child.kill('SIGTERM') })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`隔离入口没起来（退出码 ${code}）：\n${output}`)))
  })
}

/** 起假的远程机器，等它就绪。返回它的 ssh 配置、别名和结束它的函数 */
function startRemote() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/client-ssh-fixture.mjs'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const onData = (chunk) => {
      output += chunk
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_SSH_FIXTURE '))
      if (line) {
        resolve({
          ...JSON.parse(line.slice('LITCH_SSH_FIXTURE '.length)),
          stop: () => child.kill('SIGTERM'),
        })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) =>
      reject(new Error(`假的远程机器没起来（退出码 ${code}）：\n${output}`)),
    )
  })
}

/**
 * 起隔离的多 harness 设备，等它就绪。返回聚合面的套接字、往它的标准输入写命令的函数
 * （stop <标识>、start <标识>：让一个 harness 掉线、恢复）和结束它的函数。
 * 结束要等它真的退出：它得把两个运行时和设备进程收掉、把临时目录删了。
 * managed：换成由真的适配器主进程管着的那一种，聚合面上有设备配置接口
 */
function startDevice(managed) {
  return new Promise((resolve, reject) => {
    const args = ['scripts/device-fixture.mjs', ...(managed ? ['--managed'] : [])]
    const child = spawn(process.execPath, args, {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise((done) => child.on('exit', done))
    let output = ''
    const onData = (chunk) => {
      output += chunk
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_DEVICE_FIXTURE '))
      if (!line) return
      resolve({
        socket: JSON.parse(line.slice('LITCH_DEVICE_FIXTURE '.length)).socket,
        command: (text) => child.stdin.write(`${text}\n`),
        log: () => output,
        stop: () => {
          child.kill('SIGTERM')
          return Promise.race([exited, new Promise((done) => setTimeout(done, 15_000))])
        },
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) =>
      reject(new Error(`隔离的多 harness 设备没起来（退出码 ${code}）：\n${output}`)),
    )
  })
}

const fixture = useEntry ? await startFixture() : null
const remote = useRemote ? await startRemote() : null
const device = useDevice ? await startDevice(useManage) : null

/** 一个进程和它所有的子孙 */
function family(pid) {
  let children = []
  try {
    children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    // 没有子进程
  }
  return [pid, ...children.flatMap(family)]
}

/** 远程验收里外面要查的几件事，不合格的记在这里 */
const outside = []

/** 发一个请求、等它的应答的小客户端：只够“别的客户端改一项设置”用 */
function openPeer(socket) {
  const { WebSocket } = require('ws')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socket}:/`)
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
 * “别的客户端”：另开一条连接到聚合面，像另一台 Litch 那样改一项设置。
 * 排着队一项一项改：每次写入都要带上当时最新的版本号
 */
let elsewhere = Promise.resolve()
function writeElsewhere(socket, key, value) {
  elsewhere = elsewhere
    .then(async () => {
      const peer = await openPeer(socket)
      try {
        await peer.call('initialize', {
          clientInfo: { name: 'litch-check-peer', title: null, version: '0.0.0' },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            litchExtensions: ['harness', 'deviceSettings'],
          },
        })
        peer.notify('initialized')
        const { snapshot } = await peer.call('litch/device/settings/read')
        await peer.call('litch/device/settings/write', {
          expectedVersion: snapshot.version,
          edits: [{ key, value }],
        })
      } finally {
        peer.close()
      }
    })
    .catch((error) => outside.push(`别的客户端没能改 ${key}：${error.message}`))
}

// 用一份临时的用户数据目录：自检会写草稿，不能落进平时用的那一份里
const profile = mkdtempSync(join(tmpdir(), 'litch-smoke-'))
const child = spawn(usePacked ? packedBinary() : electron, usePacked ? [] : [appDir], {
  env: {
    ...process.env,
    LITCH_SMOKE: mode,
    LITCH_PROFILE: profile,
    ...(fixture ? { LITCH_ENTRY: fixture.entry } : {}),
    // 本机设备直接连聚合面的套接字
    ...(device ? { LITCH_ENTRY: device.socket } : {}),
    ...(remote
      ? {
          // 只用假的远程机器那份 ssh 配置；对面的 codex 和适配器都是替身的名字
          LITCH_SSH_CONFIG: remote.config,
          LITCH_REMOTE_CODEX: remote.codex,
          LITCH_REMOTE_ADAPTER: remote.adapter,
          LITCH_SMOKE_ALIASES: JSON.stringify(remote.aliases),
          // 设备服务那边建项目用的目录（在假机器的临时主目录里）
          LITCH_SMOKE_WORK: remote.work,
          // 本机这一版要靠这个变量指定入口：这里故意不给，顺便验“一台连不上不耽误别的”
          LITCH_ENTRY: '',
        }
      : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
/** 只有标准输出的那一份：信号按行认，不能让标准错误的字夹进一行中间 */
let printed = ''
/** 断线那几下各做了什么、花了多久：验收没过时一并打出来 */
const dropNotes = []
/** 头一次断线之后那次“有没有在监听端口”的检查，退出前要等它出结果 */
let listening = null
/** 页面要外面让哪个 harness 掉线、恢复：已经转给夹具的有几条 */
let relayed = 0
/** 页面要外面对假的远程机器做的事（断线、装上适配器）：已经照办的有几条 */
let obeyed = 0

/**
 * 应用自己起的、连着假远程机器的那几条 ssh 的进程号。
 * 只在应用的子孙进程里找（一次 ps 把进程表读回来自己算），再核对命令行里带着假机器那份配置的路径：
 * 这台电脑上别的 ssh（包括别的应用开着的）不在其中，按名字也找不到它们头上
 */
function appSsh() {
  const table = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, parent, command]) => ({ pid: Number(pid), parent: Number(parent), command }))
  const ours = new Set([child.pid])
  // 进程表不保证父在子前：一直扫到不再多出来为止
  for (let grew = true; grew; ) {
    grew = false
    for (const entry of table) {
      if (!ours.has(entry.pid) && ours.has(entry.parent)) {
        ours.add(entry.pid)
        grew = true
      }
    }
  }
  return table
    .filter((entry) => ours.has(entry.pid) && entry.command.includes(`ssh -F ${remote.config}`))
    .map((entry) => entry.pid)
}

/** 把连着假远程机器的那几条 ssh 结束掉，和拔网线一个效果 */
function dropSsh() {
  // 先断线，别的检查排在后面：页面从打出这一行起只等 30 秒，而 lsof 在慢机器上一跑就是好几秒
  const at = Date.now()
  let pids = []
  try {
    pids = appSsh()
    for (const pid of pids) process.kill(pid, 'SIGTERM')
  } catch (error) {
    outside.push(`没能把 ssh 断掉：${error.message}`)
  }
  dropNotes.push(
    `断线：信号之后 ${Date.now() - at} 毫秒结束了 ssh（进程 ${pids.join(' ') || '一条都没找到'}）`,
  )
  if (listening) return
  // 应用和它的子进程有没有在监听端口（ssh 客户端本来也不监听，结束没结束都不影响这一项）。
  // 不等它：等的话这边的事件循环停住，后面的信号也跟着晚
  const tree = family(child.pid).join(',')
  listening = new Promise((done) => {
    execFile(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', tree],
      { encoding: 'utf8' },
      // lsof 什么都没找到时以非零退出：就是没有在监听
      (_error, found) => {
        if (found?.trim()) outside.push(`应用在监听端口：\n${found}`)
        done()
      },
    )
  })
}

child.stdout.on('data', (chunk) => {
  output += chunk
  printed += chunk
  if (remote) {
    // 只认写完整了的行。drop：断线；install、uninstall：让 grow 那个别名“装上”“卸掉”适配器
    const signals = printed
      .slice(0, printed.lastIndexOf('\n') + 1)
      .split('\n')
      .flatMap((line) => line.match(/^LITCH_SIGNAL (drop|install|uninstall)$/)?.[1] ?? [])
    for (const signal of signals.slice(obeyed)) {
      if (signal === 'drop') dropSsh()
      else if (signal === 'install') writeFileSync(remote.growFlag, '')
      else rmSync(remote.growFlag, { force: true })
    }
    obeyed = signals.length
  }
  if (device) {
    // 只认写完整了的行：最后那一截可能还没到齐
    const signals = output
      .slice(0, output.lastIndexOf('\n') + 1)
      .split('\n')
      .flatMap(
        (line) => line.match(/^LITCH_SIGNAL ((?:stop|start) [\w-]+|write \S+ .+)$/)?.[1] ?? [],
      )
    for (const signal of signals.slice(relayed)) {
      // write <设置项的键> <值>：别的客户端改一项设置。别的原样转给夹具
      const write = signal.match(/^write (\S+) (.+)$/)
      if (write) writeElsewhere(device.socket, write[1], JSON.parse(write[2]))
      else device.command(signal)
    }
    relayed = signals.length
  }
})
child.stderr.on('data', (chunk) => {
  output += chunk
})

// 设备服务那一遍要拉起真的服务、开终端、断好几次线，给得宽一些。
// 输入区那一组探针多、里面有按真的时间走的等待（流水线上一遍要一分半），也给宽：到点还没结果是直接杀掉，
// 杀掉的那一遍什么都不说，所以这个时限只用来拦真的卡死，不能贴着平时的用时定。
// 滚动验收后面接着一段按真的时间狂打日志的命令（probe-output.mts）和两次结果很大的工具调用（probe-tools.mts），
// 比别的模拟核心自检多给两分钟
const useCompose = process.argv.includes('--compose')
const useScroll = process.argv.includes('--scroll') && !useEntry
const timer = setTimeout(
  () => child.kill('SIGKILL'),
  useService
    ? 420_000
    : useCompose
      ? 300_000
      : useRemote || useDevice
        ? 240_000
        : useScroll
          ? 240_000
          : 120_000,
)
child.on('exit', async (code) => {
  clearTimeout(timer)
  await listening
  fixture?.stop()
  remote?.stop()
  // 没过的时候把夹具自己的输出也带上：哪个运行时没起来、设备进程说了什么，都在里面
  const deviceLog = device?.log() ?? ''
  await device?.stop()
  if (remote) {
    // 落盘的设备配置里只该有这几样：没有密码，没有密钥的内容
    const file = join(profile, 'devices.json')
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    const shape = (saved?.remotes ?? []).map((entry) => Object.keys(entry).sort().join(','))
    if (!saved) outside.push('没有把设备配置存下来')
    else if (shape.some((keys) => keys !== 'id,name,target,wire')) {
      outside.push(`设备配置里有不该有的东西：${JSON.stringify(saved)}`)
    } else {
      const kept = saved.remotes.map((entry) => entry.target.alias).sort()
      // 头一遍：加了两台、移除了一台，剩下的是什么都没装的那一台。
      // 设备服务那一遍：加了五台，一台没移除
      const { bare, svc, grow, legacy, svcDown, svcOld } = remote.aliases
      const wanted = (useService ? [svc, grow, legacy, svcDown, svcOld] : [bare]).sort()
      if (kept.join(' ') !== wanted.join(' ')) {
        outside.push(`存下来的设备不对：${JSON.stringify(saved.remotes)}`)
      }
    }
    if (/PRIVATE KEY|password/i.test(existsSync(file) ? readFileSync(file, 'utf8') : '')) {
      outside.push('设备配置里出现了密钥或密码')
    }
  }
  if (useManage) {
    // 验收里填过的密钥都以 sk-PROBE 开头：外壳和核心的输出里、落盘的东西里都不该有它
    if (output.includes('sk-PROBE')) outside.push('应用的输出里出现了验收时填的密钥')
    try {
      const kept = execFileSync('grep', ['-rl', 'sk-PROBE', profile], { encoding: 'utf8' })
      if (kept.trim()) outside.push(`用户数据目录里存下了验收时填的密钥：\n${kept}`)
    } catch {
      // grep 什么都没找到时以非零退出：就是没有
    }
  }
  rmSync(profile, { recursive: true, force: true })
  const line = output.split('\n').find((entry) => entry.startsWith('LITCH_SMOKE '))
  if (!line) {
    console.error(`自检没有给出结果（退出码 ${code}）。外壳的输出：\n${output}`)
    process.exit(1)
  }
  const result = JSON.parse(line.slice('LITCH_SMOKE '.length))
  if (probe) {
    // 验收：把量到的数字都列出来，不合格的项单独说
    for (const [name, value] of Object.entries(result.probe ?? {})) {
      console.log(
        `  ${name} = ${typeof value === 'number' ? Math.round(value * 100) / 100 : JSON.stringify(value)}`,
      )
    }
    const failed = [...(result.failed ?? []), ...outside]
    if (failed.length === 0) console.log('验收通过')
    else {
      console.error(`验收没过：\n  ${failed.join('\n  ')}\n${output}`)
      for (const note of dropNotes) console.error(note)
      if (deviceLog) console.error(`隔离设备的输出：\n${deviceLog}`)
    }
    process.exit(failed.length === 0 ? 0 : 1)
  }
  const what = mode === 'entry' ? '真实入口的会话已到达界面' : '流式增量已到达界面，代码块已上色'
  console.log(
    result.ok
      ? `自检通过：启动落在新建对话页，侧栏 ${result.rows} 行，点开的会话 ${result.turns} 个回合，${what}`
      : `自检失败：${line}\n${output}`,
  )
  process.exit(result.ok ? 0 : 1)
})
