// 给“应用自带的那份适配器”用的隔离环境：让它在里面只起得来一个隔离的 Pi，别的什么都碰不到。
// 自检（apps/desktop/scripts/check-local.mjs）和真实窗口验收装好的应用时都用它。
// 带 --engines claude,pi,dsh 时另外两个引擎也起得来（各用一份隔离的命令行，模型一样是回环上的假模型），
// 见下面“三个引擎”一段。
//
// 和 client-fixture.mjs、device-fixture.mjs 不一样：这里不起任何引擎，也不起设备进程。
// 那些由自带的适配器自己拉起（device-start → start → 运行时和设备进程），这里只把环境备好：
//   <根>/h        状态目录（LITCH_ADAPTER_HOME），相当于 ~/.codex-harness-adapter
//   <根>/home     假的用户主目录，服务和它跑的命令都以为这是 ~
//   <根>/agent    Pi 的配置目录：只有一个模型，地址是回环上的假模型
//   <根>/sh/zsh   假的登录 shell：应用启动服务之前会问它要环境（apps/desktop/src/login-env.mts）
//   <根>/profile  给应用用的临时用户数据目录（LITCH_PROFILE）
// 回环上的假模型和 client-fixture.mjs 里的是同一种：把收到的那句话带回来，分几段慢慢发；
// 话里带“问我”时向用户提两个问题（client-fixture-ask.mjs）。
// 话里带“跑个命令”时调用 Pi 内置的 bash 跑一条固定的命令（client-fixture-run.mjs）：打开 Pi 的审批之后，界面上能看到命令审批卡片。
// 话里带“浏览”和网址时用桌面的内置浏览器打开（client-fixture-browse.mjs），带“操作应用”时用 Computer Use 看一个应用、打一段字
// （client-fixture-computer.mjs）：真实窗口验收用它们验客户端工具，模型仍是假的。
//
// 隔离靠的是假登录 shell 给出的环境（它盖过应用自己的环境）：
//   PATH 只有夹具自己的空目录和系统目录，里面没有用户装的 claude、pi、dsh；
//   HOME、TMPDIR 指进临时目录；PI_CLI 指到仓库里夹具用的那份 Pi，PI_CODING_AGENT_DIR 指到上面的配置目录；
//   CHA_CLAUDE_CLI 指到一个不存在的路径，CHA_DSH_CLI 是空的：应用自己的环境里就算有这两个变量也被盖掉。
// 引擎找 harness 的命令行只有两条路：这几个变量，或者 PATH（packages/shared/src/host-cli.mts），
// 没有写死的安装位置；Go 的命令行自己不找也不执行任何 harness。所以用户真实的 claude 不会被执行。
// 指路的那几样（CHA_CLAUDE_CLI、CHA_DSH_CLI、PI_CLI、PI_CODING_AGENT_DIR）也写进 <状态目录>/env 兜底：
// 万一登录 shell 没问到，服务拿到的是应用自己的环境，这一份至少让它不去 PATH 里找 claude 和 dsh、用不了真实的 Pi 配置。
// 环境文件排在最后，应用自己的环境里已经有同名变量时它盖不住。所以启动应用或小工具时仍然不要带着个人的环境
// （PATH、模型凭据之类）：登录 shell 里没有的变量，应用自己的会原样带给服务。
//
// 三个引擎（--engines claude,pi,dsh，和 device-fixture.mjs --managed 的那个开关是同一个意思，
// 做法在 client-fixture-engines.mjs 开头）：
//   Claude Code 和 dsh 的命令行用 CHA_CLAUDE_CLI、CHA_DSH_CLI 给（给这个脚本，不是给应用），要了没给就报错退出；
//   它们的命令行路径、模型地址、配置目录预先写进 <状态目录>/device/settings.json，是各自 harness 的设置，
//   排在登录 shell 给的环境前面，所以上面那两个“指到不存在的路径”的变量挡不住它们，别的隔离照旧；
//   Claude Code 的配置目录在 <根>/claude、临时文件在 <根>/ct，dsh 共用技能的目录在 <根>/agents，
//   它自己的配置目录由适配器定在 <状态目录>/dsh/dsh-home：都不出临时目录，不读 ~/.claude、~/.dsh、~/.agents；
//   <根>/work/tri 是给三家共用的工作目录（一个 git 仓库，里面给三家各放了一份技能 fixture-notes）；
//   macOS 上就绪行里给的是它和真实路径不一样的那种写法（/tmp/…，真实的是 /private/tmp/…，见 spelledApart）；
//   假模型对三家认同一套词（client-fixture-anthropic.mjs 开头有全表），Pi 的回话这时开头带“pi 收到：”；
//   Pi 的审批（设置 harness.pi.approvals）这时是打开的：三家跑命令都会先来问。
//   就绪行里多一项 engines：{ ids, cwd, skill }。启动应用要带的环境变量还是 env 里那几个，一个不多。
//
// 用法：node scripts/client-local-fixture.mjs [--adapter 目录 | --packed] [--pace 毫秒] [--engines claude,pi,dsh]
//   --adapter 目录   自带的适配器在哪（一份暂存好的目录）。不给就看环境变量 LITCH_ADAPTER_ROOT，
//                    再不然用 apps/desktop/out/adapter（npm run client:stage:adapter 的产物）
//   --packed         给装好的应用用：就绪行里不带 LITCH_ADAPTER_ROOT，应用用它自己带的那一份
//   --pace 毫秒      假模型每发一段停多久，默认 200
//   就绪后输出一行 LITCH_LOCAL_FIXTURE {"env": {…}, …}，env 里是启动应用或小工具要带的全部环境变量；
//   然后一直运行到被结束。退出时把这个状态目录上的常驻服务停掉、等它退干净、删掉临时目录。
//
// 交给装好的应用（把 env 里的每一项原样带上）：
//   open -n -a <Litch.app> --env LITCH_ADAPTER_HOME=… --env LITCH_PROFILE=… --env SHELL=…
//
// Windows 上没有登录 shell 可问（应用不问，服务拿到的就是应用自己的环境），所以不写假 shell，
// 就绪行里的 env 直接是启动应用要用的整个环境（envComplete 是 true），不能并到自己的环境上，要整个换掉：
//   PATH 只有夹具自己的空目录、系统目录（System32、Windows、Wbem、Windows PowerShell、OpenSSH）、
//   跑夹具的这份 Node 所在的目录、Git 的 cmd 目录（找得到的话）；
//   HOME、USERPROFILE（连同 HOMEDRIVE、HOMEPATH）、TEMP、TMP、APPDATA、LOCALAPPDATA 指进临时目录；
//   系统的那几个（SystemRoot、ComSpec、PATHEXT、ProgramFiles 之类，见 WINDOWS_PASSED）照这台机器的原样带上，
//   别的一个不带。Claude Code 的 Bash 要的 Git Bash 经它自己的设置 CLAUDE_CODE_GIT_BASH_PATH 给，不进 PATH。
// 结束时用适配器自己的 device-stop --home <状态目录> 停服务（不按进程号发信号），再按命令行里有没有这个状态目录
// 查一遍剩下的进程，有就强行结束并报错。--packed 时适配器取装好的应用里的那一份：
//   --app <Litch.exe>   装好的应用在哪，默认 %LOCALAPPDATA%\Programs\Litch\Litch.exe（安装程序的默认位置）
//   --launch            就绪后用 env 起这个应用（-- 之后的参数原样交给它，比如 --remote-debugging-port=9222）；
//                       结束夹具时先把它连同子进程一起结束。只在 Windows 上用，macOS 照旧用 open
// 结束夹具：控制台里 Ctrl+C；从别处（ssh、计划任务）起的，请求一次就绪行里的 stopUrl（回环上，比如 curl -X POST）。
//
// 工作区里 Go 层或设备进程正被改到一半、暂存不出来时，用已提交版本的导出副本来暂存（不建 worktree、不切分支）：
//   git archive HEAD cmd internal sshserver go.mod go.sum package.json packages/protocol/identity.go \
//     packages/protocol/src/harness-identity.json protocol/versions.go protocol/versions.json | tar -x -C <临时目录>
//   （后四个是 Go 编进命令行的数据：harness 的名字和徽标、验证过的版本）
//   npm run stage:adapter --prefix apps/desktop -- --go-from <临时目录>
// 设备进程同理：导出 packages/device、packages/shared、packages/protocol、tsconfig.json、package.json，
// 把根目录的 node_modules 用符号链接接过去，在副本里 tsc -p packages/device，再加 --device-from <副本>/packages/device。
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveAnthropic } from './client-fixture-anthropic.mjs'
import { askReply, installAskExtension } from './client-fixture-ask.mjs'
import { browseReply } from './client-fixture-browse.mjs'
import { computerReply } from './client-fixture-computer.mjs'
import { lastUserText } from './client-fixture-echo.mjs'
import {
  engineIds,
  gitForWindows,
  prepareWorkDirectory,
  refuseHarnessOnPath,
  spelledApart,
  wantedEngines,
  writeEngineSettings,
} from './client-fixture-engines.mjs'
import { FIXTURE_SKILL, piReply, sendCompletion } from './client-fixture-marks.mjs'
import { codexSocketCleanup, serveResponses } from './client-fixture-responses.mjs'
import { runReply } from './client-fixture-run.mjs'
import { sessionsReply } from './client-fixture-sessions.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const option = (name) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? process.argv[at + 1] : undefined
}
const packed = process.argv.includes('--packed')
const WINDOWS = process.platform === 'win32'
/** Windows 上的可执行文件带 .exe */
const EXE = WINDOWS ? '.exe' : ''
const launch = process.argv.includes('--launch')
/** -- 之后的参数：--launch 时原样交给应用 */
const appArgs = process.argv.includes('--')
  ? process.argv.slice(process.argv.indexOf('--') + 1)
  : []
