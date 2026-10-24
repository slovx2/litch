// 移动端的端到端用例：在安卓模拟器上装 release 包，用 Maestro 跑 e2e/flows 下的流程（测试链接加 testID 驱动，不点坐标）。
// 一条命令从头到尾：起模拟器（不给 --serial 就在 --port 上无窗口起一台）→ 装包 → 要夹具的流程先起夹具 → 跑流程 → 收尾（停夹具、撤端口映射、
// 关掉自己起的模拟器、删临时目录）。有流程没过返回非零；被 Ctrl-C 打断时收完尾退出码是 130。
//
// 用法（apps/mobile 里，Node 24）：npm run e2e -- [选项]
//   --only mock|fixture|<流程文件>   只跑一组或一个（可以给几次）；默认全跑
//   --tags smoke                      只跑带这个标签的流程（门禁用）
//   --apk <路径>                      默认 android/app/build/outputs/apk/release/app-release.apk
//   --build                           先打 release 包（expo prebuild --clean 再 assembleRelease，要 JAVA_HOME 和 ANDROID_HOME）
//   --no-install                      用模拟器上已经装着的包
//   --serial <序列号>                 用已经开着的这台（收尾不关它）；不给就用 --avd 在 --port 上起一台（默认 5590），
//                                     那个端口上已经有设备（不管什么状态）就报错，不用别人的、也不再起一台
//   --avd <名字>                      默认 tyrs_hand_e2e_api35；以只读方式起（-read-only），不改 AVD、可以和别人同时用
//   --screen 320x640@160              把模拟器的屏幕改成这个尺寸和密度（wm size/density）再跑；CI 的模拟器就是这个，本地复现 CI 用
//   --no-retry                        没过的不重跑（默认重跑一次，重跑才过的会点名“不稳”）
//   --keep                            跑完不关模拟器、留下 Maestro 的调试输出（截图、日志），排查失败用，用完自己删
// 要的环境：ANDROID_HOME（默认 ~/Library/Android/sdk）、JDK 17 以上（JAVA_HOME，Maestro 和 gradle 都要）、
// Maestro 2.3.0（MAESTRO 指过去，或者在 PATH 里）；跑夹具的流程要先在仓库根目录 npm run build（适配器、Pi、设备进程）。
// LITCH_E2E_ARTIFACTS=<目录>：Maestro 的调试输出（失败时的截图、日志）放到这里并留着（CI 上传用）；不给就放临时目录、跑完删掉。
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvalSignedText } from '../../../packages/protocol/src/client-approvals.mts'
import { encodePairPayload } from '../../../packages/protocol/src/device-pairing.mts'
import { deviceRpc } from './device-rpc.mjs'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(mobile, '../..')
const flowsDir = join(mobile, 'e2e/flows')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const arg = (name, fallback = null) => {
  const at = argv.indexOf(name)
  return at < 0 ? fallback : argv[at + 1]
}
const args = (name) => argv.flatMap((value, index) => (argv[index - 1] === name ? [value] : []))

const PKG = 'dev.litch.app'
/** 手机批准的流程给模拟器设的锁屏密码（流程里在系统验证框输入它） */
const LOCK_PIN = '1111'
const androidHome = process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk')
const adbBin = join(androidHome, 'platform-tools/adb')
const emulatorBin = join(androidHome, 'emulator/emulator')
const maestroBin = process.env.MAESTRO ?? 'maestro'
const apk = resolve(
  arg('--apk', join(mobile, 'android/app/build/outputs/apk/release/app-release.apk')),
)
const keep = flag('--keep')
const work = mkdtempSync(join(tmpdir(), 'litch-e2e-'))
/** Maestro 的调试输出（失败时的截图、日志）：给了 LITCH_E2E_ARTIFACTS 就放那里、不删（CI 上传用），不给就放临时目录里 */
const artifacts = process.env.LITCH_E2E_ARTIFACTS ? resolve(process.env.LITCH_E2E_ARTIFACTS) : null
const debugDir = artifacts ?? join(work, 'debug')
const log = (line) => console.log(`[e2e] ${line}`)
const since = (start) => `${((Date.now() - start) / 1000).toFixed(1)}s`

