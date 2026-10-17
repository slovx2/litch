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
//   --keep                            跑完不关模拟器、留下 Maestro 的调试输出（截图、日志），排查失败用，用完自己删
// 要的环境：ANDROID_HOME（默认 ~/Library/Android/sdk）、JDK 17 以上（JAVA_HOME，Maestro 和 gradle 都要）、
// Maestro 2.3.0（MAESTRO 指过去，或者在 PATH 里）；跑夹具的流程要先在仓库根目录 npm run build（适配器、Pi、设备进程）。
// LITCH_E2E_ARTIFACTS=<目录>：Maestro 的调试输出（失败时的截图、日志）放到这里并留着（CI 上传用）；不给就放临时目录、跑完删掉。
import { execFileSync, spawn, spawnSync } from 'node:child_process'
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
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  prepareRepo(config.work)
  const helper = await startHelper(config)
  log(`夹具就绪（${since(start)}），sshd 在 127.0.0.1:${config.target.port}`)
  return { config, helper }
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
 */
async function startHelper(config) {
  const port = await freePort()
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

async function runMaestro(serial, flows, fixture) {
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
  install(serial)
  const fixture = needsFixture ? await startFixture(serial) : null
  const code = await runMaestro(serial, flows, fixture)
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
