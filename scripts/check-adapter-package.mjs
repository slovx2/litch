// 发布包和安装脚本的容器验证：拿容器当“一台干净的 Linux 机器”，把装、连、升级、卸载过一遍。发版之前跑。
//
//   node scripts/check-adapter-package.mjs [--release 目录] [--skip-pi] [--go-from 目录] [--device-from 目录]
//     --release   验一份已经出好的发布包（scripts/package-adapter.mjs 的输出目录），不另外出；发版时验的就是要发的那一份
//     --skip-pi   不做“装一份 Pi、经聚合面跑通一个回合”那一段（那一段要从 npm 取 Pi）
//     后两个同 scripts/package-adapter.mjs，只在不带 --release 时有用
//   要有 Docker；没有就说明一句、以 0 退出。不带 --release 时先在仓库根目录 npm run build。
//
// 过的内容：
//   一、干净的 Debian（没有 Node、没有 Go），普通用户：从本地文件安装 → version →
//       照客户端经 ssh 的做法找命令（登录 shell 加补上的 PATH）→ device-start 给出就绪的那一行 →
//       经 device-proxy 的标准输入输出握手、取 runtime/info，列出各 harness 和不可用的原因。
//   二、同一台机器上装一份 Pi、起一个回环上的假模型，经聚合面在 Pi 上跑通一个回合。
//       再开一个带终端的进程、跑一遍 doctor 的终端检查：这台机器上没有 python3，伪终端桥是命令行自带的。
//   三、升级：服务在跑的时候装新版本，看链接、命令、还在跑的服务各是什么样；连装六个版本看旧版本的清理；
//       退回旧版本；校验和对不上不装；卸载之后状态目录还在。
//   四、联网安装：容器里起一个假的发布页，curl 和 wget 两条路各走一遍。
//   五、musl 的系统（Alpine）：安装脚本在动手之前就说清楚，什么都不留下。
//
// 从宿主机进容器用的是 docker exec -i，相当于客户端那边 ssh 的那一跳；线上的格式一样，
// 是标准输入输出里的 WebSocket（apps/desktop/src/transport-ssh.mts）。
// 容器、这次拉下来的镜像、临时目录跑完都清掉；本来就在机器上的镜像不动。容器里的状态目录是容器自己的。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import {
  CHECKSUMS,
  relabel,
  stageStandalone,
  withWork,
  writeArchive,
  writeChecksums,
} from './package-adapter.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const option = (name) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? process.argv[at + 1] : undefined
}
const skipPi = process.argv.includes('--skip-pi')

/** 镜像一律写精确的标签。TOOLBOX 里有 Node、curl 和 wget：装 Pi、试联网安装用，不当“干净的机器” */
const DEBIAN = 'debian:bookworm-20261005-slim'
const ALPINE = 'alpine:3.24.2'
const TOOLBOX = 'node:24.14.0-bookworm'

const NAME = 'codex-harness-adapter'
const HOME = '/home/tester'
const CLI = `${HOME}/.local/bin/${NAME}`
const BASE = `${HOME}/.local/share/${NAME}`
const STATE = `${HOME}/.${NAME}`

const docker = (args, options = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20, ...options })

if (docker(['version', '--format', '{{.Server.Arch}}']).status !== 0) {
  console.log('这台机器上没有可用的 Docker，发布包的容器验证跳过')
  process.exit(0)
}
const arch = { arm64: 'arm64', amd64: 'x64' }[
  docker(['version', '--format', '{{.Server.Arch}}']).stdout.trim()
]
if (!arch) throw new Error('Docker 服务端不是 arm64 也不是 amd64，没有对应的发布包')
const target = `linux-${arch}`

const run = randomBytes(3).toString('hex')
const containers = {
  debian: `litch-package-check-${run}-debian`,
  toolbox: `litch-package-check-${run}-toolbox`,
  alpine: `litch-package-check-${run}-alpine`,
}
/** 这次拉下来的镜像，跑完删掉；本来就有的不在这里面 */
const pulled = []
const started = []
const passed = []

const step = (title) => console.log(`\n== ${title}`)
const fact = (text) => console.log(`   ${text}`)
const pass = (text) => {
  passed.push(text)
  console.log(` ✓ ${text}`)
}

function ensureImage(image) {
  if (docker(['image', 'inspect', image]).status === 0) return
  fact(`拉取镜像 ${image}`)
  const result = docker(['pull', image], { stdio: ['ignore', 'ignore', 'pipe'] })
  if (result.status !== 0) throw new Error(`镜像 ${image} 拉不下来：${result.stderr}`)
  pulled.push(image)
}