if (launch && !WINDOWS) {
  console.error('--launch 只在 Windows 上用；macOS 上照旧用 open -n -a 把 env 带给应用')
  process.exit(1)
}
const pace = Number(option('--pace') ?? 200)
/** 带 --engines 时除了 Pi 还要起哪几个引擎（各自隔离的命令行）。没带就都是 null */
const engines = wantedEngines()
const threeEngines = process.argv.includes('--engines')

// 和 client-fixture.mjs 用的是同一份 Pi：仓库里 packages/pi 的开发依赖，不是用户装的那一份
const piPackage = join(repo, 'packages/pi/node_modules/@earendil-works/pi-coding-agent')
if (!existsSync(join(piPackage, 'package.json'))) {
  console.error('没有找到夹具用的 Pi，请先运行 npm ci --prefix packages/pi')
  process.exit(1)
}
const piEntry = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).main
const piCli = join(piPackage, dirname(piEntry), 'cli.js')

/** 自带的适配器在哪。--packed 时不给：装好的应用自己知道 */
const stagedAdapter = join(repo, 'apps/desktop/out/adapter')
const adapterRoot = packed
  ? null
  : resolve(option('--adapter') ?? process.env.LITCH_ADAPTER_ROOT ?? stagedAdapter)
if (adapterRoot && !existsSync(join(adapterRoot, 'bin', `codex-harness-adapter${EXE}`))) {
  console.error(
    `${adapterRoot} 里没有适配器。先运行 npm run client:stage:adapter，或用 --adapter 指到一份暂存好的目录`,
  )
  process.exit(1)
}
/** Windows 上装好的应用（--app，默认是安装程序装到的位置）。停服务用它带着的适配器，--launch 时起的是它 */
const app = WINDOWS
  ? resolve(
      option('--app') ??
        join(
          process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
          'Programs',
          'Litch',
          'Litch.exe',
        ),
    )
  : null
