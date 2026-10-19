// 假的远程机器上“装了适配器”的那一半（client-ssh-fixture.mjs 用）。
//
// 这里的适配器是真的：仓库里编出来的 Go 命令行（bin/codex-harness-adapter），根目录就是仓库，
// 由它拉起真的 Pi 运行时和设备进程。常驻服务不在这里起：客户端经 ssh 执行 device-start 时才被拉起，
// 这正是要验的那条链路。这里只把环境备好：
//   <根>/abin/<适配器的替身名>   包装脚本：指死环境变量之后执行真的命令行
//   <根>/nbin/…                 同上，但 device-start 带一个不存在的 Node：验“设备服务起不来”
//   <根>/obin/…                 一个太旧的适配器：不认识 version，也没有设备服务那几条子命令
//   <根>/agent                  Pi 的配置目录：只有一个模型，地址是回环上的假模型
//   <根>/s、p、l、n             几个各自独立的“主目录”，状态目录就是各自的 ~/.codex-harness-adapter：
//     s  装了适配器（svc、both，以及 grow 装上之后）
//     p  命令只在默认的安装位置 ~/.local/bin 里，不在 PATH 里
//     l  有一份不带聚合面的旧服务在跑：一个只管接连接的套接字冒充它的运行时
//     n  设备服务起不来
// 哪个别名用哪个主目录、PATH 里有什么，由 client-ssh-fixture.mjs 写的启动脚本按情形定。
//
// 隔离：包装脚本把 PATH 换成“起夹具的这份 Node 的目录加系统目录”，各 harness 的命令行都指死——
// Pi 指到仓库里夹具用的那一份（packages/pi 的开发依赖），Claude Code 和 dsh 指到不存在的路径
// （--engines 要了的几家由设置文件给隔离的副本，设置比环境变量优先，见 client-fixture-engines.mjs）；
// 原生 codex 在设备服务里装了才默认打开，而 PATH 里没有它。所以这台电脑上装着的 claude、pi、dsh、codex 一个都不会被执行，
// 模型请求全部落在回环上的假模型上，~/.codex-harness-adapter 也碰不到（主目录是临时的）。
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { dirname, join } from 'node:path'
import { serveAnthropic } from './client-fixture-anthropic.mjs'
import { askReply, installAskExtension } from './client-fixture-ask.mjs'
import { browseReply } from './client-fixture-browse.mjs'
import { computerReply } from './client-fixture-computer.mjs'
import { echoReply, lastUserText } from './client-fixture-echo.mjs'
import { writeEngineSettings } from './client-fixture-engines.mjs'
import { machineReply } from './client-fixture-machine.mjs'
import { piReply } from './client-fixture-marks.mjs'
import { serveResponses } from './client-fixture-responses.mjs'
import { streamReply } from './client-fixture-stream.mjs'

/** 假的远程机器上适配器的替身名。客户端那边用 LITCH_REMOTE_ADAPTER 指过来 */
export const ADAPTER = 'litch-fx-adapter'

/** 状态目录在主目录下面的名字，和真的一样 */
const STATE = '.codex-harness-adapter'

