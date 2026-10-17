// 本机自带适配器的真链路自检：真的 Go 命令行、自带的那份 Node、真的设备进程、真的 Pi 运行时一起跑。不起界面。
// check-adapter.mjs 用假的命令行验的是“客户端这一侧怎么应对各种结果”，这里验的是那条链路本身拉得起来、跑得通：
//   服务不在时被拉起来并连上聚合面；各进程用的是自带的 Node；在 Pi 上新建会话、跑通一个回合；
//   小工具退出之后服务还在，再连直接复用；交给服务的环境是登录 shell 里的那一份，不带我们自己的变量；
//   结束后服务停干净，临时目录删掉，平时用的状态目录没被碰。
//
//   npm run check:local                         用 out/adapter（先 npm run stage:adapter）
//   node scripts/check-local.mjs --adapter 目录  换一份适配器，比如装好的应用里的 Contents/Resources/adapter
//   node scripts/check-local.mjs --tool 文件     换一份小工具的产物（默认 dist/adapter-check.mjs）
//
// 隔离环境由 scripts/client-local-fixture.mjs 备：临时的状态目录和主目录、回环上的假模型、假的登录 shell。
// 用户自己装的 claude、pi、dsh 一个都不会被执行，~/.codex-harness-adapter 只读不写。只在 macOS 上验过。
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADAPTER_STAGE } from './stage-adapter.mjs'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const option = (name) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? process.argv[at + 1] : undefined
}
const tool = resolve(
  option('--tool') ?? fileURLToPath(new URL('../dist/adapter-check.mjs', import.meta.url)),
)
const adapter = resolve(option('--adapter') ?? process.env.LITCH_ADAPTER_ROOT ?? ADAPTER_STAGE)
const cli = join(adapter, 'bin', 'codex-harness-adapter')
const node = join(adapter, 'node', 'bin', 'node')

