// 隔离的多 harness 设备：给客户端开发、自检和真实窗口验收用。
// 在临时目录里起两份各自独立的 Pi 运行时（标识 pi 和 pi-b，各有自己的配置目录、状态目录和会话），
// 模型请求全部打到本机回环上的假模型；再起设备进程，把两个运行时收在一个聚合面后面。
// 不碰用户自己的会话，不用任何模型凭据，不连 ~/.codex-harness-adapter 下真实在跑的服务。
//
// 用法：node scripts/device-fixture.mjs（先构建 packages/pi 和 packages/device）
//   就绪后输出一行 LITCH_DEVICE_FIXTURE {"socket": "...", "root": "...", ...}，然后一直运行到被结束，
//   退出时停掉所有子进程并删掉临时目录。
//   标准输入里可以写命令，用来看一个 harness 掉线和恢复时客户端的反应：
//     stop <标识>    杀掉那个运行时
//     start <标识>   把它重新起来（会话还在）
//   会话造完之后再发消息，假模型会把收到的那句话带回来，开头注明是哪个 harness 收到的；
//   话里带“问我”时会向用户提两个问题（见 client-fixture-ask.mjs）；
//   话里带“改个文件”时会在会话的工作目录里接着写一个文件、新写一个文件（见 client-fixture-edit.mjs）。
//
// 带上 --managed：换成由真的适配器主进程（Go，现编到临时目录里）来管，和正式安装是同一种布局，
//   聚合面上因此有设备配置接口（deviceSettings 扩展：读写设置、停用启用、重启、诊断、日志）。
//   主进程只认 claude-code、pi、dsh 三个标识，所以这时只有一份 Pi 运行时（标识 pi）在跑；
//   Claude Code 的命令行指向一个不存在的路径，报“没装”；dsh 不在 PATH 里，也算没装。
//   原生 Codex 在名单里，装了才默认启用；主进程的环境里没有用户的 PATH（PATH 里有 codex 就拒绝启动），
//   所以它报“没装”，在设置里打开也一样，不会去跑这台机器上真的 codex（要看它可用的样子，跑 scripts/check-native-codex.mjs）。
//   SSH 入口默认关着，端口是系统分配的空闲端口，在设置里打开就能用。
//   运行时归主进程管，stop / start 命令这时不可用，停用和启用走设置接口。需要本机有 go。
//
// 带上 --managed --engines claude,pi,dsh：三个引擎都起来（要先 npm run build 把三个引擎包都构建好）。
//   Claude Code 和 dsh 各要一份隔离的命令行（CHA_CLAUDE_CLI、CHA_DSH_CLI），没给就报错退出；
//   怎么隔离、配置怎么交给主进程见 client-fixture-engines.mjs，这两家的假模型见 client-fixture-anthropic.mjs。
//   这时 Pi 的“动手之前先问”也开着，三家都在会来问的那一档上。假模型对三家认同一套词：
//   跑个命令、改个文件、写个文件、问我、问一句、出个计划、慢慢说（各家用自己的工具，没有的照常回话）。
//   另备一个 git 仓库当工作目录（就绪行的 engines.cwd），里面给三家各放了一份同名的技能。
//   macOS 上 engines.cwd 故意写成和真实路径不一样的那种（/tmp/…，真实的是 /private/tmp/…，见 spelledApart）。
//
// 带上 --managed --ssh：主进程把各 harness 的 SSH 入口也开起来（端口是系统分配的空闲端口），
//   就绪行的 ssh.config 是主进程自己给的配置片段（`ssh-config`），给官方桌面端的回归用：
//   改成测试用的别名后写进 ~/.ssh/config.d 下单独的片段里，用完删掉；不改用户的 ~/.ssh/config。
//
// 带上 --workspaces：会话造完之后，先在每个运行时自己的入口上造几个引擎自己的项目，把会话归进去、
//   置顶、放进自定义分区（两个运行时各有一个根目录相同的项目）。设备进程起来时把它们导入成设备级的工作区，
//   聚合面上因此一连上就有工作区：根目录相同的那两个合成了一个，下面是两边的会话。
//   不带这个开关时各个运行时里没有项目，聚合面上的工作区是空的，要客户端自己建。
//   不能和 --managed 一起用：那时设备进程是主进程一开始就拉起来的，导入发生在造数据之前。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { serveAnthropic } from './client-fixture-anthropic.mjs'
import { installAskExtension } from './client-fixture-ask.mjs'
import {
  engineIds,
  prepareWorkDirectory,
  refuseHarnessOnPath,
  spelledApart,
  wantedEngines,
  writeEngineSettings,
} from './client-fixture-engines.mjs'
import { FIXTURE_SKILL, piReply, sendCompletion } from './client-fixture-marks.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 由真的适配器主进程来管运行时和设备进程 */
const managed = process.argv.includes('--managed')
/** 先在各个运行时里造好引擎自己的项目、归属、置顶 */
const withWorkspaces = process.argv.includes('--workspaces')
if (managed && withWorkspaces) {
  // 那时设备进程是主进程一开始就拉起来的，导入发生在造数据之前，造了也导不进去
  console.error('--workspaces 不能和 --managed 一起用')
  process.exit(1)
}
/** 带 --engines 时除了 Pi 还要起哪几个引擎（各自隔离的命令行）。没带就都是 null */
const engines = wantedEngines()
const threeEngines = process.argv.includes('--engines')
if (threeEngines && !managed) {
  // 主进程才认得 claude-code 和 dsh，也只有它会按设置给各个引擎配环境
  console.error('--engines 要和 --managed 一起用')
  process.exit(1)
}
/** 带 --ssh 时主进程把各 harness 的 SSH 入口也开起来（给官方桌面端的回归用），就绪行里给出 ssh 配置片段 */
const withSsh = process.argv.includes('--ssh')
if (withSsh && !managed) {
  console.error('--ssh 要和 --managed 一起用')
  process.exit(1)
}
/** 主进程的二进制和各 SSH 入口的端口：取 ssh 配置片段时要用 */
const service = { binary: '', ports: /** @type {string[]} */ ([]) }
const engine = join(repo, 'packages/pi/dist/pi/src/adapter.mjs')
const deviceMain = join(repo, 'packages/device/dist/device/src/main.mjs')
for (const [path, name] of [
  [engine, 'packages/pi'],
  [deviceMain, 'packages/device'],
  ...(engines.claude
    ? [[join(repo, 'packages/claude/dist/claude/src/adapter.mjs'), 'packages/claude']]
    : []),
  ...(engines.dsh ? [[join(repo, 'packages/dsh/dist/dsh/src/adapter.mjs'), 'packages/dsh']] : []),
]) {
  if (existsSync(path)) continue
  console.error(`没有找到 ${name} 的构建产物，请先运行 npm run build --prefix ${name}`)
  process.exit(1)
}
const piPackage = join(repo, 'packages/pi/node_modules/@earendil-works/pi-coding-agent')
const piEntry = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).main
const piCli = join(piPackage, dirname(piEntry), 'cli.js')