/** 起一个一直闲着的容器。--init 让里面脱离出去的进程退出后有人收 */
function startContainer(name, image, setup) {
  ensureImage(image)
  const result = docker(['run', '-d', '--init', '--name', name, image, 'sleep', 'infinity'])
  if (result.status !== 0) throw new Error(`容器 ${name} 没起来：${result.stderr}`)
  started.push(name)
  const prepared = docker(['exec', name, 'sh', '-c', setup])
  if (prepared.status !== 0) throw new Error(`容器 ${name} 没备好：${prepared.stderr}`)
}

/**
 * docker exec 的参数：以普通用户、在它的主目录里、命令行说中文（下面按中文的提示判断结果）。
 * mode 是 -i（接着标准输入输出）或 -d（放到后台，不等它）；env 是另外要带的环境变量
 */
const asUser = (name, { user = 'tester', home = HOME, mode = '-i', env = {} } = {}) => [
  'exec',
  mode,
  '-u',
  user,
  '-w',
  home,
  ...Object.entries({ HOME: home, CHA_LANG: 'zh-CN', ...env }).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ]),
  name,
]

/** 在容器里跑一段 sh，返回退出码和输出。as 是 root 时以管理员跑（只用来备环境） */
function sh(name, script, { as = 'tester', home = HOME, input } = {}) {
  const prefix = as === 'root' ? ['exec', '-i', name] : asUser(name, { user: as, home })
  const result = docker([...prefix, 'sh', '-c', script], { input, timeout: 300_000 })
  return {
    code: result.status,
    out: result.stdout.trim(),
    err: result.stderr.trim(),
    all: `${result.stdout}${result.stderr}`.trim(),
  }
}

/** 同上，但必须成功，返回标准输出 */
function must(name, script, options) {
  const result = sh(name, script, options)
  if (result.code !== 0)
    throw new Error(`容器里这一步没成（退出码 ${result.code}）：${script}\n${result.all}`)
  return result.out
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 等到 probe 给出真值，最多等 ms 毫秒 */
async function until(probe, ms, what) {
  for (let waited = 0; waited < ms; waited += 200) {
    const value = await probe()
    if (value) return value
    await sleep(200)
  }
  throw new Error(`等了 ${ms / 1000} 秒：${what}`)
}

/**
 * 经 device-proxy 的标准输入输出连到聚合面并握手。宿主机这一头是 docker exec -i，
 * 相当于客户端那边的 ssh；上面跑的是 WebSocket，和客户端用的是同一种做法。
 */
function connect(name) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...asUser(name), CLI, 'device-proxy'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdin.on('error', () => {})
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
    // 地址只是个占位：真正的连接就是这条命令的标准输入输出
    const ws = new WebSocket('ws://device.invalid/', {
      createConnection: () => stream,
      perMessageDeflate: false,
    })
    let nextId = 1
    const pending = new Map()
    const notifications = []
    const waiting = new Set()
    ws.once('error', (error) => reject(new Error(`没接上聚合面：${error.message}\n${stderr}`)))
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.method && message.id !== undefined) {
        // 这里不处理对面的请求，回一个错误让它别等
        ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'check' } }))
      } else if (message.method) {
        notifications.push(message)
        for (const entry of waiting) {
          if (!entry.match(message)) continue
          waiting.delete(entry)
          entry.done(message)
        }
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
    /** 等一条对得上的通知，最多等 ms 毫秒 */
    const waitFor = (match, ms, what) =>
      new Promise((done, fail) => {
        const entry = { match, done }
        waiting.add(entry)
        setTimeout(() => {
          if (waiting.delete(entry)) fail(new Error(`等了 ${ms / 1000} 秒：${what}`))
        }, ms).unref()
      })
    ws.once('open', async () => {
      try {
        await call('initialize', {
          clientInfo: { name: 'litch-package-check', title: null, version: '0.0.0' },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            litchExtensions: ['harness'],
          },
        })
        ws.send(JSON.stringify({ method: 'initialized' }))
        resolve({
          call,
          waitFor,
          notifications,
          close() {
            ws.terminate()
            child.kill('SIGKILL')
          },
        })
      } catch (error) {
        reject(error)
      }
    })
  })
}

/** device-start：返回它在标准输出给的那一行 */
function deviceStart(name) {
  const result = sh(name, `${CLI} device-start --ssh=off`)
  assert.equal(result.code, 0, `device-start 没成：${result.all}`)
  const line = JSON.parse(result.out.split('\n').at(-1))
  assert.equal(line.ready, true)
  return line
}