for (const [path, hint] of [
  [tool, '请先运行 npm run build（apps/desktop）'],
  [cli, '请先运行 npm run client:stage:adapter，或用 --adapter 指到一份暂存好的目录'],
  [node, '这份适配器里没有自带的 Node，重新暂存一遍'],
  [join(adapter, 'packages/device/dist/device/src/main.mjs'), '这份适配器里没有设备进程'],
]) {
  if (existsSync(path)) continue
  console.error(`没有找到 ${path}：${hint}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
// 给 ps 一个 UTF-8 的区域设置：不给的话命令行里的汉字会被它写成 M-f 这样的转义
const ps = (args) =>
  execFileSync('/bin/ps', args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
  })

/** 现在的全部进程：进程号、父进程号、命令行 */
const processes = () =>
  ps(['-axww', '-o', 'pid=,ppid=,command='])
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }))

/**
 * 一个进程启动时拿到的环境变量。ps 把它们接在命令行后面给出来，先去掉命令行那一截再按空格拆；
 * 值里有空格的会被拆断，但名字和不带空格的值（我们要对的 PATH、主目录都是）不受影响
 */
function environmentOf(pid) {
  const command = ps(['-ww', '-o', 'command=', '-p', String(pid)]).trimEnd()
  const full = ps(['eww', '-o', 'command=', '-p', String(pid)]).trimEnd()
  assert.ok(command && full.startsWith(command), `读不到进程 ${pid} 的环境`)
  const env = {}
  for (const part of full.slice(command.length).split(' ')) {
    const at = part.indexOf('=')
    if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part.slice(0, at))) {
      env[part.slice(0, at)] = part.slice(at + 1)
    }
  }
  assert.ok(env.PATH, `读不到进程 ${pid} 的环境`)
  return env
}

/** 一个目录现在的样子：每一项的路径、修改时间、大小。只读，用来看它有没有被动过。目录不在就是 null */
function fingerprint(directory) {
  if (!existsSync(directory)) return null
  const lines = []
  const walk = (path) => {
    const info = lstatSync(path)
    lines.push(
      `${relative(directory, path) || '.'}\t${info.mtimeMs}\t${info.isDirectory() ? '目录' : info.size}`,
    )
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
  }
  walk(directory)
  return lines
}

/** 平时用的状态目录。这次自检从头到尾不许动它 */
const realHome = join(homedir(), '.codex-harness-adapter')
const realBefore = fingerprint(realHome)
/** 有没有进程（主人自己开着的 Litch 或命令行起的服务）正用着平时的状态目录 */
const realInUse = () => processes().some((entry) => entry.command.includes(realHome))

/** 起隔离环境，等它就绪 */
function startFixture() {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      // 假模型发得快一点：这里只看回合跑不跑得通，不用看着字一点一点出来
      ['scripts/client-local-fixture.mjs', '--adapter', adapter, '--pace', '30'],
      { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let errors = ''
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
    child.stderr.on('data', (chunk) => {
      errors += chunk
    })
    child.stdout.on('data', (chunk) => {
      output += chunk
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_LOCAL_FIXTURE '))
      if (!line) return
      done({
        ...JSON.parse(line.slice('LITCH_LOCAL_FIXTURE '.length)),
        /** 请它收尾，等它退出。返回退出码和它在标准错误里说的话 */
        async stop() {
          child.kill('SIGTERM')
          return { code: await exited, errors }
        },
      })
    })
    child.once('exit', (code) => fail(new Error(`隔离环境没起来（退出码 ${code}）：\n${errors}`)))
  })
}

const fixture = await startFixture()
const { home, login } = fixture
const socket = join(home, 'device', 'device.sock')

/**
 * 哨兵：名叫 claude、pi、dsh、codex、opencode、gemini、qwen 的小脚本，被执行就记一笔。放进小工具自己的环境里
 * （PATH 的最前面，加上几个指路的变量），装成“应用自己的环境里就有用户装的 harness”，比如应用是从终端里启动的。
 * 登录 shell 给的环境应当把它们全盖掉：记录里只要有一行，就说明服务用了应用自己环境里的 harness，
 * 换成真的机器，被执行的就是用户真实的 claude，或者对着用户自己的 ~/.codex 起来的 codex（它装了就默认启用）。
 */
const decoys = join(fixture.root, 'decoy')
const decoyLog = join(decoys, 'ran.log')
mkdirSync(decoys)
for (const name of ['claude', 'pi', 'dsh', 'codex', 'opencode', 'gemini', 'qwen']) {
  writeFileSync(join(decoys, name), `#!/bin/sh\necho "${name} $*" >> '${decoyLog}'\nexit 1\n`)
  chmodSync(join(decoys, name), 0o755)
}

/**
 * 跑一次小工具，返回它打出来的每一行。环境只给这几样，不继承这边的任何东西（个人的 PATH、模型凭据都不带）：
 * 夹具说要带的那几个变量；主目录也放在临时目录里，万一状态目录没传到，碰到的也不是平时用的那一份；
 * 上面的哨兵；另外故意带上 ELECTRON_RUN_AS_NODE 和几个 LITCH_ 开头的，看它们会不会漏给服务。
 */
function run(flags) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [tool, ...flags], {
      env: {
        HOME: login.home,
        PATH: `${decoys}:/usr/bin:/bin`,
        CHA_CLAUDE_CLI: join(decoys, 'claude'),
        PI_CLI: join(decoys, 'pi'),
        CHA_DSH_CLI: join(decoys, 'dsh'),
        CHA_OPENCODE_CLI: join(decoys, 'opencode'),
        CHA_GEMINI_CLI: join(decoys, 'gemini'),
        CHA_QWEN_CLI: join(decoys, 'qwen'),
        ...fixture.env,
        LITCH_LANG: 'zh-CN',
        ELECTRON_RUN_AS_NODE: '1',
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
    // 命令行自己最多等 45 秒，回合最多等 60 秒；到这个数还没完就是挂住了
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        const lines = stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        done({ lines, code })
      } catch {
        fail(new Error(`小工具的输出读不懂（退出码 ${code}）：\n${stdout}\n${stderr}`))
      }
    })
  })
}

const pick = (lines, key) => lines.find((line) => line[key])?.[key]
const resultOf = (lines) => lines.find((line) => line.result) ?? {}
const readLog = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
/** 常驻服务的子进程：运行时和设备进程 */
const childrenOf = (pid) => processes().filter((entry) => entry.ppid === pid)
/** 命令行里带着这次临时目录的进程。隔离环境退出之后应当一个都没有 */
const strays = () => processes().filter((entry) => entry.command.includes(fixture.root))

const executable = (path) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const passed = []
const check = async (name, body) => {
  await body()
  passed.push(name)
  console.log(`  ✓ ${name}`)
}

/** 自检发的那句话。带着时间，免得和别的回话碰巧对上 */
const said = `自检发的一句话 ${Date.now()}`
/** 第一次连得到的每一行，后面几项接着用 */
let first = null
/** 常驻服务的进程号，和见过的它的子进程。结束时要确认它们都不在了 */
let service = null
const seen = new Set()
const notes = []
let failure = null

