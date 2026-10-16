// 自检用的假适配器，只给 scripts/check-adapter.mjs 用。一个文件三种用法：
//   当命令行：  fake-adapter.mjs device-start --home H --root R --node N --ssh=off
//               fake-adapter.mjs device-stop --home H --if-idle
//   当设备进程：fake-adapter.mjs --listen unix://<套接字> --state <目录> [--facts <JSON>]
// 照的是真命令行的约定（cmd/codex-harness-adapter/device_start.go、device_stop.go）。device-start 幂等：
//   0  聚合面能连了。标准输出只有一行 JSON：
//      {"ready":true,"started":…,"socket":"…","pid":N,"service":{…},"cli":{…}}
//      service 是在跑的那份服务的来历（它没报就没有这一项），cli 是执行命令的这一份
//   3  状态目录上有一份不带聚合面的服务在运行。标准输出是空的，标准错误里一句话
//   1  没起来。标准错误里是原因，后面可能附着服务输出的末尾
// device-stop 也幂等，标准输出一行 JSON，给人看的一句话在标准错误里：
//   0  没有服务了：{"result":"notRunning"} 或 {"result":"stopped","pid":N,"service":{…}}
//   4  带了 --if-idle 而服务不闲：{"result":"busy",…,"busy":[{…}]}，没有停
//   5  没法请它停：{"result":"unsupported"}，没有动它
//   1  没停成。标准输出是空的
// 怎么表现由环境变量决定：
//   FAKE_ADAPTER  device-start 这一半（见下面的 switch）
//   FAKE_VERSION、FAKE_BUILD  这份“适配器”的版本号和程序文件的戳，默认 1.0.0、b1
//   FAKE_SERVICE  这一次拉起的服务怎么报来历：facts（默认）、nofacts（不报，像旧版）、foreground（报成不是脱离出去的）
//   FAKE_STOP     device-stop 这一半：ok（默认，停掉）、busy、unsupported、fail、hang
//   FAKE_CALLS    每被调用一次往这个文件里记一行
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const self = fileURLToPath(import.meta.url)
const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