/** 停掉常驻服务，等它退干净。按 device-start 报的进程号，不按名字 */
async function stopService(name, pid) {
  must(name, `kill ${pid}`)
  await until(
    () => sh(name, `kill -0 ${pid} 2>/dev/null`).code !== 0,
    20_000,
    `常驻服务（进程 ${pid}）没有退出`,
  )
}

/** 安装目录里现在有哪些版本、当前是哪一版 */
function installedState(name, home = HOME, user = 'tester') {
  const base = `${home}/.local/share/${NAME}`
  const out = must(
    name,
    `cd ${base} && readlink current && for d in */; do [ -L "\${d%/}" ] || printf '%s ' "\${d%/}"; done`,
    { as: user, home },
  )
  const [current, versions = ''] = out.split('\n')
  return { current, versions: versions.trim().split(' ').filter(Boolean).sort() }
}

/** --release：拿一份已经出好的发布包来验。核对它和清单对得上，解开，返回它和解开后的样子 */
function unpackRelease(directory, outDir, work) {
  const [prefix, suffix] = [`${NAME}-`, `-${target}.tar.gz`]
  const names = readdirSync(directory).filter(
    (name) => name.startsWith(prefix) && name.endsWith(suffix),
  )
  if (names.length !== 1) {
    throw new Error(`${directory} 里应当正好有一个 ${target} 的压缩包，找到 ${names.length} 个`)
  }
  const [name] = names
  const file = join(outDir, name)
  cpSync(join(directory, name), file)
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
  const listed = readFileSync(join(directory, CHECKSUMS), 'utf8').split('\n')
  if (!listed.includes(`${sha256}  ${name}`)) throw new Error(`${name} 和校验和清单对不上`)
  const unpacked = spawnSync('tar', ['-xzf', file, '-C', work], { encoding: 'utf8' })
  if (unpacked.status !== 0) throw new Error(`${name} 解不开：${unpacked.stderr}`)
  const version = name.slice(prefix.length, -suffix.length)
  return {
    real: { file, name, sha256, bytes: statSync(file).size },
    staged: { root: join(work, `${NAME}-${version}-${target}`), target, version },
  }
}

/** 这次验证要用的包：一个真版本号的，加六个只换了版本号的（装旧的再装新的要用） */
async function buildPackages(outDir, site) {
  const release = option('--release')
  step(release ? `验 ${release} 里 ${target} 的发布包` : `出 ${target} 的发布包`)
  const built = await withWork(outDir, async (work) => {
    let staged
    let real
    if (release) {
      ;({ staged, real } = unpackRelease(release, outDir, work))
    } else {
      staged = await stageStandalone({
        target,
        work,
        goFrom: option('--go-from'),
        deviceFrom: option('--device-from'),
      })
      real = await writeArchive(staged, outDir)
    }
    const version = staged.version
    const fakes = []
    for (let number = 1; number <= 6; number++) {
      relabel(staged, `0.0.${number}-check`)
      // 这几个只在验证里用，压得快比压得小要紧
      fakes.push({ version: staged.version, ...(await writeArchive(staged, outDir, 1)) })
    }
    return { version, real, fakes }
  })
  writeChecksums(outDir, [built.real, ...built.fakes])
  // 验已有的发布包时，安装脚本也用和它一起出的那一份
  cpSync(join(release ?? join(repo, 'scripts'), 'install.sh'), join(outDir, 'install.sh'))
  cpSync(
    join(repo, 'scripts', 'check-adapter-package-guest.mjs'),
    join(outDir, 'check-adapter-package-guest.mjs'),
  )
  // 假的发布页：最新的是第六个，第五个是上一版。清单里最新的排在前面
  mkdirSync(site)
  const [older, latest] = built.fakes.slice(4)
  for (const archive of [older, latest]) cpSync(archive.file, join(site, archive.name))
  writeFileSync(
    join(site, CHECKSUMS),
    [latest, older].map((archive) => `${archive.sha256}  ${archive.name}\n`).join(''),
  )
  for (const file of ['install.sh', 'check-adapter-package-guest.mjs']) {
    cpSync(join(outDir, file), join(site, file))
  }
  fact(`${built.real.name}  ${(built.real.bytes / 1024 / 1024).toFixed(1)} MB`)
  return built
}