// 被中断时也把隔离环境收掉，不留服务和临时目录
for (const name of ['SIGINT', 'SIGTERM']) {
  process.on(name, () => void fixture.stop().then(() => process.exit(130)))
}

try {
  await check('第一次连：服务不在，被拉起来，聚合面连上', async () => {
    assert.equal(existsSync(socket), false, '还没连，聚合面的套接字就已经在了')
    assert.deepEqual(strays(), [], '还没连，这个状态目录上就已经有进程了')
    const { lines, code } = await run([
      '--info',
      ...['--turn', fixture.harness, '--model', fixture.model],
      ...['--cwd', fixture.cwd, '--say', said],
    ])
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.equal(code, 0)
    assert.deepEqual(
      lines.filter((line) => line.step).map((line) => line.step),
      ['connect.adapterStarting'],
    )
    // 命令行报回来的那一行：是这次拉起来的，套接字在临时的状态目录里
    assert.equal(result.last.started, true, '服务不是这次拉起来的')
    assert.equal(result.last.socket, socket)
    assert.deepEqual(result.launched, result.last)
    service = result.last.pid
    // 服务报了自己是哪一份：就是自带的这一份拉起来的，脱离出去的，启动时带的参数也记着
    const facts = result.last.service
    assert.deepEqual(
      [facts.pid, facts.root, facts.detached, facts.options[0]],
      [service, adapter, true, '--ssh=off'],
      JSON.stringify(facts),
    )
    assert.deepEqual(result.last.cli, {
      version: facts.version,
      root: adapter,
      build: facts.build,
    })
    assert.equal(result.upgrade.action, 'launched', JSON.stringify(result.upgrade))
    assert.ok(service && alive(service), '命令行报的常驻进程不在')
    first = lines
  })

  await check(
    'runtime/info：已知的 harness 都列出来了，只有隔离的 Pi 可用；claude-code 是没装（找不到命令行，不是执行之后失败），原生 codex 也是没装（登录 shell 给的 PATH 里没有它，装了才默认启用）',
    async () => {
      const info = pick(first, 'info')
      assert.ok(info?.device && Array.isArray(info.harnesses), '不是聚合面的 runtime/info')
      assert.ok(info.device.extensions.includes('harness'))
      assert.equal(info.device.home, login.home, '设备进程看到的主目录不是登录 shell 给的那个')
      // 已知的 harness 不管起没起来都要列出来，客户端才说得出哪个不可用、为什么
      const byId = Object.fromEntries(info.harnesses.map((entry) => [entry.id, entry]))
      assert.deepEqual(Object.keys(byId).sort(), [
        'acp',
        'claude-code',
        'codex',
        'dsh',
        'gemini',
        'opencode',
        'pi',
        'qwen',
      ])
      assert.equal(
        byId.codex.unavailable?.kind,
        'notInstalled',
        `原生 codex 应当报没装：${JSON.stringify(byId.codex)}`,
      )
      const { pi, dsh, 'claude-code': claude } = byId
      assert.ok(pi.available, `Pi 不可用：${JSON.stringify(pi)}`)
      assert.equal(pi.engine, 'pi')
      assert.match(pi.version ?? '', /^\d+\.\d+\.\d+/)
      assert.equal(claude.available, false, 'claude-code 居然可用')
      assert.equal(claude.unavailable?.kind, 'notInstalled', JSON.stringify(claude))
      assert.ok(claude.unavailable.message, 'claude-code 不可用，却没有说原因')
      // dsh 还在实验阶段，检测到装了才启用：这里要么是没启用，要么是没装
      assert.equal(dsh.available, false, 'dsh 居然可用')
      assert.ok(['disabled', 'notInstalled'].includes(dsh.unavailable?.kind), JSON.stringify(dsh))
      // OpenCode 装了才启用，这里没装；经 ACP 接的几个默认不启用
      assert.equal(byId.opencode.available, false, 'opencode 居然可用')
      assert.equal(byId.opencode.unavailable?.kind, 'notInstalled', JSON.stringify(byId.opencode))
      for (const id of ['gemini', 'qwen', 'acp']) {
        assert.equal(byId[id].unavailable?.kind, 'disabled', JSON.stringify(byId[id]))
      }
      // “没装”得是真的没找到，不是执行了什么之后失败：它要找的那个路径（夹具指的）确实不存在；
      // 它自己的诊断日志里是“未找到”那一句，找的正是这个路径；执行过再失败的话，日志里会是读不出版本或版本不符
      assert.equal(existsSync(login.claude), false)
      const diagnostics = readLog(join(home, 'claude-code', 'diagnostics.log'))
      assert.ok(
        diagnostics.includes(`宿主 Claude CLI 不可执行或未找到: ${login.claude}`),
        `claude-code 的诊断日志里不是预期的原因：\n${diagnostics}`,
      )
      assert.doesNotMatch(diagnostics, /无法读取宿主 Claude CLI 版本|Claude CLI 版本不符/)
      assert.doesNotMatch(
        readLog(join(home, 'dsh', 'diagnostics.log')),
        /无法读取宿主 dsh CLI 版本|dsh CLI 版本不符/,
      )
      // 这几个的运行时都没有起
      for (const id of ['claude-code', 'dsh', 'opencode', 'gemini', 'qwen', 'acp']) {
        assert.equal(existsSync(join(home, id, 'runtime.sock')), false, `${id} 的运行时起来了`)
      }
    },
  )

  await check(
    '服务是自带的命令行起的，运行时和设备进程用的是自带的那份 Node，不监听任何端口',
    async () => {
      const main = processes().find((entry) => entry.pid === service)
      assert.ok(
        main?.command.startsWith(
          `${cli} start --home ${home} --root ${adapter} --node ${node} --ssh=off`,
        ),
        `常驻服务的命令行不对：${main?.command}`,
      )
      const children = childrenOf(service)
      for (const entry of children) seen.add(entry.pid)
      // 每一个子进程都是自带的 Node 在跑自带目录里的脚本
      for (const entry of children) {
        assert.ok(entry.command.startsWith(`${node} ${adapter}/packages/`), entry.command)
      }
      const runtimes = children.filter((entry) => entry.command.includes(' app-server '))
      assert.equal(runtimes.length, 1, `运行时不是恰好一个：${JSON.stringify(runtimes)}`)
      assert.ok(runtimes[0].command.includes(`${adapter}/packages/pi/dist/pi/src/adapter.mjs`))
      const device = children.find((entry) =>
        entry.command.includes(`${adapter}/packages/device/dist/device/src/main.mjs`),
      )
      assert.ok(device, '没有看到设备进程')
      assert.ok(
        device.command.includes(` --upstream pi=unix://${home}/pi/runtime.sock`),
        device.command,
      )
      // 桌面端拉起的服务不开内置的 SSH 入口（--ssh=off）：它和它的子进程一个端口都不监听
      const pids = [service, ...children.map((entry) => entry.pid)]
      const lsof = spawnSync(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(',')],
        { encoding: 'utf8' },
      )
      if (lsof.error) notes.push(`这台机器上没有 lsof，没有验“不监听端口”：${lsof.error.message}`)
      else assert.equal(lsof.stdout.trim(), '', `服务在监听端口：\n${lsof.stdout}`)
    },
  )

  await check('在 Pi 上新建会话、跑通一个回合，回话对得上；之后会话列表里有它', async () => {
    const turn = pick(first, 'turn')
    assert.equal(turn.status, 'completed', JSON.stringify(turn))
    assert.ok(turn.reply.startsWith(`收到：${said}`), turn.reply)
    assert.equal(turn.echoed, true)
    assert.equal(turn.streamed, true, '回话没有分段到达')
    assert.deepEqual(
      resultOf(first).sessions.filter((entry) => entry.id === turn.threadId),
      [{ id: turn.threadId, harness: 'pi' }],
    )
    // 模型请求真的到了回环上的假模型
    const requests = readLog(fixture.modelLog)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.ok(
      requests.some((entry) => entry.said === said),
      '假模型没有收到这句话',
    )
  })

  await check(
    '交给服务的环境是登录 shell 里的那一份：不带 LITCH_ 开头的变量和 ELECTRON_RUN_AS_NODE，应用自己环境里的 harness 没被执行',
    async () => {
      for (const pid of [service, ...childrenOf(service).map((entry) => entry.pid)]) {
        const env = environmentOf(pid)
        assert.deepEqual(
          Object.keys(env).filter(
            (name) => name.startsWith('LITCH_') || name === 'ELECTRON_RUN_AS_NODE',
          ),
          [],
          `我们自己的变量漏给了进程 ${pid}`,
        )
        assert.equal(env.PATH, login.path, '服务的 PATH 不是登录 shell 给的那一份')
        assert.equal(env.HOME, login.home)
        assert.equal(env[login.mark.name], login.mark.value, '登录 shell 里导出的变量没有交给服务')
        assert.equal(env.CHA_LANG, 'zh-CN', '没有把命令行的语言固定下来')
      }
      // 这份 PATH 里确实找不到用户装的 harness
      for (const directory of login.path.split(':')) {
        for (const name of ['claude', 'pi', 'dsh']) {
          assert.equal(executable(join(directory, name)), false, `${directory} 里有 ${name}`)
        }
      }
      const ran = readLog(decoyLog)
      assert.equal(ran, '', `应用自己环境里的 harness 被执行了：\n${ran}`)
      // 状态目录用的是指定的那个：主目录里没有另外建出一份
      assert.equal(existsSync(join(login.home, '.codex-harness-adapter')), false)
    },
  )

  await check('小工具退出之后服务还在；再连一次直接用它，没有另起一份，会话还在', async () => {
    // 设备进程每秒看一眼拉起它的进程还在不在：多等一会儿，确认不是“还没来得及退”
    await sleep(1500)
    assert.ok(alive(service), '小工具退出之后服务跟着没了')
    assert.ok(existsSync(socket))
    const before = childrenOf(service).map((entry) => entry.pid)
    const { lines } = await run(['--info'])
    const result = resultOf(lines)
    assert.equal(result.result, 'ok', JSON.stringify(lines))
    assert.deepEqual(
      [result.last.socket, result.last.started, result.last.pid, result.last.service.pid],
      [socket, false, service, service],
    )
    assert.equal(result.launched, null)
    // 在跑的就是自带的这一份：不动它
    assert.deepEqual(
      [result.upgrade.action, result.upgrade.reason, result.upgrade.order],
      ['kept', 'same', 'same'],
      JSON.stringify(result.upgrade),
    )
    assert.ok(pick(lines, 'info').harnesses.find((entry) => entry.id === 'pi')?.available)
    const { threadId } = pick(first, 'turn')
    assert.ok(
      result.sessions.some((entry) => entry.id === threadId && entry.harness === 'pi'),
      '刚才的会话不在列表里了',
    )
    // 运行时和设备进程还是原来那两个，没有被重启
    assert.deepEqual(
      childrenOf(service).map((entry) => entry.pid),
      before,
    )
    for (const pid of before) seen.add(pid)
    const turn = pick(first, 'turn')
    notes.push(
      `第一次连 ${resultOf(first).connectMs} 毫秒（含拉起服务），一个回合 ${turn.tookMs} 毫秒` +
        `（第一段字 ${turn.firstDeltaMs} 毫秒），再连 ${result.connectMs} 毫秒`,
    )
  })
} catch (error) {
  failure = error
}