/** 收尾要做的事，后登记的先做；出错、被打断都会走到 */
const cleanups = []
/** 收尾只跑一次：信号和主流程的 finally 都会来调，等的是同一次 */
let cleaning = null
const cleanup = () =>
  (cleaning ??= (async () => {
    // 一项项取出来做：收尾途中主流程又登记的也收得到
    while (cleanups.length > 0) {
      try {
        await cleanups.pop()()
      } catch (error) {
        log(`收尾时出错（接着收）：${error.message}`)
      }
    }
  })())
/** 被 Ctrl-C 或 SIGTERM 打断了：收完尾退出码是 130 */
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (interrupted) return
    interrupted = true
    log(`收到 ${signal}，收尾`)
    void cleanup().then(() => process.exit(130))
  })

// ---------- 要跑哪些流程 ----------

function pickFlows() {
  const groups = ['mock', 'fixture']
  const only = args('--only')
  const files = []
  for (const group of groups) {
    if (only.length && !only.includes(group)) continue
    for (const name of readdirSync(join(flowsDir, group)).sort())
      if (name.endsWith('.yaml')) files.push(join(flowsDir, group, name))
  }
  for (const one of only.filter((value) => !groups.includes(value))) files.push(resolve(one))
  const tag = arg('--tags')
  return tag ? files.filter((file) => tagsOf(file).includes(tag)) : files
}

/** 流程开头那段里的 tags: [a, b] */
function tagsOf(file) {
  const found = readFileSync(file, 'utf8').match(/^tags:\s*\[([^\]]*)\]/m)
  return found ? found[1].split(',').map((tag) => tag.trim()) : []
}

// ---------- 模拟器 ----------