/** 一、干净的 Debian：安装、找命令、拉起服务、握手 */
async function cleanMachine(outDir, built) {
  const name = containers.debian
  step(`干净的 Debian（${DEBIAN}）`)
  startContainer(name, DEBIAN, 'useradd -m -s /bin/bash tester && mkdir /pkg')
  const copied = docker(['cp', `${outDir}/.`, `${name}:/pkg/`])
  assert.equal(copied.status, 0, copied.stderr)
  const tools = must(name, 'for t in node go curl wget python3; do command -v $t || true; done')
  assert.equal(tools, '', `这不是一台干净的机器：${tools}`)
  fact(
    `系统：Debian ${must(name, 'cat /etc/debian_version')}，${must(name, 'getconf GNU_LIBC_VERSION')}；没有 node、go、curl、wget、python3`,
  )

  const installed = sh(name, `sh /pkg/install.sh --from /pkg/${built.real.name}`)
  assert.equal(installed.code, 0, installed.all)
  assert.match(installed.out, new RegExp(`已安装 ${NAME} ${built.version}`))
  assert.equal(must(name, `${CLI} version`), `${NAME} ${built.version}`)
  pass(`从本地文件安装（核对了校验和），version 报 ${built.version}`)

  const offline = sh(name, 'sh /pkg/install.sh')
  assert.notEqual(offline.code, 0)
  assert.match(offline.err, /没有 curl，也没有 wget/)
  pass('机器上没有 curl 和 wget 时联网安装给出明确的说法，指到 --from')

  // 客户端经 ssh 找命令的做法：脚本从标准输入喂给 sh，先换进登录 shell，再在 PATH 后面补上 ~/.local/bin。
  // 直接拿客户端那份脚本来跑，它找适配器用的就是这个命令名
  const { probeScript } = await import('../apps/desktop/src/ssh/script.mts')
  const probe = probeScript()
  // 经 ssh 登录时 SHELL 是这个用户的登录 shell，docker exec 不会设，这里补上
  const probed = docker([...asUser(name, { env: { SHELL: '/bin/bash' } }), 'sh'], {
    input: probe.text,
  })
  const answer = probed.stdout.slice(probed.stdout.indexOf(probe.marker))
  assert.equal(probed.status, 0, `客户端的探测脚本没找到命令：${probed.stdout}${probed.stderr}`)
  assert.match(answer, new RegExp(`^adapterVersion=${NAME} ${built.version}$`, 'm'))
  const bare = sh(name, `command -v ${NAME}`)
  const login = sh(name, `bash -lc 'command -v ${NAME}'`)
  fact(
    `不经登录 shell 直接找命令：${bare.code === 0 ? '找得到' : '找不到'}；bash 登录 shell 里：${login.code === 0 ? '找得到' : '找不到'}`,
  )
  pass('照客户端经 ssh 的做法（登录 shell 加补上的 PATH）找得到命令，报得出版本')

  // doctor 要用 Node 去问引擎。这台机器上没有 node 命令，它得自己用上随包带的那一份
  const doctor = sh(name, `${CLI} doctor --harness pi`)
  assert.ok(!/Node\.js/.test(doctor.all), `doctor 没用上随包带的 Node：${doctor.all}`)
  assert.match(doctor.all, /没有找到 Pi 的命令行/)
  pass('doctor 不带 --node 也用得上随包带的 Node（报的是没装 Pi，不是找不到 Node）')

  const ready = deviceStart(name)
  assert.equal(ready.started, true)
  assert.equal(ready.socket, `${STATE}/device/device.sock`)
  fact(`就绪的那一行：${JSON.stringify(ready)}`)
  const service = must(name, `tr '\\0' ' ' </proc/${ready.pid}/cmdline`)
  assert.ok(service.includes(`--node ${BASE}/${built.version}/libexec/node/bin/node`), service)
  pass('device-start 给出就绪的那一行；常驻服务用的是随包带的 Node')

  const client = await connect(name)
  const info = await client.call('runtime/info', {})
  client.close()
  assert.equal(info.device.version, built.version)
  assert.equal(info.device.os, 'linux')
  fact(
    `设备：${info.device.hostname}，${info.device.os}，设备服务 ${info.device.version}，扩展 ${info.device.extensions.join('、')}`,
  )
  for (const harness of info.harnesses) {
    assert.equal(harness.available, false, `${harness.id} 不该可用：这台机器上什么都没装`)
    assert.ok(
      harness.unavailable?.kind && harness.unavailable.message,
      `${harness.id} 没有给出原因`,
    )
    fact(`${harness.id}：${harness.unavailable.kind}，${harness.unavailable.message}`)
  }
  const ids = info.harnesses.map((harness) => harness.id)
  for (const id of ['claude-code', 'pi']) assert.ok(ids.includes(id), `列表里没有 ${id}`)
  pass(`经 device-proxy 握手并取到 runtime/info：${ids.join('、')} 各有不可用的原因`)
  return ready
}

