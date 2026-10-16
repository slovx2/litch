// 本机内置适配器的自检：拿假的适配器（scripts/fake-adapter.mjs）把本机设备的打开方式过一遍。不起界面。
// 验的是：没有另外指定入口时去启动内置的设备服务并接到聚合面上、已经在跑就直接用、
// 服务脱离出去不跟着退出，以及每一种“没连上”都落在对应的阶段上、该不该自己再试也对；
// 还有在跑的服务和自带的不是同一版时怎么办：旧而且闲着就换掉，不闲、换不了就照旧连上并说明原因，更新的绝不降级。
// 每种情形除了外壳自己记的结果（upgrade），还看一眼界面最后看到的那一份（view：经核心挑过、
// 放进设备显示数据里的样子），设备详情的“设备服务”一节就是照它说话的。
//   npm run check:adapter
// 一切都在临时目录里：状态目录用 LITCH_ADAPTER_HOME 指过去，不碰 ~/.codex-harness-adapter。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = fileURLToPath(new URL('../dist/adapter-check.mjs', import.meta.url))
const fake = fileURLToPath(new URL('./fake-adapter.mjs', import.meta.url))

// 套接字的路径有长度上限，目录名要短。名字里特意带一个空格和一个汉字：用户的主目录可能就是这样，
// 状态目录默认在它下面，套接字的路径里有这些字符时也得连得上
const work = mkdtempSync(join(tmpdir(), 'la 检-'))
const root = join(work, 'adapter')
const cli = join(root, 'bin', 'codex-harness-adapter')
const node = join(root, 'node', 'bin', 'node')
const calls = join(root, 'calls.jsonl')

/** 摆一份假的内置适配器：命令行和 Node 都是转到真东西上的小脚本 */
mkdirSync(join(root, 'bin'), { recursive: true })
mkdirSync(join(root, 'node', 'bin'), { recursive: true })
const script = (path, body) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}
// 每被调用一次，假命令行往 calls.jsonl 里记一行
script(cli, `FAKE_CALLS='${calls}' exec '${process.execPath}' '${fake}' "$@"`)
// 设备进程应当是用应用自带的 Node 起的：经过这里就记一笔
script(node, `echo used >> '${join(root, 'node-used.log')}'\nexec '${process.execPath}' "$@"`)

/**
 * 假的登录 shell。应用启动设备服务之前会问一遍用户的登录 shell 要环境（src/login-env.mts），
 * 自检不许去跑这台机器上真的 shell 配置：名字得是认得的（zsh），内容是我们自己写的。
 * 它像用户的配置那样往 PATH 前面加一段、导出一个记号，开头还故意吐一行欢迎语。
 */
const loginPath = '/litch-fake-login/bin'
const shell = join(work, 'sh', 'zsh')
mkdirSync(join(work, 'sh'))
script(
  shell,
  [
    `echo '欢迎回来'`,
    `[ "$1" = "-ilc" ] || exit 9`,
    `PATH="${loginPath}:$PATH"; export PATH`,
    'FAKE_FROM_LOGIN=1; export FAKE_FROM_LOGIN',
    'exec /bin/sh -c "$2"',
  ].join('\n'),
)
/** 一直不返回的登录 shell（配置里有东西在等输入）。它把自己的进程号记下来，好看它最后有没有被结束 */
const stuckShell = join(work, 'stuck', 'zsh')
const stuckPid = join(work, 'stuck', 'pid')
mkdirSync(join(work, 'stuck'))
script(stuckShell, `echo $$ > '${stuckPid}'\nexec sleep 600`)

/** 每种情形用自己的状态目录，互不影响 */
const homeOf = (name) => join(work, name)

/**
 * 跑一次小工具，返回它打出来的每一行和用了多久。
 * version、build 是这一次“应用自带的那份适配器”的版本号和程序文件的戳，stop 是它的 device-stop 怎么表现。
 */
function run({
  home,
  mode = 'ok',
  adapterRoot = root,
  entry = '',
  lang = 'zh-CN',
  flags = [],
  loginShell = shell,
  version = '1.0.0',
  build = 'b1',
  stop = 'ok',
}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(process.execPath, [tool, ...flags], {
      env: {
        ...process.env,
        LITCH_ENTRY: entry,
        LITCH_ADAPTER_ROOT: adapterRoot,
        LITCH_ADAPTER_HOME: home,
        LITCH_LANG: lang,
        SHELL: loginShell,
        FAKE_ADAPTER: mode,
        FAKE_VERSION: version,
        FAKE_BUILD: build,
        FAKE_STOP: stop,
        FAKE_SERVICE: 'facts',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', () => {
      try {
        const lines = stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        resolve({ lines, tookMs: Date.now() - started })
      } catch {
        reject(new Error(`小工具的输出读不懂：\n${stdout}\n${stderr}`))
      }
    })
  })
}