/** Windows 上停服务用的命令行：暂存的那一份，或者装好的应用里的那一份 */
const adapterBin = WINDOWS
  ? adapterRoot
    ? join(adapterRoot, 'bin', 'codex-harness-adapter.exe')
    : join(dirname(app), 'resources', 'adapter', 'bin', 'codex-harness-adapter.exe')
  : null
if (WINDOWS && (packed || launch) && !existsSync(packed ? adapterBin : app)) {
  console.error(`${packed ? adapterBin : app} 不在：装好 Litch，或用 --app 指到装好的 Litch.exe`)
  process.exit(1)
}

/**
 * 交给服务的 PATH 里除了夹具自己的空目录还有哪些：假登录 shell 给的系统目录；
 * Windows 上是系统目录加上跑夹具的这份 Node 和 Git（命令行、钩子、Git Bash 都要它们）
 */
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const SYSTEM_PATH = WINDOWS
  ? [
      join(systemRoot, 'System32'),
      systemRoot,
      join(systemRoot, 'System32', 'Wbem'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      join(systemRoot, 'System32', 'OpenSSH'),
      dirname(process.execPath),
      ...(gitForWindows() ? [gitForWindows().dir] : []),
    ]
  : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
// 隔离靠的就是“这几个目录里找不到 harness”（原生 codex、OpenCode 装了就默认启用，经 ACP 接的 agent 一样）。
// 找得到的话不能往下走
refuseHarnessOnPath(SYSTEM_PATH)

// 状态目录的名字里特意带一个空格和一个汉字：用户的主目录可能就是这样（带空格的全名、中文的用户名），
// 状态目录默认在它下面，这条链路上每一段（命令行、设备进程、引擎、客户端）都得受得了
const STATE_NAME = 'h 检'
// 套接字路径有长度上限（macOS 104 字节，命令行卡在 100）：最长的一条是 <根>/<状态目录>/claude-code/runtime.sock。
// 系统给的临时目录太长就退到 /tmp。Windows 上（上限 108 字节）没有可退的地方；系统给的可能是 8.3 短名
// （C:\\Users\\ADMINI~1\\…），换成长名，免得服务报的路径和这里的对不上
const longestSocket = (base) =>
  Buffer.byteLength(join(base, 'll-XXXXXX', STATE_NAME, 'claude-code', 'runtime.sock'))
const base = (WINDOWS ? [realpathSync.native(tmpdir())] : [tmpdir(), '/tmp']).find(
  (directory) => longestSocket(directory) <= 96,
)
if (!base) {
  console.error('找不到路径够短的临时目录，套接字建不出来')
  process.exit(1)
}
const root = mkdtempSync(join(base, 'll-'))
const home = join(root, STATE_NAME)
const dirs = {
  userHome: join(root, 'home'),
  agent: join(root, 'agent'),
  bin: join(root, 'bin'),
  shell: join(root, 'sh'),
  temp: join(root, 'tmp'),
  profile: join(root, 'profile'),
  app: join(root, 'work/app'),
  ...(threeEngines ? { tri: join(root, 'work/tri') } : {}),
  // Windows 上的 APPDATA、LOCALAPPDATA
  ...(WINDOWS
    ? { roaming: join(root, 'appdata', 'Roaming'), local: join(root, 'appdata', 'Local') }
    : {}),
}
for (const directory of [home, ...Object.values(dirs)]) mkdirSync(directory, { recursive: true })
chmodSync(home, 0o700)

// ---------- 假模型 ----------
// 每收到一次模型请求记一行，自检据此确认请求真的到了这里
const modelLog = join(root, 'model.jsonl')
let requests = 0
const model = createServer(async (req, res) => {
  // 就绪行里的 stopUrl：结束夹具
  if (req.url === '/fixture/stop') {
    res.end('stopping\n')
    void cleanup(0)
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  const [, id, ...rest] = (req.url ?? '').split('/')
  // Claude Code 和 dsh 的模型地址带着各自的标识，说的是另一种形态，怎么答在 client-fixture-anthropic.mjs
  if (id === 'claude-code' || id === 'dsh') {
    appendFileSync(modelLog, `${JSON.stringify({ at: Date.now(), harness: id })}\n`)
    await serveAnthropic(id, `/${rest.join('/')}`, raw, res, pace)
    return
  }
  // 原生 codex 说的是 Responses 形态（client-fixture-responses.mjs），只会把话带回来
  if (id === 'codex') {
    appendFileSync(modelLog, `${JSON.stringify({ at: Date.now(), harness: id })}\n`)
    await serveResponses(id, `/${rest.join('/')}`, raw, res, { serial: ++requests, pace })
    return
  }
  const body = JSON.parse(raw.toString() || '{}')
  requests++
  const said = lastUserText(body)
  appendFileSync(modelLog, `${JSON.stringify({ at: Date.now(), model: body.model, said })}\n`)
  // 三个引擎都在的时候 Pi 和另两家认同一套词（client-fixture-marks.mjs）；平时只认“跑个命令”和“问我”。
  // OpenCode（还有接 opencode acp 的 acp 入口）也说 OpenAI 兼容的这一种，地址带着它的标识（/opencode/v1、/acp/v1），
  // 回话开头写它自己的名字
  // 会话树（litch_sessions 和设备注入的唤醒）的那几句两种模式都认，见 client-fixture-sessions.mjs
  const reply =
    sessionsReply(body, said) ??
    (threeEngines
      ? piReply(id === 'opencode' || id === 'acp' ? id : 'pi', body, pace)
      : (runReply(body, said) ??
        browseReply(body, said) ??
        computerReply(body, said) ??
        askReply(body, said) ?? {
          text: `收到：${said}\n\n这是隔离环境里的假模型在回话，分成几段慢慢发，好让界面上看得到字是一点一点出来的。`,
          pace,
        }))
  await sendCompletion(res, reply, { serial: requests, model: body.model })
})
// 不监听固定端口：让系统分配
await new Promise((done) => model.listen(0, '127.0.0.1', done))
const modelOrigin = `http://127.0.0.1:${model.address().port}`
const modelUrl = `${modelOrigin}/v1`

writeFileSync(
  join(dirs.agent, 'models.json'),
  JSON.stringify({
    providers: {
      gate: {
        baseUrl: modelUrl,
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
  join(dirs.agent, 'settings.json'),
  JSON.stringify({ defaultProvider: 'gate', defaultModel: 'gate', retry: { enabled: false } }),
)
installAskExtension(dirs.agent)
if (threeEngines) {
  // 服务一起来就照着设置起各个引擎，所以设置要在应用启动之前写好
  writeEngineSettings({ home, root, modelUrl: modelOrigin, engines })
  prepareWorkDirectory(dirs.tri, engines)
}

// ---------- 假的登录 shell 和环境文件 ----------
/** 服务该拿到的 PATH：夹具自己的目录（空的）加系统目录 */
const loginPath = [dirs.bin, ...SYSTEM_PATH].join(delimiter)
/**
 * 只有假登录 shell 会导出的记号：服务的环境里有它，才说明登录 shell 的结果真的交到了。
 * Windows 上它在就绪行的 env 里，说明的是服务拿到的确实是那一份环境
 */
const mark = { name: 'LOCAL_FIXTURE_LOGIN', value: basename(root) }
/** 环境文件里也写一份的那几样，见开头 */
const pinned = {
  // 故意指到一个不存在的文件：有这个变量，引擎就不去 PATH 里找 claude，claude-code 这个入口报“没装”
  CHA_CLAUDE_CLI: join(dirs.bin, 'claude'),
  // 同样不存在。只在登录 shell 没问到时起作用：dsh 这个入口会被带上，但只报“没装”，不去 PATH 里找
  CHA_DSH_CLI: join(dirs.bin, 'dsh'),
  // 同样不存在。OpenCode 除了 PATH 还会找 ~/.opencode/bin/opencode：登录 shell 没问到时主目录是真的那个，
  // 有这个变量它才不去那里找，只报“没装”
  CHA_OPENCODE_CLI: join(dirs.bin, 'opencode'),
  // 经 ACP 接的几个默认不启用，也指到不存在的路径，万一被打开了也找不到用户自己的
  CHA_GEMINI_CLI: join(dirs.bin, 'gemini'),
  CHA_QWEN_CLI: join(dirs.bin, 'qwen'),
  CHA_ACP_CLI: join(dirs.bin, 'acp'),
  PI_CLI: piCli,
  PI_CODING_AGENT_DIR: dirs.agent,
}
const isolated = {
  PATH: loginPath,
  HOME: dirs.userHome,
  TMPDIR: dirs.temp,
  ...pinned,
  // 空的：命令行据此认为没装 dsh（它只认非空的值，再不然去 PATH 里找），不起这个入口
  CHA_DSH_CLI: '',
  // OpenCode 也一样：PATH 里没有，主目录是假的，~/.opencode/bin 里也没有
  CHA_OPENCODE_CLI: '',
  CHA_GEMINI_CLI: '',
  CHA_QWEN_CLI: '',
  CHA_ACP_CLI: '',
  [mark.name]: mark.value,
  // Windows 上程序找主目录、临时目录、应用数据看的是这几个
  ...(WINDOWS
    ? {
        USERPROFILE: dirs.userHome,
        HOMEDRIVE: parse(dirs.userHome).root.replace(/\\$/, ''),
        HOMEPATH: dirs.userHome.slice(parse(dirs.userHome).root.length - 1),
        TEMP: dirs.temp,
        TMP: dirs.temp,
        APPDATA: dirs.roaming,
        LOCALAPPDATA: dirs.local,
      }
    : {}),
}
/**
 * Windows 上照这台机器的原样带给应用的系统变量：少了它们有的程序起不来（SystemRoot、ComSpec），
 * 有的找不到东西（PATHEXT、ProgramFiles：Pi 和 dsh 按它找 Git Bash、PowerShell 7）。别的一个不带
 */
const WINDOWS_PASSED = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'NUMBER_OF_PROCESSORS',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ProgramData',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'COMPUTERNAME',
  'USERNAME',
  'USERDOMAIN',
]
/** Windows 上启动应用要用的整个环境（不带 LITCH_ 那几个，见下面的 ready） */
const windowsEnv = WINDOWS
  ? {
      ...Object.fromEntries(
        WINDOWS_PASSED.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
      ),
      ...isolated,
    }
  : null
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`
// 名字得是 login-env.mts 认得的（zsh），内容是我们自己写的：不读这台机器上任何真的 shell 配置。
// 服务之后会把 SHELL 当成用户的 shell 用，所以别的调用方式也接得住：一律换成带着这份环境的 /bin/sh。
// Windows 上不写（应用不问登录 shell）
const shell = WINDOWS ? null : join(dirs.shell, 'zsh')
if (shell) {
  writeFileSync(
    shell,
    [
      '#!/bin/sh',
      '# 由 scripts/client-local-fixture.mjs 写出，只给隔离环境用',
      ...Object.entries(isolated).map(([name, value]) => `${name}=${quote(value)}; export ${name}`),
      'if [ "$1" = "-ilc" ]; then exec /bin/sh -c "$2"; fi',
      'exec /bin/sh "$@"',
      '',
    ].join('\n'),
  )
  chmodSync(shell, 0o755)
}
writeFileSync(
  join(home, 'env'),
  `# 由 scripts/client-local-fixture.mjs 写出\n${Object.entries(pinned)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`,
  { mode: 0o600 },
)

// ---------- 收尾 ----------
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const signal = (pid, name) => {
  try {
    process.kill(pid, name)
  } catch {
    // 已经不在了
  }
}
/**
 * 这个状态目录上的进程：常驻的 start（命令行里有 --home <状态目录>）、它起的运行时和设备进程
 * （监听的套接字在状态目录里）。认的是这次随机生成的临时路径，不是程序的名字，碰不到别的服务
 */
function serviceProcesses() {
  if (WINDOWS) return windowsServiceProcesses()
  // 给 ps 一个 UTF-8 的区域设置：不给的话命令行里的汉字会被它写成转义，下面按状态目录的路径就认不出来了
  const output = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
  })
  return output
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match && match[1] !== String(process.pid))
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    .filter(
      ({ command }) => command.includes(`--home ${home} `) || command.includes(`unix://${home}/`),
    )
}
const waitGone = async (pids, ms) => {
  for (let waited = 0; waited < ms && pids.some(alive); waited += 50) await sleep(50)
  return pids.filter(alive)
}
/**
 * Windows 上的全部进程：进程号、父进程号、命令行。PowerShell 的输出按 UTF-8 写（不然状态目录名里的汉字会变成问号），
 * 脚本经 -EncodedCommand 传，不经过任何一层引号；它的进度条写在标准错误里（CLIXML），不要
 */
function windowsProcesses() {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$ProgressPreference = 'SilentlyContinue'",
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
  ].join('\n')
  const output = execFileSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  return output
    .split(/\r?\n/)
    .map((line) => /^(\d+)\t(\d+)\t(.*)$/.exec(line))
    .filter((match) => match && match[1] !== String(process.pid))
    .map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }))
}
/**
 * Windows 上属于这个夹具的进程：命令行里有临时目录的（device-start、start 带着 --home <状态目录>，
 * --launch 起的应用的子进程带着 <根>/profile），加上它们起的子孙。运行时经命名管道监听，命令行里没有状态目录，
 * 只能按父子关系认
 */