// 套接字路径有长度上限（macOS 104 字节，命令行卡在 100），临时目录的名字要短：
// 最长的一条是 <根>/h/claude-code/runtime.sock，系统给的临时目录太长就退到 /tmp
const longestSocket = (base) =>
  Buffer.byteLength(join(base, 'litch-dx-XXXXXX', 'h', 'claude-code', 'runtime.sock'))
const base = [tmpdir(), '/tmp'].find((directory) => longestSocket(directory) <= 96)
if (!base) {
  console.error('找不到路径够短的临时目录，套接字建不出来')
  process.exit(1)
}
const root = mkdtempSync(join(base, 'litch-dx-'))
// 相当于真实布局里的状态目录（~/.codex-harness-adapter）：<home>/<harness>/runtime.sock、<home>/device/device.sock
const home = join(root, 'h')
const dirs = {
  userHome: join(root, 'home'),
  app: join(root, 'work/app'),
  web: join(root, 'work/app/web'),
  notes: join(root, 'notes'),
  // 带 --engines 时才用：三个引擎各走一遍用的工作目录，是一个 git 仓库
  ...(threeEngines ? { tri: join(root, 'work/tri') } : {}),
}
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

/** 两个上游各造哪些会话。两边都有落在 work/app 下的，客户端里能看到一个工作区里混着两个 harness 的会话 */
const HARNESSES = [
  {
    id: 'pi',
    sessions: [
      {
        cwd: dirs.app,
        name: '给列表加上分页',
        turns: ['列表太长了，怎么分页？', '游标放在哪一层？'],
      },
      { cwd: dirs.web, name: '核对构建产物', turns: ['看一下目录里有什么。'], tool: 'ls -la' },
      { cwd: dirs.notes, name: null, turns: ['帮我想三个周报的小标题。'] },
    ],
    // 下面三项只有带 --workspaces 时才用：这个引擎自己的项目（sessions 是上面会话的序号）、置顶、自定义分区
    projects: [
      { name: '应用', roots: [dirs.app], sessions: [0] },
      { name: '笔记', roots: [dirs.notes], sessions: [2] },
    ],
    pinned: [0],
    sections: [],
  },
  {
    id: 'pi-b',
    sessions: [
      { cwd: dirs.app, name: '整理发布说明', turns: ['这一版改了什么？', '哪些要写进说明？'] },
      { cwd: dirs.app, name: '排查偶发的超时', turns: ['先确认一下现在的时间。'], tool: 'date' },
    ],
    // 根目录和 pi 的“应用”相同：导入后合成一个工作区，下面有两边的会话
    projects: [{ name: '应用（发布）', roots: [dirs.app], sessions: [0, 1] }],
    pinned: [],
    sections: [{ name: '稍后看', sessions: [1] }],
  },
]
  // 主进程只认固定的那几个标识，第二份 Pi 没有地方放
  .filter((spec) => !managed || spec.id === 'pi')
  .map((spec) => ({
    ...spec,
    state: join(home, spec.id),
    agent: join(root, 'agent', spec.id),
    socket: join(home, spec.id, 'runtime.sock'),
    /** 造会话时假模型要回的内容，按顺序取 */
    replies: [],
    /** 造出来的会话的标识，顺序和 sessions 一致 */
    threads: [],
  }))