const q = (text) => `'${text.replaceAll("'", `'\\''`)}'`

/** 一个主目录下最长的那条套接字路径有多长：命令行卡在 100 字节，系统的上限是 104 */
export const longestSocket = (root) =>
  Buffer.byteLength(join(root, 's', STATE, 'claude-code', 'runtime.sock'))

/**
 * 备好“装了适配器”的那一半。返回各个主目录、要写进启动脚本的几个目录，以及收尾的函数。
 * 缺构建产物时抛错，由调用方报出来。
 */
export async function prepareService({ repo, root, engines = {}, pace = 200 }) {
  const cli = join(repo, 'bin', 'codex-harness-adapter')
  for (const [path, hint] of [
    [cli, 'npm run build（根目录，要有 go）'],
    [join(repo, 'packages/pi/dist/pi/src/adapter.mjs'), 'npm run build --prefix packages/pi'],
    [join(repo, 'packages/device/dist/device/src/main.mjs'), 'npm run build（根目录）'],
  ]) {
    if (!existsSync(path)) throw new Error(`没有找到 ${path}，请先运行 ${hint}`)
  }
  const piPackage = join(repo, 'packages/pi/node_modules/@earendil-works/pi-coding-agent')
  if (!existsSync(join(piPackage, 'package.json'))) {
    throw new Error('没有找到夹具用的 Pi，请先运行 npm ci --prefix packages/pi')
  }
  const piEntry = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).main
  const piCli = join(piPackage, dirname(piEntry), 'cli.js')

  const homes = { svc: join(root, 's'), path: join(root, 'p'), legacy: join(root, 'l') }
  const down = join(root, 'n')
  const bins = { ok: join(root, 'abin'), down: join(root, 'nbin'), old: join(root, 'obin') }
  const agent = join(root, 'agent')
  const work = join(homes.svc, 'work')
  for (const directory of [...Object.values(homes), down, ...Object.values(bins), agent, work]) {
    mkdirSync(directory, { recursive: true })
  }
  const stateOf = (home) => join(home, STATE)

  // ---------- 假模型：把收到的那句话带回来，分几段慢慢发 ----------
  const modelLog = join(root, 'model.jsonl')
  let requests = 0
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const model = createHttpServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    // --engines 起的几家，地址里带着各自的标识（client-fixture-engines.mjs 写的设置）：说的是别的形态
    const [, id, ...rest] = (req.url ?? '').split('/')
    if (id === 'claude-code' || id === 'dsh') {
      appendFileSync(modelLog, `${JSON.stringify({ at: Date.now(), harness: id })}\n`)
      await serveAnthropic(id, `/${rest.join('/')}`, raw, res, pace)
      return
    }
    if (id === 'codex') {
      appendFileSync(modelLog, `${JSON.stringify({ at: Date.now(), harness: id })}\n`)
      await serveResponses(id, `/${rest.join('/')}`, raw, res, { serial: ++requests, pace })
      return
    }
    const body = JSON.parse(raw.toString() || '{}')
    requests++
    const said = lastUserText(body)
    appendFileSync(modelLog, `${JSON.stringify({ at: Date.now(), model: body.model, said })}\n`)
    // OpenCode 也说 OpenAI 兼容的这一种（/opencode/v1）：只认操作本机的那几句，别的照三引擎夹具的说法
    const other =
      id === 'opencode' ? (machineReply(body, said) ?? piReply('opencode', body, pace)) : null
    // 客户端工具（回声、浏览、操作应用、操作本机）认得出自己那一次，排在提问前面：提问见到工具结果就当成是它的回答
    const reply = other ??
      echoReply(body, said) ??
      browseReply(body, said) ??
      computerReply(body, said) ??
      machineReply(body, said) ??
      askReply(body, said) ??
      streamReply(body, said) ?? {
        text: `收到：${said}\n\n这是假的远程机器上的假模型在回话，分成几段慢慢发，好让界面上看得到字是一点一点出来的。`,
        pace,
      }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const head = {
      id: `mock_${requests}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
    }
    const chunk = (delta, finish = null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
      )
    const calls = reply.tools?.map((tool, index) => ({
      index,
      id: `call_${requests}_${index}`,
      type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.args) },
    }))
    if (calls) chunk({ role: 'assistant', tool_calls: calls })
    else {
      // 文字分几段发，让运行时那边产生真实的增量
      // 长回答自己定每块多少字（client-fixture-stream.mjs）；别的分成六段
      const size = reply.chunk ?? Math.max(1, Math.ceil(reply.text.length / 6))
      for (let at = 0; at < reply.text.length; at += size) {
        chunk(
          at === 0
            ? { role: 'assistant', content: reply.text.slice(0, size) }
            : { content: reply.text.slice(at, at + size) },
        )
        if (reply.pace) await pause(reply.pace)
        // 回合被打断时对面会断开这个请求，后面的不用发了
        if (res.destroyed) return
      }
    }
    chunk({}, calls ? 'tool_calls' : 'stop', {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    res.end('data: [DONE]\n\n')
  })
  // 不监听固定端口：让系统分配，只在回环上
  await new Promise((done) => model.listen(0, '127.0.0.1', done))
  writeFileSync(
    join(agent, 'models.json'),
    JSON.stringify({
      providers: {
        gate: {
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
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
    join(agent, 'settings.json'),
    JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
  )
  installAskExtension(agent)
  // --engines 要的几家：设置在服务起来之前写进 svc 那个状态目录，服务一起来就照着起
  if (Object.values(engines).some(Boolean)) {
    writeEngineSettings({
      home: stateOf(homes.svc),
      root,
      modelUrl: `http://127.0.0.1:${model.address().port}`,
      engines,
    })
  }

  // ---------- 适配器的包装脚本 ----------
  /** 服务和它跑的命令拿到的环境：只有这几样是指死的，主目录跟着登录时的那一个 */
  const pinned = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    TMPDIR: root,
    PI_CLI: piCli,
    PI_CODING_AGENT_DIR: agent,
    // 故意指到不存在的文件：有这两个变量，引擎就不去 PATH 里找 claude、dsh，这两个 harness 报“没装”
    CHA_CLAUDE_CLI: join(root, 'no-claude'),
    CHA_DSH_CLI: join(root, 'no-dsh'),
    // 新的几个照做：OpenCode 装了就启用，还会找 ~/.opencode/bin（这里的主目录是登录时的那个）；
    // 经 ACP 接的几个默认不启用，万一被打开了也找不到用户自己的
    CHA_OPENCODE_CLI: join(root, 'no-opencode'),
    CHA_GEMINI_CLI: join(root, 'no-gemini'),
    CHA_QWEN_CLI: join(root, 'no-qwen'),
    CHA_ACP_CLI: join(root, 'no-acp'),
    // 自检按中文的原话判断
    CHA_LANG: 'zh-CN',
    // 扫码绑定手机：设备服务改的钥匙文件就是夹具 sshd 认的那一份（sshd_config 的 AuthorizedKeysFile），
    // 不碰这台电脑真的 ~/.ssh/authorized_keys
    LITCH_AUTHORIZED_KEYS: join(root, 'authorized_keys'),
    LITCH_SSH_HOST_KEYS_DIR: join(root, 'host-keys'),
  }
  /** node：device-start 拉起服务时用哪个 Node。真的独立包自带一份，这里用起夹具的这一份 */
  const wrapper = (node) =>
    [
      '#!/bin/sh',
      '# 由 scripts/client-ssh-fixture-service.mjs 写出，只给假的远程机器用',
      ...Object.entries(pinned).map(([name, value]) => `${name}=${q(value)}; export ${name}`),
      'case "$1" in',
      `  device-start) shift; exec ${q(cli)} device-start --node ${q(node)} "$@" ;;`,
      'esac',
      `exec ${q(cli)} "$@"`,
      '',
    ].join('\n')
  writeFileSync(join(bins.ok, ADAPTER), wrapper(process.execPath), { mode: 0o755 })
  // 起不来：Node 指到一个不存在的文件，device-start 当场以 1 退出并说明原因
  writeFileSync(join(bins.down, ADAPTER), wrapper(join(root, 'no-node')), { mode: 0o755 })
  // 太旧：0.5.1 及更早的命令行对这几条子命令都是这一句，退出码 1
  writeFileSync(
    join(bins.old, ADAPTER),
    ['#!/bin/sh', 'echo "未知命令: $1" >&2', 'exit 1', ''].join('\n'),
    { mode: 0o755 },
  )
  for (const file of Object.values(bins)) chmodSync(join(file, ADAPTER), 0o755)
  // 默认的安装位置：安装脚本就是在 ~/.local/bin 里放一个指向真身的链接
  mkdirSync(join(homes.path, '.local', 'bin'), { recursive: true })
  symlinkSync(join(bins.ok, ADAPTER), join(homes.path, '.local', 'bin', ADAPTER))

  // ---------- 一份“不带聚合面的旧服务” ----------
  // 旧版服务的样子就是：某个 harness 的运行时套接字连得上，而聚合面的套接字和设备锁都没有。
  // device-start 只连一下就断开，所以这里只管接连接
  const legacyRuntime = join(stateOf(homes.legacy), 'pi', 'runtime.sock')
  mkdirSync(dirname(legacyRuntime), { recursive: true, mode: 0o700 })
  const legacy = createSocketServer((socket) => socket.destroy())
  await new Promise((done, fail) => {
    legacy.once('error', fail)
    legacy.listen(legacyRuntime, done)
  })

  /** 一个状态目录上在跑的常驻服务的进程号（它自己记在 service.json 里的）。没有就是 null */
  const servicePid = (home) => {
    try {
      const pid = JSON.parse(
        readFileSync(join(stateOf(home), 'device', 'service.json'), 'utf8'),
      ).pid
      return Number.isInteger(pid) ? pid : null
    } catch {
      return null
    }
  }
  /**
   * 这个进程号上现在是不是这个状态目录的常驻服务。service.json 里的进程号可能是过期的（服务早退了，
   * 号被别的进程用上了），所以按命令行里那段随机生成的临时路径认，认不出来就不碰它
   */
  const ours = (pid, home) => {
    const found = spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    })
    return found.status === 0 && found.stdout.includes(` --home ${stateOf(home)} `)
  }

  /**
   * 收尾：把这几个状态目录上被拉起来的服务停掉，等它们退干净。同步做完（进程退出时也要能用）。
   * 用的是命令行自己的 device-stop：它请服务自己停、等它退出才返回，从不按名字找进程。
   * 没停成的再按服务自己记下的进程号结束（先核对那个号上确实是它）。返回还没退的进程号
   */
  function stop() {
    model.closeAllConnections()
    model.close()
    legacy.close()
    const left = []
    for (const home of [homes.svc, homes.path, down]) {
      const pid = servicePid(home)
      if (pid === null || !ours(pid, home)) continue
      spawnSync(cli, ['device-stop', '--home', stateOf(home)], {
        env: { PATH: pinned.PATH, HOME: home, CHA_LANG: 'zh-CN' },
        stdio: 'ignore',
        timeout: 60_000,
      })
      if (!ours(pid, home)) continue
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // 刚好退了
      }
      spawnSync('/bin/sleep', ['2'])
      if (ours(pid, home)) left.push(pid)
    }
    return left
  }

  return {
    adapter: ADAPTER,
    homes,
    down,
    bins,
    work,
    modelLog,
    /** 各个状态目录，自检拿来看服务起没起、是哪一个进程 */
    states: {
      svc: stateOf(homes.svc),
      path: stateOf(homes.path),
      legacy: stateOf(homes.legacy),
      down: stateOf(down),
    },
    stop,
  }
}