// 不管前面过没过，都把隔离环境收掉，再看收得干不干净。哨兵的记录在临时目录里，先读出来
const decoyRan = readLog(decoyLog)
const ended = await fixture.stop()
try {
  await check(
    '结束后：服务停干净，没有残留的进程，临时目录删掉了，平时用的状态目录没被碰（它正被别的服务用着时不比）',
    async () => {
      assert.equal(ended.code, 0, `隔离环境收尾时出了问题：\n${ended.errors}`)
      assert.equal(decoyRan, '', `应用自己环境里的 harness 被执行了：\n${decoyRan}`)
      assert.deepEqual(
        [service, ...seen].filter((pid) => pid && alive(pid)),
        [],
        '服务或它的子进程还在',
      )
      assert.deepEqual(strays(), [], '还有带着这次临时目录的进程')
      assert.equal(existsSync(fixture.root), false, '临时目录没有删掉')
      // 这台机器上的主人自己开着 Litch 时，它的服务一直在往平时的状态目录里写（会话库、日志），比不出谁动的：
      // 那就不比，写一句；没人用着它时照旧要一模一样（这次自检自己不往里写任何东西）
      if (realInUse()) notes.push(`${realHome} 有服务正用着，自检前后没有比对它`)
      else assert.deepEqual(fingerprint(realHome), realBefore, `${realHome} 在自检期间变了`)
    },
  )
} catch (error) {
  failure ??= error
}

for (const note of notes) console.log(`  · ${note}`)
if (failure) {
  console.error(
    `本机自带适配器的真链路自检没过（已通过 ${passed.length} 项）：\n${failure?.stack ?? failure}`,
  )
  process.exitCode = 1
} else {
  console.log(`本机自带适配器的真链路自检通过：${passed.length} 项`)
}