const deviceSocket = join(home, 'device', 'device.sock')

// ---------- 假模型 ----------
// 两个运行时的模型地址带着各自的标识（/<标识>/v1），假模型据此知道请求是哪个 harness 发来的。
let requests = 0
let paced = false
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const model = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  const [, id, ...rest] = (req.url ?? '').split('/')
  // Claude Code 和 dsh 说的是另一种形态，怎么答在 client-fixture-anthropic.mjs
  if (id === 'claude-code' || id === 'dsh') {
    await serveAnthropic(id, `/${rest.join('/')}`, raw, res, 150)
    return
  }
  const body = JSON.parse(raw.toString() || '{}')
  const spec = HARNESSES.find((item) => item.id === id)
  requests++
  // 会话造完之后 Pi 这一路怎么回在 client-fixture-marks.mjs：话里带哪个词就做哪件事，都没有就把话带回来
  const reply = spec?.replies.shift() ?? (paced ? piReply(id, body) : { text: '好的。' })
  await sendCompletion(res, reply, { serial: requests, model: body.model })
})
await new Promise((done) => model.listen(0, '127.0.0.1', done))

// ---------- 子进程 ----------
/** 标识 → 正在运行的子进程。设备进程的标识是 device */
const children = new Map()
const logs = new Map()
let cleaning = false
// 环境只给必需的几项，不继承用户的任何凭据和配置
const baseEnv = { PATH: process.env.PATH, HOME: dirs.userHome, TMPDIR: root }

function launch(id, args, env, stdout = 'ignore', command = process.execPath) {
  const child = spawn(command, args, { env, stdio: ['ignore', stdout, 'pipe'] })
  children.set(id, child)
  child.stderr.on('data', (data) => logs.set(id, ((logs.get(id) ?? '') + data).slice(-4000)))
  child.on('exit', (code, signal) => {
    if (children.get(id) === child) children.delete(id)
    if (cleaning) return
    // 上游退出不算事故：可能是有人故意杀掉它来看客户端的反应。设备进程（或者管着它的主进程）没了才收场
    console.error(`${id} 退出了（${signal ?? `退出码 ${code}`}）`)
    if (id === 'device' || id === 'service') void cleanup(1, logs.get(id))
  })
  return child
}