function windowsServiceProcesses() {
  const all = windowsProcesses()
  const found = new Map(
    all.filter(({ command }) => command.includes(root)).map((entry) => [entry.pid, entry]),
  )
  for (let grew = true; grew; ) {
    grew = false
    for (const entry of all) {
      if (found.has(entry.pid) || !found.has(entry.parent)) continue
      found.set(entry.pid, entry)
      grew = true
    }
  }
  return [...found.values()]
}
/** Windows 上强行结束一个进程；tree 时连同它起的子进程 */
const kill = (pid, tree = false) =>
  spawnSync(
    join(systemRoot, 'System32', 'taskkill.exe'),
    ['/F', ...(tree ? ['/T'] : []), '/PID', String(pid)],
    { stdio: 'ignore', windowsHide: true },
  )
/**
 * Windows 上请服务自己停：适配器的 device-stop --home（经控制通道请它停，等它退出，没在运行也算成功）。
 * 还剩的进程（它没收干净）连同子进程强行结束。返回这个状态目录上原来有的进程号
 */
async function stopWindowsService() {
  const pids = serviceProcesses().map((entry) => entry.pid)
  const done = spawnSync(adapterBin, ['device-stop', '--home', home], {
    env: windowsEnv,
    encoding: 'utf8',
    timeout: 100_000,
    windowsHide: true,
  })
  if (done.status !== 0) {
    console.error(
      `device-stop 没停成（退出码 ${done.status ?? done.error}）：${(done.stderr || done.stdout || '').trim()}`,
    )
  }
  // 被结束的应用剩下的子进程（渲染、GPU 那几个）自己会退，等一会儿再看
  let left = serviceProcesses()
  for (let waited = 0; waited < 5000 && left.length > 0; waited += 500) {
    await sleep(500)
    left = serviceProcesses()
  }
  for (const { pid } of left) kill(pid, true)
  if (left.length > 0) await sleep(1000)
  return pids
}
/** 把这个状态目录上的服务停掉，等它退干净。返回停掉的进程号 */
async function stopService() {
  if (WINDOWS) return stopWindowsService()
  const found = serviceProcesses()
  if (found.length === 0) return []
  const pids = found.map((entry) => entry.pid)
  // 先请常驻的那个进程自己收：它会按次序停掉运行时和设备进程。进程号以它自己报的为准
  let main = null
  try {
    main = JSON.parse(readFileSync(join(home, 'device', 'service.json'), 'utf8')).pid
  } catch {
    // 没有这份状况（服务还没写，或者已经在退了）
  }
  let left = pids
  if (pids.includes(main)) {
    signal(main, 'SIGTERM')
    left = await waitGone(pids, 15_000)
  }
  // 还在的（没有主进程可请，或者它没收干净）逐个结束，按进程号
  for (const pid of left) signal(pid, 'SIGTERM')
  left = await waitGone(left, 3000)
  for (const pid of left) signal(pid, 'SIGKILL')
  await waitGone(left, 2000)
  return pids
}