/** 套接字上有没有人在听 */
const reachable = (path) =>
  new Promise((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

/** 每被调用一次记一行：自检要看参数对不对、调了几次、语言给没给、我们自己的环境变量有没有漏过来 */
function record() {
  appendFileSync(
    process.env.FAKE_CALLS,
    `${JSON.stringify({
      args,
      pid: process.pid,
      cwd: process.cwd(),
      lang: process.env.CHA_LANG ?? null,
      // 登录 shell 里的环境到没到这里：PATH 的头一段，和假登录 shell 导出的那个记号
      pathHead: (process.env.PATH ?? '').split(':')[0],
      fromLogin: process.env.FAKE_FROM_LOGIN ?? null,
      leaked: Object.keys(process.env).filter(
        (name) => name.startsWith('LITCH_') || name === 'ELECTRON_RUN_AS_NODE',
      ),
    })}\n`,
  )
}

/** 假设备进程记在状态目录里的东西：它的进程号，和它报的来历（没报就没有那个文件） */
const pidOf = (directory) => {
  const file = join(directory, 'device.pid')
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : undefined
}
const factsOf = (directory) => {
  const file = join(directory, 'facts.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}

async function deviceStart() {
  const home = option('--home')
  const root = option('--root')
  const node = option('--node')
  const mode = process.env.FAKE_ADAPTER ?? 'ok'
  record()
  // 执行命令的这一份“适配器”
  const cli = {
    version: process.env.FAKE_VERSION ?? '1.0.0',
    root,
    build: process.env.FAKE_BUILD ?? 'b1',
  }
  // elsewhere：聚合面不在惯常的位置上。调用方应当以这里报的路径为准，不自己拼
  const socket =
    mode === 'elsewhere' ? join(home, 'alt', 'agg.sock') : join(home, 'device', 'device.sock')
  const state = dirname(socket)
  const ready = (started) => {
    const pid = pidOf(state)
    const service = factsOf(state)
    const line = { ready: true, started, socket, ...(pid ? { pid } : {}) }
    console.log(JSON.stringify({ ...line, ...(service ? { service } : {}), cli }))
    process.exit(0)
  }
  switch (mode) {
    case 'legacy':
      console.error('这个状态目录上有一份不带聚合面的服务正在运行，请先升级并重启它。')
      process.exit(3)
      break
    case 'fail':
      // 一句原因，后面附着服务输出的末尾两千字
      console.error(`设备进程没有起来：模拟的原因\n${'日志'.repeat(995)}最后一行日志`)
      process.exit(1)
      break
    case 'hang':
      // 一直不返回，等着被结束
      setInterval(() => {}, 1000)
      return
    case 'nosocket':
      // 说自己成了，其实什么都没起
      ready(false)
      break
    case 'garbled':
      // 以 0 退出，却没有按约定报出那一行
      console.log('服务已启动')
      process.exit(0)
      break
    default:
      break
  }
  if (await reachable(socket)) ready(false)
  // 这一次拉起的服务报什么来历。启动时带的参数是 --node 那一对后面的全部，和真命令行记的一样
  const kind = process.env.FAKE_SERVICE ?? 'facts'
  const facts = {
    ...cli,
    detached: kind !== 'foreground',
    options: args.slice(args.indexOf('--node') + 2),
  }
  // 以脱离出去的方式拉起设备进程，用的是传进来的那份 Node。
  // inherit：故意让它继承这条命令的两条输出管道，模拟“没把输出重定向干净”
  const output = mode === 'inherit' ? 'inherit' : 'ignore'
  const child = spawn(
    node,
    [
      self,
      ...['--listen', `unix://${socket}`, '--state', state],
      ...(kind === 'nofacts' ? [] : ['--facts', JSON.stringify(facts)]),
    ],
    { detached: true, stdio: ['ignore', output, output] },
  )
  child.unref()
  for (let waited = 0; waited < 10_000; waited += 50) {
    // 假设备进程开始听的时候进程号和来历都已经写好了
    if (await reachable(socket)) ready(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  console.error('设备进程起来了，但聚合面一直连不上')
  process.exit(1)
}

async function deviceStop() {
  const home = option('--home')
  const mode = process.env.FAKE_STOP ?? 'ok'
  record()
  const state = join(home, 'device')
  const socket = join(state, 'device.sock')
  const finish = (line, code, note) => {
    console.log(JSON.stringify(line))
    console.error(note)
    process.exit(code)
  }
  if (!(await reachable(socket))) finish({ result: 'notRunning' }, 0, '没有常驻服务在运行。')
  const pid = pidOf(state)
  const service = factsOf(state)
  const who = { pid, ...(service ? { service } : {}) }
  switch (mode) {
    case 'busy':
      finish(
        {
          result: 'busy',
          ...who,
          busy: [
            { reason: 'activeTurns', harnesses: ['pi'] },
            { reason: 'clients', count: 2 },
          ],
        },
        4,
        '服务不闲，没有停：pi 有回合在跑（或者判断不了）；有 2 个客户端连着',
      )
      break
    case 'unsupported':
      finish(
        { result: 'unsupported', pid },
        5,
        '有一份常驻服务在运行，但没法请它停：它不认识停止的请求',
      )
      break
    case 'fail':
      // 没停成：标准输出是空的，服务还在
      console.error('服务答应了停，却迟迟没有退出')
      process.exit(1)
      break
    case 'hang':
      // 一直不返回，等着被结束
      setInterval(() => {}, 1000)
      return
    default:
      break
  }
  // 真命令行是请服务自己停；这里的假服务是这个文件自己起的，按它记下的进程号结束它，等它收干净
  process.kill(pid, 'SIGTERM')
  for (let waited = 0; waited < 5000; waited += 20) {
    if (!(await reachable(socket)) && !existsSync(join(state, 'device.pid'))) {
      finish({ result: 'stopped', ...who }, 0, '常驻服务已经停止。')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  console.error('假服务没有退出')
  process.exit(1)
}

/** 假的聚合面：unix 套接字上的 WebSocket，一帧一条 JSON，只答握手和列会话 */
function serveDevice() {
  const socket = option('--listen').replace(/^unix:\/\//, '')
  const state = option('--state')
  const facts = option('--facts')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  rmSync(socket, { force: true })
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (peer) => {
    peer.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.id === undefined) return
      const reply = (body) => peer.send(JSON.stringify({ id: message.id, ...body }))
      if (message.method === 'initialize') {
        reply({
          result: {
            userAgent: 'litch-fake-device/0.0.0',
            codexHome: state,
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        })
      } else if (message.method === 'thread/list') {
        reply({ result: { data: [{ id: 'fake-thread-1' }], nextCursor: null } })
      } else {
        reply({ error: { code: -32601, message: `Method not found: ${message.method}` } })
      }
    })
  })
  const stop = () => {
    for (const name of ['facts.json', 'device.pid']) rmSync(join(state, name), { force: true })
    rmSync(socket, { force: true })
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  // 自检万一中途断了没来得及收拾，它自己过一阵也会退
  setTimeout(stop, 10 * 60_000).unref()
  // 什么都不往标准输出、标准错误里写：inherit 那种情形下它们还连着启动命令的管道
  // 进程号和来历先写好再开始听：能连上的时候它们一定已经在了
  writeFileSync(join(state, 'device.pid'), String(process.pid))
  if (facts) {
    writeFileSync(
      join(state, 'facts.json'),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        ...JSON.parse(facts),
      }),
    )
  }
  server.listen(socket, () => chmodSync(socket, 0o600))
}

if (args[0] === 'device-start') await deviceStart()
else if (args[0] === 'device-stop') await deviceStop()
else if (args.includes('--listen')) serveDevice()
else {
  console.error(`假适配器不认识这样的用法：${args.join(' ')}`)
  process.exit(2)
}