/** 向系统要几个现在空着的回环端口 */
async function freePorts(count) {
  const servers = Array.from({ length: count }, () => net.createServer())
  const ports = await Promise.all(
    servers.map(
      (server) =>
        new Promise((done, fail) => {
          server.once('error', fail)
          server.listen(0, '127.0.0.1', () => done(server.address().port))
        }),
    ),
  )
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
  return ports
}

/**
 * 起真的适配器主进程，由它拉起 Pi 运行时和设备进程。
 * 它的环境里没有用户的 PATH：系统里装着的 claude、dsh、codex 一概找不到，不会被它拿去跑。
 */
async function startService(spec) {
  const binary = join(root, 'cha')
  const built = spawnSync('go', ['build', '-o', binary, './cmd/codex-harness-adapter'], {
    cwd: repo,
    encoding: 'utf8',
  })
  if (built.status !== 0)
    throw new Error(`适配器主进程没有编出来（需要本机有 go）：${built.stderr || built.error}`)
  if (threeEngines) {
    // 主进程一起来就照着设置起各个引擎，所以设置要先写好
    writeEngineSettings({
      home,
      root,
      modelUrl: `http://127.0.0.1:${model.address().port}`,
      engines,
    })
    prepareWorkDirectory(dirs.tri, engines)
  }
  const [claudePort, piPort, dshPort] = await freePorts(3)
  const ports = [
    ...['--claude-port', String(claudePort), '--pi-port', String(piPort)],
    ...['--dsh-port', String(dshPort)],
  ]
  service.binary = binary
  service.ports = ports
  const path = [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  // 原生 codex 装了就默认启用：交给主进程的 PATH 里不能有它，三个引擎的命令行也一样
  refuseHarnessOnPath(path)
  const ssh = withSsh ? '--ssh=on' : '--ssh=off'
  return launch(
    'service',
    ['start', '--home', home, '--root', repo, '--node', process.execPath, ssh, ...ports],
    {
      PATH: path.join(':'),
      HOME: dirs.userHome,
      TMPDIR: root,
      PI_CODING_AGENT_DIR: spec.agent,
      PI_CLI: piCli,
      CHA_CLAUDE_CLI: join(root, 'no-claude'),
    },
    'ignore',
    binary,
  )
}

function startUpstream(spec) {
  mkdirSync(spec.agent, { recursive: true })
  mkdirSync(spec.state, { recursive: true })
  return launch(spec.id, [engine, 'app-server', '--listen', `unix://${spec.socket}`], {
    ...baseEnv,
    CHA_PI_HOME: spec.state,
    PI_CODING_AGENT_DIR: spec.agent,
    PI_CLI: piCli,
  })
}

/** 先客气地结束，等一会儿还在就强杀；等它真的退出了再往下走，免得留下进程 */
function stop(child, graceMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const force = setTimeout(() => child.kill('SIGKILL'), graceMs)
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
  // 主进程要先把它管着的运行时和设备进程一个个收掉，多等它一会儿：强杀它会把那些进程留下
  await Promise.all(
    [...children].map(([id, child]) => stop(child, id === 'service' ? 30_000 : 3000)),
  )
  model.closeAllConnections()
  model.close()
  rmSync(root, { recursive: true, force: true })
  process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void cleanup(0))

// ---------- 作为客户端直接连上每个运行时，造会话 ----------
async function connect(socket) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return await new Promise((done, fail) => {
        const ws = new WebSocket(`ws+unix://${socket}:/`)
        ws.once('open', () => done(ws))
        ws.once('error', fail)
      })
    } catch {
      await pause(100)
    }
  }
  throw new Error('等了 30 秒，运行时还没有开始监听')
}