/** 经聚合面开一个带终端的 shell：核对它看到的行列数，敲一行进去，看输出和退出码。返回终端上的内容 */
async function terminal(client, cwd) {
  const processHandle = `check-terminal-${run}`
  const exited = client.waitFor(
    (message) =>
      message.method === 'process/exited' && message.params.processHandle === processHandle,
    30_000,
    '带终端的进程没有结束',
  )
  await client.call('process/spawn', {
    processHandle,
    command: ['/bin/sh'],
    cwd,
    tty: true,
    size: { rows: 7, cols: 13 },
    timeoutMs: null,
  })
  await client.call('process/writeStdin', {
    processHandle,
    deltaBase64: Buffer.from('stty size; echo terminal-$((40+2)); exit 3\n').toString('base64'),
  })
  const { params } = await exited
  const screen = client.notifications
    .filter(
      (message) =>
        message.method === 'process/outputDelta' && message.params.processHandle === processHandle,
    )
    .map((message) => Buffer.from(message.params.deltaBase64, 'base64').toString())
    .join('')
  assert.equal(params.exitCode, 3, `终端里的 shell 退出码不对：${JSON.stringify(screen)}`)
  assert.match(screen, /7 13/, '终端的行列数不是开的时候给的')
  assert.match(screen, /terminal-42/, '敲进去的命令没有跑出结果')
  return screen
}

/** 二、装一份 Pi，起假模型，经聚合面跑一个回合 */
async function piTurn(running) {
  const name = containers.debian
  step('装一份 Pi，经聚合面跑一个回合')
  const version = JSON.parse(readFileSync(join(repo, 'protocol', 'versions.json'), 'utf8')).piCli
  // Pi 带着分平台的依赖，要在 Linux 上装：借有 npm 的那个容器装好，再整个搬过来
  const install = sh(
    containers.toolbox,
    `npm install --prefix /opt/pi --no-audit --no-fund --loglevel=error @earendil-works/pi-coding-agent@${version}`,
    { as: 'root' },
  )
  assert.equal(install.code, 0, `Pi 没装上：${install.all}`)
  const moved = spawnSync(
    'sh',
    [
      '-c',
      `docker exec ${containers.toolbox} tar -cf - -C /opt pi | docker exec -i ${name} tar -xf - -C /opt`,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(moved.status, 0, moved.stderr)
  const piCli = '/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
  must(name, `test -f ${piCli}`)
  fact(`Pi ${version} 装在 /opt/pi（机器上仍然没有 node 命令）`)

  await stopService(name, running.pid)
  const node = `${BASE}/current/libexec/node/bin/node`
  // 假模型也用随包带的那份 Node 跑
  const guest = '/pkg/check-adapter-package-guest.mjs'
  docker([...asUser(name, { mode: '-d' }), node, guest, 'model', `${HOME}/model.port`])
  const port = await until(
    () => sh(name, `cat ${HOME}/model.port 2>/dev/null`).out,
    15_000,
    '假模型没起来',
  )
  const models = {
    providers: {
      gate: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        apiKey: 'check-only',
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
  }
  const settings = { defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }
  must(name, `mkdir -p ${HOME}/pi-agent ${HOME}/work && cat >${HOME}/pi-agent/models.json`, {
    input: JSON.stringify(models),
  })
  must(name, `cat >${HOME}/pi-agent/settings.json`, { input: JSON.stringify(settings) })
  // 指路的变量写进状态目录的环境文件：经 ssh 拉起服务时也是从这里读
  must(name, `umask 077 && cat >${STATE}/env`, {
    input: `PI_CLI=${piCli}\nPI_CODING_AGENT_DIR=${HOME}/pi-agent\n`,
  })

  const ready = deviceStart(name)
  assert.equal(ready.started, true)
  const client = await connect(name)
  try {
    const pi = await until(
      async () => {
        const info = await client.call('runtime/info', {})
        const harness = info.harnesses.find((entry) => entry.id === 'pi')
        if (harness?.available) return harness
        // 明确起不来的就不等了，把原因带出来
        if (['notInstalled', 'versionTooLow', 'startFailed'].includes(harness?.unavailable?.kind)) {
          throw new Error(`Pi 没起来：${harness.unavailable.message}`)
        }
        return null
      },
      60_000,
      'Pi 一直不可用',
    )
    fact(`pi 可用了，本体版本 ${pi.version}`)
    const { thread } = await client.call('thread/start', {
      cwd: `${HOME}/work`,
      model: 'gate/gate',
      harness: 'pi',
    })
    const said = `发布包验证 ${run}`
    const done = client.waitFor(
      (message) => message.method === 'turn/completed' && message.params.threadId === thread.id,
      90_000,
      '回合没有结束',
    )
    await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: said }] })
    const completed = await done
    assert.equal(completed.params.turn.status, 'completed')
    const reply = client.notifications
      .filter((message) => message.method === 'item/completed')
      .map((message) => message.params.item)
      .find((item) => item.type === 'agentMessage')
    assert.ok(reply?.text.includes(`收到：${said}`), `回话对不上：${JSON.stringify(reply)}`)
    fact(`会话 ${thread.id}（harness=${thread.harness}），模型回话：${reply.text.trim()}`)
    pass('在 Pi 上新建会话、跑通一个回合，回话对得上发出去的那一句')

    // 终端。带终端的命令由命令行自带的伪终端桥（pty-bridge 子命令）来起，这台机器上没有 python3：
    // 原来的桥是 python 写的，在这样的机器上终端用不了。两条路各走一遍：
    // 聚合面上的终端由设备进程起，doctor 的终端检查由引擎的运行时起。
    const screen = await terminal(client, `${HOME}/work`)
    fact(`终端里看到的：${JSON.stringify(screen)}`)
    pass('聚合面上开得了带终端的进程：行列数、输入、输出、退出码都对（机器上没有 python3）')
    const doctor = sh(name, `${CLI} doctor --harness pi`)
    assert.equal(doctor.code, 0, doctor.all)
    assert.ok(doctor.out.includes('[pi] 检查通过：引擎与终端可用。'), doctor.all)
    pass('doctor 的终端检查通过（由引擎的运行时起的伪终端）')
  } finally {
    client.close()
  }
  return ready
}