/** --launch 起的应用 */
let launched = null
let cleaning = false
async function cleanup(code) {
  if (cleaning) return
  cleaning = true
  // 原生 codex 在 /tmp/codex-daemon-<uid>/ 下留的套接字和锁：趁它还在跑先认下来，服务停了再删
  const removeCodexSocket = codexSocketCleanup(join(home, 'codex', 'runtime.sock'))
  // --launch 起的应用先结束，免得它见服务停了又拉起来。只结束它自己：服务（device-start 和它起的）
  // 在 Windows 上是它的子孙，连着一起强杀就不是平稳停下了，下面由 device-stop 来停
  if (launched && launched.exitCode === null) {
    kill(launched.pid)
    console.error(`已结束起的应用（进程号 ${launched.pid}）`)
  }
  try {
    const stopped = await stopService()
    if (stopped.length > 0)
      console.error(`已停掉这个状态目录上的服务（进程号 ${stopped.join('、')}）`)
    const left = serviceProcesses()
    if (left.length > 0) {
      console.error(
        `还有进程没退：\n${left.map((entry) => `  ${entry.pid} ${entry.command}`).join('\n')}`,
      )
      code ||= 1
    }
  } catch (error) {
    console.error(`停服务时出错：${error?.stack ?? error}`)
    code ||= 1
  }
  model.closeAllConnections()
  model.close()
  removeCodexSocket()
  rmSync(root, { recursive: true, force: true })
  process.exit(code)
}
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(WINDOWS ? ['SIGBREAK'] : [])])
  process.on(name, () => void cleanup(0))