const adb = (serial, ...rest) =>
  execFileSync(adbBin, ['-s', serial, ...rest], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

/** adb 认得的设备和各自的状态（device、offline、unauthorized…） */
function devices() {
  return new Map(
    execFileSync(adbBin, ['devices'], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split('\t'))
      .filter((pair) => pair.length === 2),
  )
}

async function startEmulator() {
  const given = arg('--serial')
  if (given) {
    if (devices().get(given) !== 'device') throw new Error(`没有连着的 ${given}`)
    return given
  }
  const port = Number(arg('--port', '5590'))
  const serial = `emulator-${port}`
  // 这个端口上已经有一台（不管什么状态）：多半是别人的，不用它、也不再起一台
  const there = devices().get(serial)
  if (there)
    throw new Error(
      `${serial} 已经有设备（${there}）：换一个 --port，或者用 --serial 指定要用的那台`,
    )
  const avd = arg('--avd', 'tyrs_hand_e2e_api35')
  const gpu =
    process.env.LITCH_E2E_GPU ?? (process.platform === 'darwin' ? 'host' : 'swiftshader_indirect')
  const start = Date.now()
  log(`起模拟器 ${avd}（${serial}，无窗口、只读）`)
  const child = spawn(
    emulatorBin,
    [
      '-avd',
      avd,
      '-port',
      String(port),
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-no-snapshot',
      '-read-only',
      '-gpu',
      gpu,
    ],
    { stdio: 'ignore', detached: true },
  )
  child.unref()
  cleanups.push(async () => {
    // 自己起的那个进程已经没了：这个序列号上要是又有了设备，那不是我们的
    if (child.exitCode !== null || child.signalCode !== null) return
    if (keep) return log(`模拟器 ${serial} 留着（--keep），用完执行：adb -s ${serial} emu kill`)
    spawnSync(adbBin, ['-s', serial, 'emu', 'kill'], { stdio: 'ignore' })
    for (let i = 0; i < 60 && child.exitCode === null && child.signalCode === null; i++)
      await sleep(500)
    log(`模拟器 ${serial} 关了`)
  })
  for (;;) {
    if (child.exitCode !== null) throw new Error(`模拟器没起来（退出码 ${child.exitCode}）`)
    if (Date.now() - start > 240_000) throw new Error('模拟器四分钟还没开好机')
    try {
      if (adb(serial, 'shell', 'getprop', 'sys.boot_completed').trim() === '1') break
    } catch {
      // 还没连上
    }
    await sleep(1000)
  }
  // 关掉动画：等待和点击都更稳
  for (const name of [
    'window_animation_scale',
    'transition_animation_scale',
    'animator_duration_scale',
  ])
    adb(serial, 'shell', 'settings', 'put', 'global', name, '0')
  log(`模拟器开好了（${since(start)}）`)
  return serial
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** --screen 给了就改屏幕的尺寸和密度，收尾时改回去 */
function setScreen(serial) {
  const screen = arg('--screen')
  if (!screen) return
  const found = screen.match(/^(\d+x\d+)@(\d+)$/)
  if (!found) throw new Error(`--screen 要写成 宽x高@密度，比如 320x640@160：${screen}`)
  adb(serial, 'shell', 'wm', 'size', found[1])
  adb(serial, 'shell', 'wm', 'density', found[2])
  cleanups.push(() => {
    spawnSync(adbBin, ['-s', serial, 'shell', 'wm', 'size', 'reset'], { stdio: 'ignore' })
    spawnSync(adbBin, ['-s', serial, 'shell', 'wm', 'density', 'reset'], { stdio: 'ignore' })
  })
  log(`屏幕改成 ${found[1]}、密度 ${found[2]}`)
}

// ---------- 安装包 ----------

function buildApk() {
  const start = Date.now()
  const run = (command, list, cwd) => {
    const done = spawnSync(command, list, { cwd, stdio: 'inherit', env: process.env })
    if (done.status !== 0) throw new Error(`${command} ${list.join(' ')} 失败`)
  }
  log('打 release 包：expo prebuild --clean，再 assembleRelease')
  run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install'], mobile)
  cleanups.push(() =>
    spawnSync('./gradlew', ['--stop'], { cwd: join(mobile, 'android'), stdio: 'ignore' }),
  )
  run('npm', ['run', 'android:release', '--', '--max-workers=4'], mobile)
  log(`包打好了（${since(start)}）`)
}

function install(serial) {
  if (flag('--no-install')) {
    if (!adb(serial, 'shell', 'pm', 'list', 'packages', PKG).includes(PKG))
      throw new Error('模拟器上没装 Litch，去掉 --no-install')
    return log('用已经装着的包')
  }
  const start = Date.now()
  adb(serial, 'install', '-r', '-g', apk)
  log(`装好了（${since(start)}）`)
}

// ---------- 夹具 ----------

/** 起夹具（真的适配器经 SSH，假模型），等它把连接配置写出来；顺带开一个只在回环上的口给流程用 */
async function startFixture(serial) {
  for (const built of [
    'packages/device/dist/device/src/main.mjs',
    'packages/pi/dist/pi/src/adapter.mjs',
  ])
    if (!existsSync(join(repo, built)))
      throw new Error(`没有 ${built}：先在仓库根目录 npm run build`)
  const start = Date.now()
  const out = join(work, 'fixture.json')
  const serve = await freePort()
  const child = spawn(
    process.execPath,
    [join(mobile, 'scripts/fixture.mjs'), '--out', out, '--serve', String(serve), '--adb'],
    {
      cwd: repo,
      env: {
        ...process.env,
        ANDROID_SERIAL: serial,
        PATH: `${dirname(adbBin)}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let said = ''
  child.stderr.on('data', (chunk) => (said += chunk))
  cleanups.push(async () => {
    // 只撤夹具加的那两条（sshd 的端口、手机上取配置的 8765），别人的映射（比如 Metro 的 8081）不动
    const port = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')).target?.port : null
    for (const local of [port ? `tcp:${port}` : null, 'tcp:8765'].filter(Boolean))
      spawnSync(adbBin, ['-s', serial, 'reverse', '--remove', local], { stdio: 'ignore' })
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250)
    if (child.exitCode === null) child.kill('SIGKILL')
    log('夹具停了')
  })
  await new Promise((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`夹具两分钟没就绪：${said.slice(-2000)}`)),
      120_000,
    )
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('LITCH_MOBILE_FIXTURE')) {
        clearTimeout(timer)
        done()
      }
    })
    child.on('exit', (code) => fail(new Error(`夹具退出了（${code}）：${said.slice(-2000)}`)))
  })
  const config = JSON.parse(readFileSync(out, 'utf8'))
  // 和夹具加的那两条一样（scripts/fixture.mjs 的 --adb）；后登记先收：先停盯梢，再撤映射
  keepReverse(serial, [
    [`tcp:${config.target.port}`, `tcp:${config.target.port}`],
    ['tcp:8765', `tcp:${serve}`],
  ])
  prepareRepo(config.work)
  const helper = await startHelper(config, serial)
  log(`夹具就绪（${since(start)}），sshd 在 127.0.0.1:${config.target.port}`)
  return { config, helper }
}

/**
 * CI 的模拟器偶尔掉线一下（adb 报 device offline）再连上，adb reverse 的映射跟着全没了，后面的夹具流程都连不上：
 * 跑的时候每两秒看一眼，少了就补回去。掉线那会儿看不了，跳过
 */
function keepReverse(serial, rules) {
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    execFile(adbBin, ['-s', serial, 'reverse', '--list'], (error, out) => {
      const missing = error ? [] : rules.filter((pair) => !out.includes(pair.join(' ')))
      for (const pair of missing)
        execFile(adbBin, ['-s', serial, 'reverse', ...pair], (failed) => {
          if (!failed) log(`模拟器掉过线，补回端口映射 ${pair.join(' → ')}`)
        })
      busy = false
    })
  }, 2000)
  cleanups.push(() => clearInterval(timer))
}

/** 新会话的工作目录做成一个有改动的 git 仓库：差异页才有东西看 */
function prepareRepo(dir) {
  const git = (...list) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', ...list], {
      cwd: dir,
      // 不读用户自己的 git 配置
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore',
    })
  writeFileSync(join(dir, 'README.md'), '# e2e\n\n第一行\n第二行\n')
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'README.md'), '# e2e\n\n第一行\n改过的第二行\n')
  writeFileSync(join(dir, 'notes.txt'), 'e2e 新加的文件\n')
}

/**
 * 流程里 runScript 要的口（Maestro 在这台电脑上跑，连 127.0.0.1 就到这里）：
 *   POST /authorize        请求体是一行公钥，写进夹具 sshd 的 authorized_keys（演“用户在电脑上授权了手机的钥匙”）
 *   GET  /file?name=&text= 夹具的工作目录里这个文件有没有写出这段字（终端里敲的命令真跑了没有），最多等十秒
 *   /pair、/pair/request、/pair/allow、/pair/phones   扫码绑定，见 pairing()
 *   /approval/open、/approval/answered、/approval/fingerprint   手机批准登录，见 pairing()
 *   POST /lock/pin、/lock/clear   给模拟器设、清锁屏密码 1111（批准前的系统验证要有锁屏；清的那一步收尾时也做）
 */
async function startHelper(config, serial) {
  const port = await freePort()
  const pair = pairing(config)
  const lock = (on) => {
    const list = on ? ['set-pin', LOCK_PIN] : ['clear', '--old', LOCK_PIN]
    const done = spawnSync(adbBin, ['-s', serial, 'shell', 'locksettings', ...list], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    return done.status === 0
  }
  let locked = false
  cleanups.push(() => {
    if (locked) lock(false)
  })
  const fileHas = async (name, text) => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return false
    for (let i = 0; i < 40; i++) {
      const path = join(config.work, name)
      if (existsSync(path) && readFileSync(path, 'utf8').includes(text)) return true
      await sleep(250)
    }
    return false
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://helper')
      if (
        req.method === 'POST' &&
        (url.pathname === '/lock/pin' || url.pathname === '/lock/clear')
      ) {
        const on = url.pathname === '/lock/pin'
        const ok = lock(on)
        if (ok) locked = on
        res.writeHead(ok ? 200 : 500).end()
        return
      }
      if (url.pathname.startsWith('/pair') || url.pathname.startsWith('/approval')) {
        const answer = await pair(req.method, url.pathname).catch((error) => {
          log(`扫码绑定的小口出错：${error.message}`)
          return null
        })
        res.writeHead(answer ? 200 : 404).end(answer ?? '')
        return
      }
      if (req.method === 'GET' && url.pathname === '/file') {
        const found = await fileHas(
          url.searchParams.get('name') ?? '',
          url.searchParams.get('text') ?? '',
        )
        res.writeHead(found ? 200 : 404).end()
        return
      }
      const key = body.trim()
      if (
        req.method !== 'POST' ||
        url.pathname !== '/authorize' ||
        !/^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$/.test(key)
      ) {
        res.writeHead(400).end()
        return
      }
      appendFileSync(join(config.root, 'authorized_keys'), `${key}\n`)
      res.writeHead(200).end('ok')
    })
  })
  await new Promise((done) => server.listen(port, '127.0.0.1', done))
  cleanups.push(() => new Promise((done) => server.close(done)))
  return `http://127.0.0.1:${port}`
}

/**
 * 扫码绑定，替桌面端那一头调夹具里装了适配器的那台（svc）的设备服务。一次性钥匙登进来跑的是真的 pair-enroll：
 *   POST /pair           出一张码：经 ssh 让设备服务常驻（device-start），调 litch/pair/start，配上手机要连的地址，回配对文本
 *   GET  /pair/request   等手机登记上来（litch/pair/wait 到 requested），回那条请求（手机名、确认码、手机号）
 *   POST /pair/allow     演“电脑上点了允许”（litch/pair/decide）
 *   GET  /pair/phones    设备服务列出的已绑定手机有几部（litch/pair/phones），钥匙文件里手机的钥匙行有几行
 * 设备认批准公钥（clientApprovals），码里带 a：手机登记时带上批准公钥，/pair/request 回的请求里有它，这里记下来验签用。
 * 手机批准登录，替桌面端挂卡片、收答复、验签（另开一条声明了 clientApprovals 的连接）：
 *   POST /approval/open        在最近的会话上挂一张代理登录的卡片（两个打码的账号），回卡片号
 *   GET  /approval/answered    等手机的答复（litch/approval/answered），用扫码时记下的批准公钥验签、核对卡片，
 *                              回 { verified, ref, decision }；验过就把卡片收掉（litch/approval/close）
 *   GET  /approval/fingerprint 扫码时记下的批准公钥的指纹（手机设置里显示的应该是同一串）
 */
function pairing(config) {
  const keysFile = join(config.root, 'authorized_keys')
  let rpc = null
  let current = null
  let socket = null
  /** 扫码登记上来的那部手机：手机号和批准公钥 */
  let phone = null
  /** 挂着的卡片（只挂一张）和它收到的答复 */
  let card = null
  const answers = []
  let desk = null
  const service = async () => {
    if (rpc) return rpc
    // 和手机的启动脚本一样经登录 shell 跑：适配器只在那里才进 PATH
    const said = execFileSync(
      'ssh',
      ['-F', join(config.root, 'ssh_config'), '-o', 'BatchMode=yes', 'litch-fx-svc', 'exec sh'],
      {
        input: `exec "$SHELL" -l -i -c '${config.adapter} device-start --ssh=off'\n`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 60_000,
      },
    )
    const ready = said
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((line) => line.ready === true)
    if (!ready) throw new Error(`设备服务没起来：${said.slice(-2000)}`)
    socket = ready.socket
    rpc = await deviceRpc(ready.socket)
    cleanups.push(() => rpc?.close())
    return rpc
  }
  const keyLines = () =>
    readFileSync(keysFile, 'utf8')
      .split('\n')
      .filter((row) => row.includes(' litch-mobile:')).length
  /** 演桌面端的那条连接：握手时声明 clientApprovals，收手机的答复 */
  const desktop = async () => {
    if (desk) return desk
    await service()
    desk = await deviceRpc(socket, (method, params) => {
      if (method === 'litch/approval/answered') answers.push(params)
    })
    cleanups.push(() => desk?.close())
    await desk.call('initialize', {
      clientInfo: { name: 'litch-e2e', title: 'Litch e2e', version: '0.0.0' },
      capabilities: { experimentalApi: true, litchExtensions: ['harness', 'clientApprovals'] },
    })
    desk.notify('initialized')
    return desk
  }
  const token = () => randomBytes(16).toString('base64url')
  const rawKey = (base64) =>
    createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(base64, 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    })
  const approval = async (method, path) => {
    const link = await desktop()
    if (method === 'POST' && path === '/approval/open') {
      const { data } = await link.call('thread/list', {})
      const newest = [...data].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
      if (!newest) return null
      card = {
        id: token(),
        threadId: newest.id,
        kind: 'browserSignIn',
        summary: {
          origin: 'https://accounts.example.com',
          site: 'Example',
          reason: 'e2e：看看登录后的页面',
          device: 'e2e-pair',
          accounts: [
            { ref: 'a1', masked: 'so•••@gmail.com' },
            { ref: 'a2', masked: 'li•••@example.com' },
          ],
          task: null,
          fillBlocked: null,
        },
        desktopId: 'e2eDesktop0000000',
        nonce: token(),
        expiresAt: null,
      }
      answers.length = 0
      await link.call('litch/approval/open', card)
      return JSON.stringify({ id: card.id, threadId: card.threadId })
    }
    if (method === 'GET' && path === '/approval/fingerprint') {
      if (!phone?.approvalKey) return null
      const hex = createHash('sha256')
        .update(Buffer.from(phone.approvalKey, 'base64'))
        .digest('hex')
      return hex.slice(0, 16).match(/.{4}/g).join(' ')
    }
    if (method === 'GET' && path === '/approval/answered' && card) {
      for (let i = 0; i < 240 && !answers.some((one) => one.id === card.id); i++) await sleep(250)
      const answer = answers.find((one) => one.id === card.id)
      if (!answer) return null
      const text = approvalSignedText({ ...card, origin: card.summary.origin }, answer)
      const verified =
        !!phone?.approvalKey &&
        answer.approvalKey === phone.approvalKey &&
        answer.phoneId === phone.phoneId &&
        verify(
          null,
          Buffer.from(text),
          rawKey(answer.approvalKey),
          Buffer.from(answer.signature, 'base64'),
        )
      if (verified) await link.call('litch/approval/close', { id: card.id })
      return JSON.stringify({ verified, ref: answer.ref, decision: answer.decision })
    }
    return null
  }
  return async (method, path) => {
    if (path.startsWith('/approval')) return approval(method, path)
    const device = await service()
    if (method === 'POST' && path === '/pair') {
      const start = await device.call('litch/pair/start', {})
      current = start.pairId
      return encodePairPayload({
        v: 1,
        n: 'e2e-pair',
        h: '127.0.0.1',
        p: config.target.port,
        u: config.target.user,
        k: { t: start.hostKey.type, f: start.hostKey.fingerprint },
        s: start.seed,
        i: start.pairId,
        e: start.expiresAt,
        a: 1,
      })
    }
    if (method === 'GET' && path === '/pair/phones') {
      const { data } = await device.call('litch/pair/phones', {})
      return JSON.stringify({ phones: data.length, keyLines: keyLines() })
    }
    if (!current) return null
    if (method === 'GET' && path === '/pair/request') {
      let since = null
      for (let i = 0; i < 4; i++) {
        const status = await device.call('litch/pair/wait', { pairId: current, since }, 40_000)
        if (status.state === 'requested') {
          phone = status.phone
          return JSON.stringify(status.phone)
        }
        if (status.state !== 'waiting') return null
        since = status.state
      }
      return null
    }
    if (method === 'POST' && path === '/pair/allow') {
      const status = await device.call('litch/pair/decide', { pairId: current, allow: true })
      return status.state === 'done' ? 'ok' : null
    }
    return null
  }
}

/**
 * Maestro（2.3.0）在安卓上把驱动固定映射到这台电脑的 7001 口，没有参数能改：同一台电脑上同时只能跑一个 Maestro，
 * 第二个会在启动应用时超时（报 Unable to launch app）。先看一眼，被占着就直接说清楚
 */
function checkDriverPort() {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', () =>
      fail(
        new Error(
          '电脑上的 7001 口被占着：多半是另一个 Maestro 在跑（它固定用这个口），等它跑完再来',
        ),
      ),
    )
    probe.listen(7001, '127.0.0.1', () => probe.close(() => done()))
  })
}

function freePort() {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

// ---------- Maestro ----------

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** 流程开头那段里的 name:；没写就是文件名（Maestro 报告里也这么叫） */
function nameOf(file) {
  const found = readFileSync(file, 'utf8').match(/^name:\s*(.+?)\s*$/m)
  return found ? found[1] : basename(file, '.yaml')
}

/** JUnit 报告里没过的流程，按名字对回文件；报告没写出来（Maestro 自己挂了）或者对不上就是 null */
function failedFlows(report, flows) {
  if (!existsSync(report)) return null
  const fromXml = (text) =>
    text.replace(
      /&(lt|gt|quot|apos|amp);/g,
      (_, name) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name],
    )
  const failed = []
  for (const [, attrs, body = ''] of readFileSync(report, 'utf8').matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    if (!body.includes('<failure') && !body.includes('<error')) continue
    const name = fromXml(attrs.match(/\bname="([^"]*)"/)?.[1] ?? '')
    const file = flows.find((one) => nameOf(one) === name)
    if (!file) return null
    failed.push(file)
  }
  return failed
}

async function runMaestro(serial, flows, fixture, report) {
  const env = fixture
    ? {
        FIXTURE_PORT: String(fixture.config.target.port),
        FIXTURE_USER: fixture.config.target.user,
        ADAPTER: fixture.config.adapter,
        FX_MODE: fixture.config.target.env.LITCH_FX_MODE ?? '',
        FINGERPRINT_RE: escapeRe(fixture.config.target.hostFingerprint),
        HELPER: fixture.helper,
        WORK: realpathSync(fixture.config.work),
      }
    : {}
  const list = [
    '--device',
    serial,
    'test',
    '--no-ansi',
    '--debug-output',
    debugDir,
    '--flatten-debug-output',
    '--format',
    'JUNIT',
    '--output',
    report,
    ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    ...flows,
  ]
  const start = Date.now()
  log(`跑 ${flows.length} 个流程：${flows.map((file) => relative(flowsDir, file)).join(' ')}`)
  // 不能用 spawnSync：流程里的 runScript 要连这个进程里的小口，事件循环得转着
  const child = spawn(maestroBin, list, {
    stdio: 'inherit',
    env: {
      ...process.env,
      MAESTRO_CLI_NO_ANALYTICS: '1',
      MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    },
  })
  cleanups.push(() => {
    if (child.exitCode === null) child.kill('SIGTERM')
  })
  const status = await new Promise((done, fail) => {
    child.on('error', (error) =>
      fail(new Error(`Maestro 起不来（${error.message}）：装 2.3.0，或用 MAESTRO 指过去`)),
    )
    child.on('exit', (code) => done(code ?? 1))
  })
  // 每个流程的结果和耗时 Maestro 自己已经打出来了
  log(`流程跑完（${since(start)}）`)
  return status
}

// ---------- 主流程 ----------

async function main() {
  const flows = pickFlows()
  if (flows.length === 0) throw new Error('没有要跑的流程')
  const needsFixture = flows.some(
    (file) => file.includes(`${join('flows', 'fixture')}/`) || tagsOf(file).includes('fixture'),
  )
  const total = Date.now()
  await checkDriverPort()
  if (flag('--build')) buildApk()
  if (!flag('--no-install') && !existsSync(apk))
    throw new Error(`没有安装包 ${apk}：加 --build，或者用 --apk 指过去`)
  const serial = await startEmulator()
  setScreen(serial)
  install(serial)
  const fixture = needsFixture ? await startFixture(serial) : null
  const first = join(work, 'report-1.xml')
  let code = await runMaestro(serial, flows, fixture, first)
  // 没过的重跑一次（CI 的模拟器偶尔掉线，正跑着的那个流程会跟着挂）；重跑才过的照样点名，别当没事
  const failed = code === 0 || flag('--no-retry') ? null : failedFlows(first, flows)
  if (failed?.length && !interrupted) {
    log(`没过的重跑一次：${failed.map((file) => relative(flowsDir, file)).join(' ')}`)
    execFileSync(adbBin, ['-s', serial, 'wait-for-device'], { stdio: 'ignore', timeout: 120_000 })
    code = await runMaestro(serial, failed, fixture, join(work, 'report-2.xml'))
    const still = code === 0 ? [] : (failedFlows(join(work, 'report-2.xml'), failed) ?? failed)
    const flaky = failed.filter((file) => !still.includes(file))
    if (flaky.length)
      log(`重跑才过（不稳，要查）：${flaky.map((file) => relative(flowsDir, file)).join(' ')}`)
  }
  log(`${code === 0 ? '全部通过' : '有流程没过'}（总共 ${since(total)}）`)
  return code
}

cleanups.push(() => {
  if (keep) return log(`调试输出留在 ${work}（--keep），用完自己删`)
  rmSync(work, { recursive: true, force: true })
})

if (artifacts) mkdirSync(artifacts, { recursive: true })
let code = 1
try {
  code = await main()
} catch (error) {
  log(`出错：${error.message}`)
} finally {
  await cleanup()
}
if (artifacts) log(`Maestro 的调试输出在 ${artifacts}`)
process.exit(interrupted ? 130 : code)