/** 三、升级。进来时装着真版本号的那一版，它的常驻服务在跑 */
async function upgrade(built, running) {
  const name = containers.debian
  step('升级：服务在跑的时候装新版本')
  const [v1, v2, v3, v4, v5, v6] = built.fakes
  const install = (archive, from = '/pkg') =>
    sh(name, `sh /pkg/install.sh --from ${from}/${archive.name}`)
  const versionsOf = (...archives) => archives.map((archive) => archive.version).sort()

  let result = install(v1)
  assert.equal(result.code, 0, result.all)
  assert.ok(result.out.includes(`已从 ${built.version} 换到 ${v1.version}`), result.out)
  assert.ok(
    result.out.includes(`${built.version} 的常驻服务还在跑（进程 ${running.pid}）`),
    result.out,
  )
  assert.equal(must(name, `${CLI} version`), `${NAME} ${v1.version}`)
  assert.deepEqual(installedState(name), {
    current: v1.version,
    versions: [built.version, v1.version].sort(),
  })
  pass('装上新版本：链接一步换过去，命令报新版本，旧版本的目录留着；脚本指出旧版本的服务还在跑')

  // 现状：新装的命令行执行 device-start，接上的是还在跑的旧服务
  const attached = deviceStart(name)
  assert.equal(attached.started, false)
  assert.equal(attached.pid, running.pid)
  let client = await connect(name)
  let info = await client.call('runtime/info', {})
  client.close()
  assert.equal(info.device.version, built.version)
  fact(
    `新版本的 device-start：${JSON.stringify(attached)}；设备服务报的版本仍是 ${info.device.version}`,
  )
  pass('旧服务在跑时，新版本的 device-start 直接接上它（不重启、不替换），在跑的仍是旧版本')

  // 照安装脚本说的办法换上新版：先请旧服务闲着的话停下（新版的命令行去停旧版的服务）。
  // 刚才那条连接断开要一小会儿，还算着“有客户端连着”的那几次它不停，退出码是 4
  assert.ok(result.out.includes(`~/.local/bin/${NAME} device-stop --if-idle`), result.out)
  let stopped = sh(name, `${CLI} device-stop --if-idle`)
  for (let attempt = 1; attempt < 20 && stopped.code === 4; attempt++) {
    await sleep(500)
    stopped = sh(name, `${CLI} device-stop --if-idle`)
  }
  assert.equal(stopped.code, 0, stopped.all)
  const report = JSON.parse(stopped.out.split('\n').at(-1))
  assert.deepEqual(
    [report.result, report.pid, report.service.version],
    ['stopped', running.pid, built.version],
  )
  assert.notEqual(
    sh(name, `kill -0 ${running.pid} 2>/dev/null`).code,
    0,
    'device-stop 返回时旧服务还在',
  )
  pass('device-stop --if-idle 停掉了闲着的旧服务，等它退出才返回')
  const fresh = deviceStart(name)
  assert.equal(fresh.started, true)
  assert.equal(fresh.service.version, v1.version)
  client = await connect(name)
  info = await client.call('runtime/info', {})
  client.close()
  assert.equal(info.device.version, v1.version)
  pass('停掉旧服务之后，device-start 拉起来的是新版本')

  // 一路装到第五个：当前的之外正好四个旧的（其中一个有服务在跑），最早装的真版本号那一版排到了第五，被清掉
  for (const archive of [v2, v3, v4, v5]) {
    result = install(archive)
    assert.equal(result.code, 0, result.all)
  }
  assert.ok(result.out.includes(`清掉了旧版本 ${built.version}`), result.out)
  assert.deepEqual(installedState(name), {
    current: v5.version,
    versions: versionsOf(v1, v2, v3, v4, v5),
  })
  pass('连装几个版本：当前的之外留最近的 4 个，第五个被清掉')

  // 再装一个：按次序该清的是第一个假版本，但它的服务还在跑，留着
  result = install(v6)
  assert.equal(result.code, 0, result.all)
  assert.ok(!result.out.includes('清掉了旧版本'), result.out)
  assert.deepEqual(installedState(name), {
    current: v6.version,
    versions: versionsOf(v1, v2, v3, v4, v5, v6),
  })
  pass('正有常驻服务在跑的那一版不清，哪怕它已经排到第五个之后')

  await stopService(name, fresh.pid)
  result = install(v6)
  assert.ok(result.out.includes(`已经是 ${v6.version}`), result.out)
  assert.deepEqual(installedState(name).versions, versionsOf(v2, v3, v4, v5, v6))
  pass('服务停了之后再跑一遍安装：同一版本不重装，原先因为有服务在跑而留着的那一版清掉了')

  result = install(v3)
  assert.ok(result.out.includes(`已从 ${v6.version} 换到 ${v3.version}`), result.out)
  assert.equal(must(name, `${CLI} version`), `${NAME} ${v3.version}`)
  pass('退回旧版本')

  must(
    name,
    `mkdir ${HOME}/bad && cp /pkg/${v5.name} /pkg/${CHECKSUMS} ${HOME}/bad/ && printf x >>${HOME}/bad/${v5.name}`,
  )
  result = install(v5, `${HOME}/bad`)
  assert.notEqual(result.code, 0)
  assert.match(result.err, /校验和对不上，不装/)
  assert.equal(installedState(name).current, v3.version)
  assert.equal(must(name, `ls -A ${BASE} | grep -c '^\\.tmp' || true`), '0')
  pass('校验和对不上就停：当前版本不变，不留临时目录')
}