const ready = {
  /** 启动应用或小工具要带的全部环境变量。Windows 上是整个环境（envComplete），别的系统上是要并进去的那几个 */
  env: {
    ...windowsEnv,
    ...(adapterRoot ? { LITCH_ADAPTER_ROOT: adapterRoot } : {}),
    LITCH_ADAPTER_HOME: home,
    LITCH_PROFILE: dirs.profile,
    ...(shell ? { SHELL: shell } : {}),
  },
  envComplete: WINDOWS,
  /** 请求一次就结束夹具（停服务、清理），给从 ssh、计划任务里起的、按不了 Ctrl+C 的时候用 */
  stopUrl: `${modelOrigin}/fixture/stop`,
  root,
  home,
  /** 聚合面会在哪。连哪里仍以 device-start 报的为准，这里只是给人看 */
  socket: join(home, 'device', 'device.sock'),
  /** 唯一起得来的 harness，和在它上面新建会话时用的模型、工作目录 */
  harness: 'pi',
  model: 'gate/gate',
  cwd: dirs.app,
  /**
   * 假登录 shell（Windows 上是 env 本身）交给服务的 PATH、主目录和记号，还有 claude 被指到的那个不存在的路径，
   * 自检拿来对
   */
  login: { path: loginPath, home: dirs.userHome, mark, claude: pinned.CHA_CLAUDE_CLI },
  modelUrl,
  modelLog,
  // 带 --engines 时才有：起得来哪几个 harness、三个引擎各走一遍用的工作目录、里面那项技能的名字和正文里的记号
  ...(threeEngines
    ? { engines: { ids: engineIds(engines), cwd: spelledApart(dirs.tri), skill: FIXTURE_SKILL } }
    : {}),
}
console.log(`LITCH_LOCAL_FIXTURE ${JSON.stringify(ready)}`)
if (launch) {
  // 整个环境换成 env：Windows 上应用不问登录 shell，它自己的环境就是服务的环境
  launched = spawn(app, appArgs, { env: ready.env, detached: true, stdio: 'ignore' })
  launched.on('error', (error) => console.error(`起应用失败：${error.message}`))
  console.log(`已起应用 ${app}（进程号 ${launched.pid}）`)
}
console.log('隔离环境已就绪，按 Ctrl+C 结束：会停掉这个状态目录上的服务并清理。')