/** 以客户端的身份连上一个运行时自己的入口并握手 */
async function open(spec) {
  const ws = await connect(spec.socket)
  let nextId = 1
  const pending = new Map()
  const listeners = new Set()
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.method && message.id !== undefined) {
      // 造数据时不处理对面的请求，回一个错误让它别等
      ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'fixture' } }))
    } else if (message.method) {
      for (const listener of listeners) listener(message)
    } else {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry?.fail(new Error(`${entry.method}: ${message.error.message}`))
      else entry?.done(message.result)
    }
  })
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId++
      pending.set(id, { done, fail, method })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await call('initialize', {
    clientInfo: { name: 'litch-device-fixture', title: null, version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  ws.send(JSON.stringify({ method: 'initialized' }))
  return { call, listeners, close: () => ws.close() }
}

async function seed(spec) {
  const { call, listeners, close } = await open(spec)
  for (const session of spec.sessions) {
    const { thread } = await call('thread/start', { cwd: session.cwd, model: 'gate/gate' })
    spec.threads.push(thread.id)
    if (session.name) await call('thread/name/set', { threadId: thread.id, name: session.name })
    for (const [index, text] of session.turns.entries()) {
      if (session.tool && index === 0)
        spec.replies.push({ tools: [{ name: 'bash', args: { command: session.tool } }] })
      spec.replies.push({
        text: `（${spec.id}）${text.replace(/[？。]$/, '')}：已经看过了，结论写在这里。`,
      })
      const completed = new Promise((done) => {
        const listener = (message) => {
          if (message.method !== 'turn/completed' || message.params.threadId !== thread.id) return
          listeners.delete(listener)
          done(message.params.turn.status)
        }
        listeners.add(listener)
      })
      await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] })
      const status = await completed
      if (status !== 'completed') throw new Error(`${spec.id} 的回合没有正常结束：${status}`)
    }
  }
  close()
}

/**
 * 带 --workspaces 时：在每个运行时自己的入口上（官方桌面端用的那一面）造项目，把会话归进去、置顶、放进分区。
 * 设备进程起来时会把它们导入成设备级的工作区。先造 pi-b 的、隔一秒多再造 pi 的：
 * 两边根目录相同的那个项目，建得早的是 pi-b 的，合并后的名字应当是它的。
 */
async function seedWorkspaces() {
  const pinned = '01984de2-8f74-7c91-a3b2-5c5e937cf318'
  for (const spec of [...HARNESSES].reverse()) {
    const { call, close } = await open(spec)
    for (const [index, project] of spec.projects.entries()) {
      const created = await call('project/create', {
        name: project.name,
        roots: project.roots.map((path) => ({ path })),
        idempotencyKey: `fixture-${spec.id}-${index}`,
      })
      for (const session of project.sessions)
        await call('thread/metadata/update', {
          threadId: spec.threads[session],
          projectId: created.project.id,
        })
    }
    for (const session of spec.pinned)
      await call('thread/section/move', { threadId: spec.threads[session], sectionId: pinned })
    for (const section of spec.sections) {
      const created = await call('threadSection/create', { name: section.name })
      for (const session of section.sessions)
        await call('thread/section/move', {
          threadId: spec.threads[session],
          sectionId: created.section.id,
        })
    }
    close()
    // 项目的创建时间以秒计
    await pause(1100)
  }
}

/**
 * 带 --engines 时：等要起的那几个 harness 在聚合面上都可用了才算就绪。
 * 哪个等不到就照它自己说的原因报出来，不带着一个用不了的往下走
 */
async function enginesReady() {
  const wanted = engineIds(engines)
  const ws = await connect(deviceSocket)
  const replies = new Map()
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.id !== undefined && !message.method) replies.get(message.id)?.(message)
  })
  let nextId = 1
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId++
      replies.set(id, (message) =>
        message.error
          ? fail(new Error(`${method}: ${message.error.message}`))
          : done(message.result),
      )
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    await call('initialize', {
      clientInfo: { name: 'litch-device-fixture', title: null, version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        litchExtensions: ['harness'],
      },
    })
    ws.send(JSON.stringify({ method: 'initialized' }))
    let seen = []
    for (let waited = 0; waited < 90_000; waited += 250) {
      seen = (await call('runtime/info')).harnesses.filter((item) => wanted.includes(item.id))
      if (seen.length === wanted.length && seen.every((item) => item.available)) return
      await pause(250)
    }
    const down = seen
      .filter((item) => !item.available)
      .map((item) => `${item.id}：${item.unavailable?.message ?? '没说原因'}`)
    throw new Error(`等了 90 秒，还有引擎没起来（要的是 ${wanted.join('、')}）\n${down.join('\n')}`)
  } finally {
    ws.close()
  }
}