/** 卸载：只删程序，状态目录还在 */
async function uninstall() {
  const name = containers.debian
  step('卸载')
  const ready = deviceStart(name)
  // 用装好的包里自带的那份安装脚本
  const result = sh(name, `sh ${BASE}/current/install.sh --uninstall`)
  assert.equal(result.code, 0, result.all)
  assert.match(result.out, /已卸载/)
  assert.ok(result.out.includes(`常驻服务还在跑（进程 ${ready.pid}）`), result.out)
  assert.match(result.out, /状态目录 .* 没有动/)
  must(name, `test ! -e ${BASE} && test ! -e ${CLI} && test ! -L ${CLI}`)
  must(name, `test -s ${STATE}/device/device.sqlite && test -d ${STATE}/pi`)
  await stopService(name, ready.pid)
  assert.match(sh(name, 'sh /pkg/install.sh --uninstall').out, /没有装过/)
  pass('卸载：命令和程序目录删掉了，状态目录原样留着；还在跑的服务给出了该怎么停')
}

/** 四、联网安装：容器里起一个假的发布页，curl 和 wget 各走一遍 */
async function network(siteDir, built) {
  const name = containers.toolbox
  const user = { as: 'node', home: '/home/node' }
  step(`联网安装（${TOOLBOX}，发布页是容器里的假页面）`)
  const [, , , , v5, v6] = built.fakes
  assert.equal(docker(['cp', siteDir, `${name}:/site`]).status, 0)
  docker([
    'exec',
    '-d',
    name,
    'node',
    '/site/check-adapter-package-guest.mjs',
    'releases',
    '/site',
    '/tmp/site.port',
  ])
  const port = await until(
    () => sh(name, 'cat /tmp/site.port 2>/dev/null', { as: 'root' }).out,
    15_000,
    '假的发布页没起来',
  )
  const site = `http://127.0.0.1:${port}`
  const install = (args = '') => sh(name, `sh /site/install.sh --base-url ${site} ${args}`, user)
  const state = () => installedState(name, user.home, user.as)

  // 第一次照说明里的写法来：安装脚本也从发布页取，经管道交给 sh
  let result = sh(
    name,
    `curl -fsSL ${site}/latest/download/install.sh | sh -s -- --base-url ${site}`,
    user,
  )
  assert.equal(result.code, 0, result.all)
  assert.ok(
    result.out.includes(`下载 ${v6.name}`) && result.out.includes(`已安装 ${NAME} ${v6.version}`),
    result.out,
  )
  assert.equal(must(name, `/home/node/.local/bin/${NAME} version`, user), `${NAME} ${v6.version}`)
  pass('照说明里的一行命令（curl … | sh）：从清单知道最新是哪一版，下载、核对、装上')

  result = install()
  assert.ok(result.out.includes(`已经是 ${v6.version}`) && !result.out.includes('下载'), result.out)
  pass('重跑：装过的版本不重复下载')

  result = install(`--version ${v5.version}`)
  assert.ok(result.out.includes(`已从 ${v6.version} 换到 ${v5.version}`), result.out)
  assert.deepEqual(state(), { current: v5.version, versions: [v5.version, v6.version].sort() })
  pass('指定版本安装')

  result = install('--version 9.9.9')
  assert.notEqual(result.code, 0)
  assert.match(result.err, /下载失败/)
  assert.equal(state().current, v5.version)
  pass('发布页上没有的版本：下载失败就停，当前版本不变')

  must(name, 'mv "$(command -v curl)" /tmp/curl.off', { as: 'root' })
  must(name, 'sh /site/install.sh --uninstall', user)
  result = install()
  assert.equal(result.code, 0, result.all)
  assert.equal(must(name, `/home/node/.local/bin/${NAME} version`, user), `${NAME} ${v6.version}`)
  pass('没有 curl 时用 wget 也装得上')

  must(name, `printf x >>/site/${v6.name}`, { as: 'root' })
  must(name, 'sh /site/install.sh --uninstall', user)
  result = install()
  assert.notEqual(result.code, 0)
  assert.match(result.err, /校验和对不上，不装/)
  must(name, `test ! -e /home/node/.local/share/${NAME}`, user)
  pass('下载下来的压缩包校验和对不上：不装，什么都不留')
}