const stepsOf = (lines) => lines.filter((line) => line.step).map((line) => line.step)
const resultOf = (lines) => lines.find((line) => line.result) ?? {}
const callLog = () =>
  existsSync(calls)
    ? readFileSync(calls, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
/** 假设备进程自己记下的进程号。directory 是聚合面套接字所在的那一层，惯常是 device */
const devicePid = (home, directory = 'device') => {
  const file = join(home, directory, 'device.pid')
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : null
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 这次自检起过的假设备进程（取进程号的函数），结束时要全部停掉 */
const services = []

/**
 * 不经应用，直接用假命令行在一个状态目录上拉起一份服务，扮演“应用打开之前就在跑的那一份”：
 * 它是哪个版本、报不报自己的来历（service：facts、nofacts、foreground）、启动时带了什么参数。
 * 返回它的进程号。
 */
function seed(
  name,
  { version = '1.0.0', build = 'b1', service = 'facts', options = ['--ssh=off'] },
) {
  const home = homeOf(name)
  services.push(() => devicePid(home))
  const done = spawnSync(
    cli,
    ['device-start', '--home', home, '--root', root, '--node', node, ...options],
    {
      env: {
        ...process.env,
        FAKE_ADAPTER: 'ok',
        FAKE_VERSION: version,
        FAKE_BUILD: build,
        FAKE_SERVICE: service,
      },
      encoding: 'utf8',
    },
  )
  assert.equal(done.status, 0, done.stderr)
  const pid = devicePid(home)
  assert.ok(pid && alive(pid), '预先摆的那份服务没有起来')
  return { home, pid, before: callLog().length }
}

/** 从第几次调用起，假命令行被调用的那几次：子命令和它后面的参数 */
const callsSince = (before) =>
  callLog()
    .slice(before)
    .map((call) => call.args)
const startArgs = (home, ...options) => [
  'device-start',
  ...['--home', home, '--root', root, '--node', node],
  ...options,
]
const stopArgs = (home) => ['device-stop', '--home', home, '--if-idle']

/** 没连上：阶段、那句话、还会不会自己再试 */
async function fails(options, stage, text, retriable) {
  const { lines, tookMs } = await run(options)
  const result = resultOf(lines)
  assert.equal(result.result, 'failed', JSON.stringify(lines))
  assert.equal(result.stage, stage, JSON.stringify(result))
  assert.match(result.text, text)
  assert.equal(result.retriable, retriable, JSON.stringify(result))
  return { result, lines, tookMs }
}

const passed = []
const check = async (name, body) => {
  await body()
  passed.push(name)
  console.log(`  ✓ ${name}`)
}
try {
  await check(
    '没有内置的适配器（没装成应用，也没指）：说明该设哪个变量，不再自动重试',
    async () => {
      await fails(
        { home: homeOf('none'), adapterRoot: '' },
        'notInstalled',
        /^connect\.noEntry$/,
        false,
      )
      assert.equal(callLog().length, 0, '没有适配器，却去执行了什么')
    },
  )

  await check('适配器目录不完整：指出缺的是哪个文件，不再自动重试', async () => {
    const empty = join(work, 'empty')
    mkdirSync(empty)
    const { result } = await fails(
      { home: homeOf('empty-home'), adapterRoot: empty },
      'notInstalled',
      /^connect\.adapterBroken /,
      false,
    )
    assert.ok(result.text.includes(join(empty, 'bin', 'codex-harness-adapter')), result.text)
  })

  await check('命令行执行不了（没有执行权限）：归到同一句，详情里是系统的原话', async () => {
    chmodSync(cli, 0o644)
    try {
      const { result } = await fails(
        { home: homeOf('noexec') },
        'notInstalled',
        /^connect\.adapterBroken /,
        false,
      )
      assert.match(result.detail ?? '', /EACCES/)
    } finally {
      chmodSync(cli, 0o755)
    }
  })

  const home = homeOf('h')
  const socket = join(home, 'device', 'device.sock')
  services.push(() => devicePid(home))
  let pid = null
  await check('第一次连：服务不在，启动它、接上聚合面、列出了会话', async () => {
    const { lines } = await run({ home })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.deepEqual(stepsOf(lines), ['connect.adapterStarting'])
    assert.equal(result.userAgent, 'litch-fake-device/0.0.0')
    assert.equal(result.threads, 1)
    const [call] = callLog()
    assert.deepEqual(call.args, [
      'device-start',
      '--home',
      home,
      '--root',
      root,
      '--node',
      node,
      '--ssh=off',
    ])
    assert.deepEqual(call.leaked, [], '我们自己的环境变量漏给了设备服务')
    assert.equal(call.lang, 'zh-CN', '没有把命令行的语言固定下来')
    // 从访达打开的应用自己的 PATH 里只有系统目录：服务拿到的得是登录 shell 里的那一份
    assert.equal(call.pathHead, loginPath, '登录 shell 里的 PATH 没有交给设备服务')
    assert.equal(call.fromLogin, '1', '登录 shell 里导出的变量没有交给设备服务')
    assert.equal(call.cwd, realpathSync(homedir()), '服务的工作目录应当是用户的主目录')
    assert.ok(existsSync(join(root, 'node-used.log')), '设备进程不是用自带的 Node 起的')
    pid = devicePid(home)
    assert.ok(pid && alive(pid), '设备进程没有起来')
    // 命令行报回来的那一行留住了：是这边拉起来的，进程号也在，在跑的和自带的两份来历都在
    const bundled = { version: '1.0.0', root, build: 'b1' }
    const service = { ...bundled, pid, detached: true, options: ['--ssh=off'] }
    assert.ok(!Number.isNaN(Date.parse(result.last.service.startedAt)))
    assert.deepEqual(result.last, {
      socket,
      started: true,
      pid,
      service: { ...service, startedAt: result.last.service.startedAt },
      cli: bundled,
    })
    assert.deepEqual(result.launched, result.last)
    // 本来没有服务：拉起的就是自带的这一份，没有什么要换的
    assert.deepEqual(result.upgrade, {
      action: 'launched',
      running: result.last.service,
      bundled,
      order: 'same',
      reason: null,
      busy: [],
      detail: null,
    })
    // 到了界面上：之前没有服务，不留“之前的版本”；启动参数、程序文件的戳不带过去
    assert.deepEqual(result.view, {
      action: 'launched',
      bundled: { version: '1.0.0', root },
      previous: null,
      order: 'same',
      reason: null,
      busy: [],
      detail: null,
      pid,
    })
  })

  await check('连完退出之后服务还在；再连时直接用它，没有起第二份', async () => {
    assert.ok(alive(pid), '设备进程跟着退了')
    const { lines } = await run({ home, lang: 'en' })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.equal(devicePid(home), pid)
    assert.equal(callLog().length, 2)
    assert.equal(callLog().at(-1).lang, 'en', '界面是英文时命令行也该说英文')
    // 这一次不是这边拉起来的：不算在“我们拉起的服务”里
    assert.deepEqual(
      [result.last.socket, result.last.started, result.last.pid, result.last.service.pid],
      [socket, false, pid, pid],
    )
    assert.equal(result.launched, null)
    // 在跑的和自带的是同一版：不动它，除了那两次 device-start 什么都没执行过
    assert.deepEqual(
      [result.upgrade.action, result.upgrade.reason, result.upgrade.order],
      ['kept', 'same', 'same'],
    )
    assert.deepEqual(
      [result.view.action, result.view.reason, result.view.previous, result.view.pid],
      ['kept', 'same', '1.0.0', pid],
    )
    assert.deepEqual(
      callLog().map((call) => call.args[0]),
      ['device-start', 'device-start'],
    )
  })

  await check('另外指定了入口（LITCH_ENTRY）：直接连那个套接字，不去动内置的适配器', async () => {
    const before = callLog().length
    const { lines } = await run({ home: homeOf('unused'), entry: `unix://${socket}` })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.deepEqual(stepsOf(lines), [])
    assert.equal(callLog().length, before, '指定了入口，却还是执行了 device-start')
    assert.equal(result.last, null)
    // 没有换版本这回事：界面上也没有
    assert.deepEqual([result.upgrade, result.view], [null, null])
  })

  await check('聚合面不在惯常的位置上：连的是命令行报的那个套接字，不自己拼路径', async () => {
    const other = homeOf('e')
    services.push(() => devicePid(other, 'alt'))
    const { lines } = await run({ home: other, mode: 'elsewhere' })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.equal(result.last.socket, join(other, 'alt', 'agg.sock'))
    assert.equal(existsSync(join(other, 'device', 'device.sock')), false)
  })

  await check(
    '有一份不带聚合面的旧版服务在跑：提示升级，不再自动重试，没有去停它或替换它',
    async () => {
      const before = callLog().length
      const { result } = await fails(
        { home: homeOf('legacy'), mode: 'legacy' },
        'outdated',
        /^connect\.adapterLegacy$/,
        false,
      )
      assert.match(result.detail ?? '', /不带聚合面的服务正在运行/)
      // 只问了一次能不能连，别的什么都没做
      assert.equal(callLog().length, before + 1)
      assert.equal(devicePid(homeOf('legacy')), null)
    },
  )

  await check('服务起不来：归到“启动失败”，详情里是它的原话，之后会自己再试', async () => {
    const { result } = await fails(
      { home: homeOf('fail'), mode: 'fail' },
      'startFailed',
      /^connect\.adapterStartFailed$/,
      true,
    )
    // 开头那句原因和后面附的服务输出都要在，不能只剩末尾
    assert.match(result.detail ?? '', /^设备进程没有起来：模拟的原因\n/)
    assert.match(result.detail ?? '', /最后一行日志$/)
  })

  await check('以 0 退出却没按约定报出聚合面在哪：不猜路径，当作没起来', async () => {
    const { result } = await fails(
      { home: homeOf('garbled'), mode: 'garbled' },
      'startFailed',
      /^connect\.adapterStartFailed$/,
      true,
    )
    assert.match(result.detail ?? '', /服务已启动/)
  })

  await check('一直起不来：到时间就不等了，等待中的那条命令被结束，之后会自己再试', async () => {
    const { tookMs } = await fails(
      { home: homeOf('hang'), mode: 'hang', flags: ['--timeout', '1500'] },
      'startFailed',
      /^connect\.adapterTimeout \{"seconds":2\}$/,
      true,
    )
    assert.ok(tookMs >= 1500 && tookMs < 10_000, `用了 ${tookMs} 毫秒`)
    await sleep(200)
    assert.equal(alive(callLog().at(-1).pid), false, '等待中的命令还留着')
  })

  await check('中途取消：等待中的那条命令被结束', async () => {
    const { lines } = await run({
      home: homeOf('abort'),
      mode: 'hang',
      flags: ['--abort-after', '600'],
    })
    assert.equal(resultOf(lines).result, 'aborted', JSON.stringify(lines))
    await sleep(200)
    assert.equal(alive(callLog().at(-1).pid), false, '取消之后命令还留着')
  })

  await check('说是起来了，套接字却不在：归到“连不到”，之后会自己再试', () =>
    fails(
      { home: homeOf('nosock'), mode: 'nosocket' },
      'unreachable',
      /^connect\.socketMissing /,
      true,
    ),
  )

  await check('服务攥着启动命令的输出管道不放：照样很快连上，不会一直等', async () => {
    const stuck = homeOf('i')
    services.push(() => devicePid(stuck))
    const { lines, tookMs } = await run({ home: stuck, mode: 'inherit' })
    assert.equal(resultOf(lines).result, 'ok', JSON.stringify(lines))
    assert.ok(tookMs < 10_000, `用了 ${tookMs} 毫秒`)
    assert.ok(alive(devicePid(stuck)), '管道那头关了，服务不该跟着没了')
  })

  await check('登录 shell 一直不返回：到时间就不等了，用应用自己的环境照样启动', async () => {
    const slow = homeOf('s')
    services.push(() => devicePid(slow))
    const { lines, tookMs } = await run({
      home: slow,
      loginShell: stuckShell,
      flags: ['--shell-timeout', '500'],
    })
    assert.equal(resultOf(lines).result, 'ok', JSON.stringify(lines))
    assert.ok(tookMs < 10_000, `用了 ${tookMs} 毫秒`)
    const call = callLog().at(-1)
    assert.equal(call.fromLogin, null)
    assert.notEqual(call.pathHead, loginPath)
    assert.equal(alive(Number(readFileSync(stuckPid, 'utf8'))), false, '没返回的 shell 还留着')
  })

  await check('登录 shell 不是认得的那几种：不去执行它，直接启动', async () => {
    const marker = join(work, 'odd', 'ran')
    mkdirSync(join(work, 'odd'))
    script(join(work, 'odd', 'tcsh'), `touch '${marker}'`)
    const before = callLog().length
    const { lines } = await run({ home: homeOf('s'), loginShell: join(work, 'odd', 'tcsh') })
    assert.equal(resultOf(lines).result, 'ok', JSON.stringify(lines))
    assert.equal(callLog().length, before + 1)
    assert.equal(existsSync(marker), false, '不认得的 shell 被执行了')
  })

  // ---------- 在跑的服务和自带的不是同一版 ----------

  await check(
    '版本比较的规则：逐段比数字，预发布比正式版旧，构建信息不算，读不懂的不比',
    async () => {
      const versions = [
        [['0.5.1', '0.5.1'], 0],
        [['0.5.1', '0.5.2'], -1],
        [['0.6.0', '0.5.9'], 1],
        // 按数值比，不按字面
        [['0.10.0', '0.9.9'], 1],
        [['1.0.0', '0.99.99'], 1],
        [['v1.2.0', '1.2.0'], 0],
        // 预发布
        [['1.2.0-rc.1', '1.2.0'], -1],
        [['1.2.0', '1.2.0-rc.1'], 1],
        [['1.2.0-rc.1', '1.2.0-rc.2'], -1],
        [['1.2.0-rc.10', '1.2.0-rc.9'], 1],
        [['1.2.0-alpha', '1.2.0-alpha.1'], -1],
        [['1.2.0-1', '1.2.0-alpha'], -1],
        [['1.2.0-beta', '1.2.0-alpha'], 1],
        // 构建信息不参加比较
        [['1.2.0+build.5', '1.2.0+build.9'], 0],
        [['1.2.0-rc.1+a', '1.2.0-rc.1+b'], 0],
        // 拿不到版本号的构建比任何正式版本都旧
        [['0.0.0-unknown', '0.0.1'], -1],
        [['0.0.0-unknown', '0.0.0-unknown'], 0],
        // 读不成语义化版本的不比
        [['1.2', '1.2.0'], null],
        [['nightly', '1.2.0'], null],
        [['', '1.0.0'], null],
      ]
      const at = { root: '/a', startedAt: '2026-10-13T00:00:00Z', detached: true, pid: 7 }
      const running = (version, more = {}) => ({ ...at, version, build: 'x', ...more })
      const bundled = (version, more = {}) => ({ root: '/a', version, build: 'x', ...more })
      const services = [
        // 在跑的没报来历，或者报得不成样子：不知道，按旧算
        [[null, bundled('0.5.1')], 'unknown'],
        [[{ version: '0.5.0' }, bundled('0.5.1')], 'unknown'],
        [[running('0.5.0'), bundled('0.5.1')], 'older'],
        [[running('0.5.2'), bundled('0.5.1')], 'newer'],
        [[running('0.5.1'), bundled('0.5.1')], 'same'],
        // 版本号一样、同一个根目录、程序文件的戳不一样：服务起来之后程序被换过
        [[running('0.5.1'), bundled('0.5.1', { build: 'y' })], 'rebuilt'],
        // 根目录不同的两份不比戳；有一边没有戳也不比
        [[running('0.5.1'), bundled('0.5.1', { build: 'y', root: '/b' })], 'same'],
        [[running('0.5.1', { build: undefined }), bundled('0.5.1', { build: 'y' })], 'same'],
        // 版本号不一样时不看戳
        [[running('0.5.2'), bundled('0.5.1', { build: 'y' })], 'newer'],
        // 读不成语义化版本：字面一样算同一版（再看戳），不一样就比不出先后
        [[running('nightly'), bundled('0.5.1')], 'incomparable'],
        [[running('nightly'), bundled('nightly')], 'same'],
        [[running('nightly'), bundled('nightly', { build: 'y' })], 'rebuilt'],
        // 拿不到版本号的那一边算旧：在跑的拿不到就换，自带的拿不到就不动
        [[running('0.0.0-unknown'), bundled('0.5.1')], 'older'],
        [[running('0.5.1'), bundled('0.0.0-unknown')], 'newer'],
      ]
      const asked = {
        versions: versions.map(([pair]) => pair),
        services: services.map(([pair]) => pair),
      }
      const { lines } = await run({
        home: homeOf('compare'),
        flags: ['--compare', JSON.stringify(asked)],
      })
      assert.deepEqual(lines, [
        {
          versions: versions.map(([, order]) => order),
          services: services.map(([, order]) => order),
        },
      ])
    },
  )

  await check(
    '在跑的比自带的旧而且闲着：停掉它，用自带的重新拉起，它启动时带的参数原样带上',
    async () => {
      // 这一份像是独立安装起的：开着 SSH 入口，端口是用户改过的
      const kept = ['--ssh=on', '--claude-port', '7441']
      const old = seed('up', { version: '1.0.0', options: kept })
      const { lines } = await run({ home: old.home, version: '1.1.0' })
      const result = resultOf(lines)
      assert.equal(result.result, 'ok', JSON.stringify(lines))
      assert.deepEqual(stepsOf(lines), ['connect.adapterStarting'])
      // 先问能不能连，再请它闲着的话停下，停了重新拉起：就这三条命令
      assert.deepEqual(callsSince(old.before), [
        startArgs(old.home, '--ssh=off'),
        stopArgs(old.home),
        startArgs(old.home, ...kept),
      ])
      for (const call of callLog().slice(old.before)) {
        assert.deepEqual([call.lang, call.leaked], ['zh-CN', []], call.args[0])
      }
      const pid = devicePid(old.home)
      assert.equal(alive(old.pid), false, '旧的那一份还在')
      assert.ok(pid && pid !== old.pid && alive(pid), '没有换上新的一份')
      assert.deepEqual(
        [result.last.started, result.last.pid, result.last.service.version],
        [true, pid, '1.1.0'],
      )
      assert.deepEqual(result.last.service.options, kept)
      assert.deepEqual(result.launched, result.last)
      assert.deepEqual(
        [result.upgrade.action, result.upgrade.order, result.upgrade.reason],
        ['replaced', 'older', null],
      )
      // 被换掉的是哪一版、自带的是哪一版，都交给调用方
      assert.deepEqual(
        [
          result.upgrade.running.version,
          result.upgrade.running.pid,
          result.upgrade.bundled.version,
        ],
        ['1.0.0', old.pid, '1.1.0'],
      )
      // 界面看到的：从哪一版换到哪一版，现在连着的是新起的那个进程
      assert.deepEqual(result.view, {
        action: 'replaced',
        bundled: { version: '1.1.0', root },
        previous: '1.0.0',
        order: 'older',
        reason: null,
        busy: [],
        detail: null,
        pid,
      })
      assert.ok(!JSON.stringify(result.view).includes('--claude-port'), '启动参数到了界面')
    },
  )

  await check(
    '在跑的比自带的旧但不闲：不换，照旧连上，两边的版本和不闲的原因都交给调用方；下次打开再问',
    async () => {
      const old = seed('busy', { version: '1.0.0' })
      const { lines } = await run({
        home: old.home,
        version: '1.1.0',
        stop: 'busy',
        flags: ['--reopen'],
      })
      const result = resultOf(lines)
      assert.equal(result.result, 'ok', JSON.stringify(lines))
      assert.equal(devicePid(old.home), old.pid, '不闲的服务被换掉了')
      assert.ok(alive(old.pid))
      assert.deepEqual(
        [result.last.started, result.last.pid, result.launched],
        [false, old.pid, null],
      )
      const { detail, ...upgrade } = result.upgrade
      assert.deepEqual(upgrade, {
        action: 'kept',
        running: result.last.service,
        bundled: { version: '1.1.0', root, build: 'b1' },
        order: 'older',
        reason: 'busy',
        busy: [
          { reason: 'activeTurns', harnesses: ['pi'], count: 0 },
          { reason: 'clients', harnesses: [], count: 2 },
        ],
      })
      assert.equal(upgrade.running.version, '1.0.0')
      assert.match(detail, /有回合在跑/)
      // 界面看到的：两边的版本、逐条的原因、命令行的原话，连着的还是旧的那个进程
      assert.deepEqual(result.view, {
        action: 'kept',
        bundled: { version: '1.1.0', root },
        previous: '1.0.0',
        order: 'older',
        reason: 'busy',
        busy: upgrade.busy,
        detail,
        pid: old.pid,
      })
      // 同一次运行里再打开一次：不闲的不记仇，再问一遍（闲了就能换）
      const again = lines.find((line) => line.reopened).reopened
      assert.equal(again.upgrade.reason, 'busy')
      assert.deepEqual([again.view.reason, again.view.busy], ['busy', upgrade.busy])
      assert.deepEqual(callsSince(old.before), [
        startArgs(old.home, '--ssh=off'),
        stopArgs(old.home),
        startArgs(old.home, '--ssh=off'),
        stopArgs(old.home),
      ])
    },
  )

  await check('在跑的比自带的新：直接用，绝不降级，没有去停它', async () => {
    const newer = seed('newer', { version: '2.0.0' })
    const { lines } = await run({ home: newer.home, version: '1.1.0' })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.deepEqual(callsSince(newer.before), [startArgs(newer.home, '--ssh=off')])
    assert.equal(devicePid(newer.home), newer.pid)
    assert.deepEqual(
      [result.upgrade.action, result.upgrade.reason, result.upgrade.order],
      ['kept', 'newer', 'newer'],
    )
    assert.deepEqual(
      [result.upgrade.running.version, result.upgrade.bundled.version],
      ['2.0.0', '1.1.0'],
    )
    assert.deepEqual(
      [result.view.action, result.view.reason, result.view.order, result.view.previous],
      ['kept', 'newer', 'newer', '2.0.0'],
    )
    assert.deepEqual([result.view.bundled.version, result.view.pid], ['1.1.0', newer.pid])
  })

  await check('在跑的没报自己的来历（比这项功能出现得早）：按旧算，闲着就换掉', async () => {
    const old = seed('unknown', { service: 'nofacts' })
    const { lines } = await run({ home: old.home, version: '1.1.0' })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    // 它没记启动时带的参数：重新拉起时用我们自己的默认
    assert.deepEqual(callsSince(old.before), [
      startArgs(old.home, '--ssh=off'),
      stopArgs(old.home),
      startArgs(old.home, '--ssh=off'),
    ])
    assert.equal(alive(old.pid), false, '旧的那一份还在')
    assert.deepEqual(
      [result.upgrade.action, result.upgrade.order, result.upgrade.running],
      ['replaced', 'unknown', null],
    )
    assert.equal(result.last.service.version, '1.1.0')
    // 被换掉的那一份没报过版本：界面上“之前的版本”是空的
    assert.deepEqual(
      [result.view.action, result.view.order, result.view.previous, result.view.bundled.version],
      ['replaced', 'unknown', null, '1.1.0'],
    )
  })

  await check('在跑的不认识停止的请求：不换，照旧连上并说明原因；同一份服务不再去问', async () => {
    const old = seed('unsupported', { service: 'nofacts' })
    const { lines } = await run({
      home: old.home,
      version: '1.1.0',
      stop: 'unsupported',
      flags: ['--reopen'],
    })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.equal(devicePid(old.home), old.pid)
    assert.deepEqual(
      [result.upgrade.action, result.upgrade.reason, result.upgrade.order, result.upgrade.running],
      ['kept', 'unsupported', 'unknown', null],
    )
    assert.match(result.upgrade.detail, /没法请它停/)
    // 界面看到的：它没报来历，版本是空的；要人手工结束它，所以进程号得有——用的是就绪行里的那个
    assert.deepEqual(result.view, {
      action: 'kept',
      bundled: { version: '1.1.0', root },
      previous: null,
      order: 'unknown',
      reason: 'unsupported',
      busy: [],
      detail: result.upgrade.detail,
      pid: old.pid,
    })
    // 再打开一次：问多少遍都一样，不再执行 device-stop，原因照样带着
    const again = lines.find((line) => line.reopened).reopened
    assert.deepEqual(
      [again.upgrade.reason, again.upgrade.detail],
      ['unsupported', result.upgrade.detail],
    )
    assert.deepEqual(again.view, result.view)
    assert.deepEqual(callsSince(old.before), [
      startArgs(old.home, '--ssh=off'),
      stopArgs(old.home),
      startArgs(old.home, '--ssh=off'),
    ])
  })

  await check(
    '在跑的不是 device-start 拉起的（前台、服务管理器管着）：不替它换，没有去停它',
    async () => {
      const old = seed('foreground', { version: '1.0.0', service: 'foreground' })
      const { lines } = await run({ home: old.home, version: '1.1.0' })
      const result = resultOf(lines)
      assert.equal(result.result, 'ok', JSON.stringify(lines))
      assert.deepEqual(callsSince(old.before), [startArgs(old.home, '--ssh=off')])
      assert.equal(devicePid(old.home), old.pid)
      assert.deepEqual(
        [result.upgrade.action, result.upgrade.reason, result.upgrade.order],
        ['kept', 'foreground', 'older'],
      )
      assert.equal(result.upgrade.running.detached, false)
      assert.deepEqual(
        [result.view.reason, result.view.order, result.view.previous, result.view.pid],
        ['foreground', 'older', '1.0.0', old.pid],
      )
    },
  )

  await check('版本号一样但程序换过（同一个根目录，戳不同）：按旧算，闲着就换掉', async () => {
    const old = seed('rebuilt', { version: '1.0.0', build: 'b1' })
    const { lines } = await run({ home: old.home, version: '1.0.0', build: 'b2' })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.equal(alive(old.pid), false, '旧的那一份还在')
    assert.deepEqual(
      [result.upgrade.action, result.upgrade.order, result.last.service.build],
      ['replaced', 'rebuilt', 'b2'],
    )
    // 版本号没变：界面靠 order 说“程序换成了现在的这一份”
    assert.deepEqual(
      [result.view.action, result.view.order, result.view.previous, result.view.bundled.version],
      ['replaced', 'rebuilt', '1.0.0', '1.0.0'],
    )
  })

  await check('版本号比不出先后：不知道谁新就不动', async () => {
    const odd = seed('odd', { version: 'nightly' })
    const { lines } = await run({ home: odd.home, version: '1.1.0' })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.deepEqual(callsSince(odd.before), [startArgs(odd.home, '--ssh=off')])
    assert.deepEqual(
      [result.upgrade.action, result.upgrade.reason, result.upgrade.order],
      ['kept', 'incomparable', 'incomparable'],
    )
    assert.deepEqual(
      [result.view.reason, result.view.order, result.view.previous],
      ['incomparable', 'incomparable', 'nightly'],
    )
  })

  await check(
    '去停了却没停成：照旧连上旧的，详情里是命令行的原话；同一份服务不再去停',
    async () => {
      const old = seed('stopfail', { version: '1.0.0' })
      const { lines } = await run({
        home: old.home,
        version: '1.1.0',
        stop: 'fail',
        flags: ['--reopen'],
      })
      const result = resultOf(lines)
      assert.equal(result.result, 'ok', JSON.stringify(lines))
      assert.equal(devicePid(old.home), old.pid)
      assert.deepEqual(
        [result.upgrade.action, result.upgrade.reason, result.upgrade.order],
        ['kept', 'failed', 'older'],
      )
      assert.match(result.upgrade.detail, /迟迟没有退出/)
      assert.equal(lines.find((line) => line.reopened).reopened.upgrade.reason, 'failed')
      // 界面看到的：没停成，命令行的原话照带
      assert.deepEqual(
        [result.view.action, result.view.reason, result.view.previous, result.view.pid],
        ['kept', 'failed', '1.0.0', old.pid],
      )
      assert.equal(result.view.detail, result.upgrade.detail)
      // 没停成之后再问一次现在是什么样（第二条 device-start）；再打开时只问能不能连，不再去停
      assert.deepEqual(callsSince(old.before), [
        startArgs(old.home, '--ssh=off'),
        stopArgs(old.home),
        startArgs(old.home, '--ssh=off'),
        startArgs(old.home, '--ssh=off'),
      ])
    },
  )

  await check('device-stop 一直不返回：到时间就不等了，那条命令被结束，照旧连上旧的', async () => {
    const old = seed('stophang', { version: '1.0.0' })
    const { lines, tookMs } = await run({
      home: old.home,
      version: '1.1.0',
      stop: 'hang',
      flags: ['--stop-timeout', '800'],
    })
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.ok(tookMs >= 800 && tookMs < 10_000, `用了 ${tookMs} 毫秒`)
    assert.deepEqual([result.upgrade.action, result.upgrade.reason], ['kept', 'failed'])
    assert.deepEqual([result.view.action, result.view.reason], ['kept', 'failed'])
    assert.ok(alive(old.pid), '服务不该被动到')
    const stopping = callLog()
      .slice(old.before)
      .find((call) => call.args[0] === 'device-stop')
    assert.equal(alive(stopping.pid), false, '等待中的 device-stop 还留着')
  })

  await check('换版本途中取消：等待中的那条命令被结束，服务没有动', async () => {
    const old = seed('stopabort', { version: '1.0.0' })
    const { lines } = await run({
      home: old.home,
      version: '1.1.0',
      stop: 'hang',
      flags: ['--abort-after', '1500'],
    })
    assert.equal(resultOf(lines).result, 'aborted', JSON.stringify(lines))
    await sleep(200)
    const last = callLog().at(-1)
    assert.equal(last.args[0], 'device-stop', '取消的时候应当正等着 device-stop')
    assert.equal(alive(last.pid), false, '取消之后命令还留着')
    assert.ok(alive(old.pid), '服务不该被动到')
  })

  console.log(`本机内置适配器的自检通过：${passed.length} 项`)
} catch (error) {
  console.error(
    `本机内置适配器的自检没过（已通过 ${passed.length} 项）：\n${error?.stack ?? error}`,
  )
  process.exitCode = 1
} finally {
  // 停掉这次起过的假设备进程（按它们自己记下的进程号，不按名字找），等它们退干净再删临时目录
  const pids = services.map((find) => find()).filter((value) => value && alive(value))
  for (const value of pids) process.kill(value, 'SIGTERM')
  for (let waited = 0; waited < 3000 && pids.some(alive); waited += 50) await sleep(50)
  for (const value of pids.filter(alive)) process.kill(value, 'SIGKILL')
  rmSync(work, { recursive: true, force: true })
}