try {
  for (const spec of HARNESSES) {
    mkdirSync(spec.agent, { recursive: true })
    writeFileSync(
      join(spec.agent, 'models.json'),
      JSON.stringify({
        providers: {
          gate: {
            baseUrl: `http://127.0.0.1:${model.address().port}/${spec.id}/v1`,
            api: 'openai-completions',
            apiKey: 'fixture-only',
            models: [
              {
                id: 'gate',
                name: 'Gate',
                reasoning: true,
                input: ['text', 'image'],
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
      join(spec.agent, 'settings.json'),
      JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
    )
    installAskExtension(spec.agent)
    if (managed) await startService(spec)
    else startUpstream(spec)
  }
  await Promise.all(HARNESSES.map(seed))
  if (withWorkspaces) await seedWorkspaces()
  paced = true

  if (managed) {
    // 设备进程是主进程拉起来的：等聚合面能连上
    ;(await connect(deviceSocket)).close()
    if (threeEngines) await enginesReady()
  } else {
    // 设备进程：启动命令行和 Go 层拉起它时用的一样
    const device = launch(
      'device',
      [
        deviceMain,
        '--listen',
        `unix://${deviceSocket}`,
        '--state',
        join(home, 'device'),
        ...HARNESSES.flatMap((spec) => ['--upstream', `${spec.id}=unix://${spec.socket}`]),
      ],
      baseEnv,
      'pipe',
    )
    await new Promise((done, fail) => {
      let output = ''
      const timer = setTimeout(() => fail(new Error('等了 30 秒，设备进程还没有就绪')), 30_000)
      device.stdout.on('data', (data) => {
        output += data
        if (!output.split('\n').includes('LITCH_DEVICE_READY')) return
        clearTimeout(timer)
        done()
      })
    })
  }
} catch (error) {
  const tails = [...logs].map(([id, log]) => `--- ${id} ---\n${log}`).join('\n')
  await cleanup(1, `隔离设备没有起来：${error?.stack ?? error}\n${tails}`)
}

// 标准输入里的命令。标准输入没有接东西（或者已经关了）时这里什么都不会发生
createInterface({ input: process.stdin }).on('line', (line) => {
  const [command, id] = line.trim().split(/\s+/)
  if (managed) {
    if (line.trim())
      console.error('带 --managed 时运行时归适配器主进程管：停用、启用、重启请走设置接口')
    return
  }
  const spec = HARNESSES.find((item) => item.id === id)
  if (!spec || (command !== 'stop' && command !== 'start')) {
    if (line.trim())
      console.error(
        `不认识的命令：${line}（可用：stop|start ${HARNESSES.map((item) => item.id).join('|')}）`,
      )
    return
  }
  const running = children.get(id)
  if (command === 'stop') running?.kill('SIGKILL')
  else if (!running) startUpstream(spec)
})

/** 主进程自己给的 ssh 配置片段（`ssh-config`）：每个开着的入口一段，没开起来的那个它在 stderr 里说 */
function sshConfig() {
  const got = spawnSync(service.binary, ['ssh-config', '--home', home, ...service.ports], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: dirs.userHome, CHA_LANG: 'zh-CN' },
  })
  return { config: got.stdout, warnings: (got.stderr || '').trim(), status: got.status }
}

const ready = {
  socket: deviceSocket,
  root,
  home,
  dirs: { app: dirs.app, web: dirs.web, notes: dirs.notes },
  upstreams: HARNESSES.map((spec) => ({
    id: spec.id,
    socket: spec.socket,
    pid: children.get(spec.id)?.pid,
  })),
  devicePid: children.get('device')?.pid,
  // 带 --managed 时才有：适配器主进程的进程号。这时运行时和设备进程是它的子进程，上面两处的进程号没有
  ...(managed ? { managed: true, servicePid: children.get('service')?.pid } : {}),
  // 带 --engines 时才有：起了哪几个 harness、三个引擎各走一遍用的工作目录、里面那项技能的名字和正文里的记号
  ...(threeEngines
    ? { engines: { ids: engineIds(engines), cwd: spelledApart(dirs.tri), skill: FIXTURE_SKILL } }
    : {}),
  // 带 --ssh 时才有：各入口的 ssh 配置片段（别名是适配器默认的那几个，用的时候按需要改名）
  ...(withSsh ? { ssh: sshConfig() } : {}),
}
console.log(`LITCH_DEVICE_FIXTURE ${JSON.stringify(ready)}`)
console.log('隔离设备已就绪，按 Ctrl+C 结束并清理。')