/** 五、musl：在动手之前说清楚 */
async function musl(pkgDir, built) {
  const name = containers.alpine
  step(`musl 的系统（${ALPINE}）`)
  startContainer(name, ALPINE, 'adduser -D tester && mkdir /pkg')
  for (const file of [built.real.name, CHECKSUMS, 'install.sh']) {
    assert.equal(docker(['cp', join(pkgDir, file), `${name}:/pkg/${file}`]).status, 0)
  }
  const result = sh(name, `sh /pkg/install.sh --from /pkg/${built.real.name}`)
  assert.notEqual(result.code, 0)
  assert.match(result.err, /musl/)
  must(name, `test ! -e ${BASE}`)
  fact(`安装脚本说：${result.err.split('\n')[0]}`)
  // 不拦的话是什么样：解开来直接跑
  must(name, `mkdir ${HOME}/raw && tar -xzf /pkg/${built.real.name} -C ${HOME}/raw`)
  const raw = `${HOME}/raw/${NAME}-${built.version}-${target}/libexec`
  must(name, `test -f ${raw}/packages/device/dist/device/src/main.mjs`)
  const node = sh(name, `${raw}/node/bin/node --version`)
  assert.notEqual(node.code, 0)
  fact(`直接跑随包带的 Node：退出码 ${node.code}，${node.all.split('\n')[0]}`)
  fact(`直接跑命令行（不依赖 C 库）：${sh(name, `${raw}/bin/${NAME} version`).all}`)
  pass('musl：安装脚本在动手之前报错并说明原因，什么都没留下；busybox 的 tar 解得开这个压缩包')
}

mkdirSync(join(repo, '.artifacts'), { recursive: true })
const outDir = mkdtempSync(join(repo, '.artifacts', 'package-check-'))
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const name of started) docker(['rm', '-f', name])
  for (const image of pulled) docker(['rmi', image])
  rmSync(outDir, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup()
    process.exit(1)
  })
}

let failure = null
try {
  const pkgDir = join(outDir, 'pkg')
  const built = await buildPackages(pkgDir, join(outDir, 'site'))
  startContainer(containers.toolbox, TOOLBOX, 'true')
  let running = await cleanMachine(pkgDir, built)
  if (!skipPi) running = await piTurn(running)
  await upgrade(built, running)
  await uninstall()
  await network(join(outDir, 'site'), built)
  await musl(pkgDir, built)
} catch (error) {
  failure = error
} finally {
  cleanup()
}
if (failure) {
  console.error(
    `\n发布包的容器验证没有通过（已过 ${passed.length} 项）：\n${failure.stack ?? failure}`,
  )
  process.exit(1)
}
console.log(`\n发布包的容器验证通过：${passed.length} 项${skipPi ? '（没有做 Pi 的回合）' : ''}`)
process.exit(0)
