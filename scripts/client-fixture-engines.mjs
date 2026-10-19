// 三引擎的隔离环境：让由适配器主进程管着的那份设备服务除了 Pi，把 Claude Code 和 DeepSeek Harness（dsh）
// 也起来，模型请求一样打到回环上的假模型。device-fixture.mjs --managed 和 client-local-fixture.mjs 共用这一份。
//
// 开关是 --engines claude,pi,dsh（Pi 一直在，写不写都起）。要哪个引擎就得给它一份隔离的命令行：
//   CHA_CLAUDE_CLI     隔离的 Claude Code（流水线上是装到 .artifacts/host-cli 的那一份）
//   CHA_DSH_CLI        隔离的 dsh（流水线上是装到 .artifacts/host-dsh 的那一份）
//   CHA_OPENCODE_CLI   隔离的 opencode（--engines 里写了 opencode 才要；三引擎验收还不带它）
//   CHA_ACP_CLI        --engines 里写了 acp 才要：自填命令的 ACP 入口（标识 acp）要接的 agent。夹具只会给
//                      OpenCode 配模型，所以这里只认 opencode（参数取 CHA_ACP_ARGS，没给就是 acp，即 opencode acp）
//   CHA_CODEX_CLI      --engines 里写了 codex 才要：隔离的原生 codex（流水线上可以是 npm 装的精确版本
//                      @openai/codex@0.160.0 的 bin/codex.js）。数据目录 CODEX_HOME 在夹具里，模型是回环上的假接口
//                      （Responses 形态，client-fixture-responses.mjs），不碰 ~/.codex。没要时在设置里明写停用
// 没要的新 harness（OpenCode，经 ACP 接的 Gemini CLI、Qwen Code、acp）在设置里明写停用，免得哪一层漏了隔离时
// 它们去找用户自己装的那一份。
// 要了却没给、给的不是可执行文件：报错退出，不悄悄少起一个。没要的照旧报“没装”。
// 不从 PATH 里找：PATH 里的是这台机器的主人自己在用的那一份。
//
// 这两个引擎的配置经 <状态目录>/device/settings.json 交给主进程（命令行路径、环境变量各是该 harness 自己的
// 一项设置），不放进主进程的环境：放进去的话三个引擎都拿得到，Pi 见到模型的密钥变量会多列出一批模型。
// 所以在设备详情里看得到这几项，那是夹具写的。
//
// 隔离（主目录、临时目录由起主进程的一方指进夹具的临时目录，PATH 里没有用户装的任何 harness）：
//   Claude Code   配置目录 CLAUDE_CONFIG_DIR 在夹具里，主目录也是夹具里的空目录：不读 ~/.claude 和 ~/.claude.json，
//                 用户配的 MCP 服务、技能、设置、登录凭据都够不着；凭据是一个假的密钥，模型地址是回环；
//                 自动更新、遥测、报错上报和别的非必要的联网都关着；
//                 它自己的临时文件（贴进来的图片、后台任务的输出）默认写在 /tmp/claude-<用户号>/ 下面，
//                 那是这台机器上所有 Claude Code 共用的地方：用 CLAUDE_CODE_TMPDIR 也指进夹具
//   dsh           自己的配置目录（DSH_HOME）本来就由适配器定在状态目录下面，不用 ~/.dsh；
//                 共用技能的目录 DSH_AGENTS_HOME 指进夹具，不读 ~/.agents；凭据是假的，模型地址是回环
//   状态目录      三个引擎的都在 <状态目录>/<标识>/ 下，是适配器自己定死的
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { FIXTURE_SKILL, skillFile } from './client-fixture-marks.mjs'
import { codexConfig } from './client-fixture-responses.mjs'

/** 开关里的名字 → harness 的标识、给它命令行的环境变量 */
export const ENGINES = {
  claude: { id: 'claude-code', variable: 'CHA_CLAUDE_CLI', name: 'Claude Code' },
  dsh: { id: 'dsh', variable: 'CHA_DSH_CLI', name: 'DeepSeek Harness' },
  opencode: { id: 'opencode', variable: 'CHA_OPENCODE_CLI', name: 'OpenCode' },
  acp: { id: 'acp', variable: 'CHA_ACP_CLI', name: 'ACP（opencode acp）' },
  codex: { id: 'codex', variable: 'CHA_CODEX_CLI', name: 'Codex' },
}

/** 经 ACP 接的几个 harness：夹具不起 gemini、qwen（要真的 agent、会花钱），一律在设置里停用；acp 要了才开 */
const ACP_HARNESSES = ['gemini', 'qwen', 'acp']

/** 回环上连不通的地址：npm 源和代理都指到这里，OpenCode 想往外连（装插件包之类）一律连不出去 */
const DEAD_END = 'http://127.0.0.1:9'

const WINDOWS = process.platform === 'win32'
/** Windows 上按名字找命令时会试的后缀（PATHEXT 里常见的那几个，加上 PowerShell 认的 .ps1 和不带后缀的） */
const WINDOWS_SUFFIXES = ['', '.exe', '.cmd', '.bat', '.com', '.ps1']

/**
 * 读开关。返回要起的那几个引擎的命令行：{ claude: 路径或 null, dsh: 路径或 null }。
 * 没带开关时两个都是 null，夹具照旧只有 Pi。说不通的地方报错退出
 */
export function wantedEngines(argv = process.argv, env = process.env) {
  const at = argv.indexOf('--engines')
  const wanted = { claude: null, dsh: null, opencode: null, acp: null, codex: null }
  if (at < 0) return wanted
  const names = (argv[at + 1] ?? '').split(',').filter(Boolean)
  const unknown = names.filter((name) => name !== 'pi' && !ENGINES[name])
  if (names.length === 0 || unknown.length > 0) {
    console.error(
      `--engines 后面写要起的引擎，用逗号隔开（claude、pi、dsh、opencode、acp、codex）${unknown.join(' ')}`,
    )
    process.exit(1)
  }
  for (const name of names.filter((entry) => entry !== 'pi')) {
    const { variable, name: title } = ENGINES[name]
    const cli = env[variable]?.trim()
    if (!cli) {
      console.error(`要起 ${title}，得用 ${variable} 给一份隔离的命令行（不会去 PATH 里找）`)
      process.exit(1)
    }
    try {
      accessSync(cli, constants.X_OK)
    } catch {
      console.error(`${variable} 指的不是一个可执行的文件：${cli}`)
      process.exit(1)
    }
    // Windows 上是 opencode.exe
    if (name === 'acp' && basename(cli).replace(/\.exe$/i, '') !== 'opencode') {
      // 别的 agent 的模型和配置目录夹具不会配，起起来就可能去用这台机器上的真凭据
      console.error(`${variable} 只能指一份 opencode（夹具只会给 OpenCode 配假模型）：${cli}`)
      process.exit(1)
    }
    wanted[name] = cli
  }
  return wanted
}

/** 起了哪几个 harness，按界面上排的顺序 */
export const engineIds = (engines) => [
  ...(engines.claude ? ['claude-code'] : []),
  'pi',
  ...(engines.dsh ? ['dsh'] : []),
  ...(engines.opencode ? ['opencode'] : []),
  ...(engines.acp ? ['acp'] : []),
  ...(engines.codex ? ['codex'] : []),
]

const plain = (name, value) => ({ name, value })
const secret = (name, value) => ({ name, value, secret: true })

/**
 * 给一份 OpenCode（opencode serve 或 opencode acp）的隔离环境：配置、数据、缓存、状态都按 XDG 找，全指进 dir，
 * 不碰 ~/.config/opencode、~/.local/share/opencode。模型走回环上的假模型（OpenAI 兼容的那一种，和 Pi 同一路，
 * baseURL 里带着 harness 的标识，假模型据此知道请求是谁发来的），配置整份经 OPENCODE_CONFIG_CONTENT 给。
 * 命令和改文件都调到“问”，和另外几家一样在会来问的那一档上（OpenCode 默认不问）。
 * OpenCode 起来时会在配置目录里装插件包（npm），联网拉模型清单、分享：源和代理都指到连不通的回环端口，一律连不出去
 */
function opencodeEnv(dir, baseURL) {
  for (const name of ['config', 'data', 'cache', 'state'])
    mkdirSync(join(dir, name), { recursive: true })
  return [
    plain('XDG_CONFIG_HOME', join(dir, 'config')),
    plain('XDG_DATA_HOME', join(dir, 'data')),
    plain('XDG_CACHE_HOME', join(dir, 'cache')),
    plain('XDG_STATE_HOME', join(dir, 'state')),
    plain('OPENCODE_DISABLE_AUTOUPDATE', '1'),
    plain('OPENCODE_DISABLE_MODELS_FETCH', '1'),
    plain('OPENCODE_DISABLE_LSP_DOWNLOAD', '1'),
    plain('OPENCODE_DISABLE_SHARE', '1'),
    plain('OPENCODE_DISABLE_DEFAULT_PLUGINS', '1'),
    plain('npm_config_registry', `${DEAD_END}/`),
    ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(
      (name) => plain(name, DEAD_END),
    ),
    plain('NO_PROXY', '127.0.0.1,localhost'),
    plain('no_proxy', '127.0.0.1,localhost'),
    plain(
      'OPENCODE_CONFIG_CONTENT',
      JSON.stringify({
        autoupdate: false,
        share: 'disabled',
        model: 'fixture/gate',
        small_model: 'fixture/gate',
        permission: { bash: 'ask', edit: 'ask' },
        provider: {
          fixture: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Fixture',
            options: { baseURL, apiKey: 'fixture-only' },
            models: { gate: { name: 'Gate', tool_call: true } },
          },
        },
      }),
    ),
  ]
}

/**
 * 把这两个引擎的配置写进设置文件（主进程起来之前写，它一起来就照着起）。
 * modelUrl 是假模型的地址（不带路径），root 是夹具的临时目录。Pi 的审批顺手打开：三家都调到“会问”
 */
export function writeEngineSettings({ home, root, modelUrl, engines }) {
  const values = {
    'harness.pi.approvals': true,
    'harness.opencode.enabled': Boolean(engines.opencode),
    'harness.codex.enabled': Boolean(engines.codex),
  }
  for (const id of ACP_HARNESSES)
    values[`harness.${id}.enabled`] = id === 'acp' && Boolean(engines.acp)
  if (engines.claude) {
    values['harness.claude-code.cliPath'] = engines.claude
    values['harness.claude-code.env'] = [
      // 地址里带着 harness 的标识，假模型据此知道请求是谁发来的
      plain('ANTHROPIC_BASE_URL', `${modelUrl}/claude-code`),
      secret('ANTHROPIC_API_KEY', 'fixture-only'),
      plain('CLAUDE_CONFIG_DIR', join(root, 'claude')),
      // 名字短：它在这下面建套接字，路径有长度上限
      plain('CLAUDE_CODE_TMPDIR', join(root, 'ct')),
      plain('CHA_CLAUDE_RUNTIME', 'agent-sdk-sidecar'),
      // Windows 上 Claude Code 的 Bash 要 Git Bash：夹具交给服务的 PATH 里只有 Git 的 cmd 目录，它自己找不到
      ...(WINDOWS && gitForWindows()?.bash
        ? [plain('CLAUDE_CODE_GIT_BASH_PATH', gitForWindows().bash)]
        : []),
      plain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1'),
      plain('DISABLE_AUTOUPDATER', '1'),
      plain('DISABLE_TELEMETRY', '1'),
      plain('DISABLE_ERROR_REPORTING', '1'),
    ]
    mkdirSync(join(root, 'claude'), { recursive: true })
    mkdirSync(join(root, 'ct'), { recursive: true, mode: 0o700 })
  }
  if (engines.dsh) {
    // 实验性的 dsh 默认只在检测到装了它时才启用；这里明说要它
    values['harness.dsh.enabled'] = true
    values['harness.dsh.cliPath'] = engines.dsh
    values['harness.dsh.env'] = [
      plain('DEEPSEEK_BASE_URL', `${modelUrl}/dsh/anthropic`),
      secret('DEEPSEEK_API_KEY', 'fixture-only'),
      plain('DSH_AGENTS_HOME', join(root, 'agents')),
    ]
    mkdirSync(join(root, 'agents'), { recursive: true })
  }
  if (engines.opencode) {
    values['harness.opencode.cliPath'] = engines.opencode
    values['harness.opencode.env'] = opencodeEnv(join(root, 'oc'), `${modelUrl}/opencode/v1`)
  }
  if (engines.acp) {
    // 自填命令的 ACP 入口接的是 opencode acp：和上面那份 OpenCode 各用各的数据目录，模型地址带着 acp
    values['harness.acp.cliPath'] = engines.acp
    values['harness.acp.env'] = [
      plain('CHA_ACP_ARGS', process.env.CHA_ACP_ARGS?.trim() || 'acp'),
      ...opencodeEnv(join(root, 'oa'), `${modelUrl}/acp/v1`),
    ]
  }
  if (engines.codex) {
    // 原生 codex 的数据目录（会话、配置、登录状态）整个在夹具里；配置只指向回环上的假模型，没有凭据。
    // 它想往外连的（插件市场、更新检查）一律走连不通的代理
    const codexHome = join(root, 'cx')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'config.toml'), codexConfig(`${modelUrl}/codex/v1`))
    values['harness.codex.cliPath'] = engines.codex
    values['harness.codex.env'] = [
      plain('CODEX_HOME', codexHome),
      // npm 装的 codex 是个 node 脚本（#!/usr/bin/env node），隔离的登录 shell 给的 PATH 里没有 node：补上跑夹具的这份
      plain('PATH', `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`),
      ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(
        (name) => plain(name, DEAD_END),
      ),
      plain('NO_PROXY', '127.0.0.1,localhost'),
      plain('no_proxy', '127.0.0.1,localhost'),
    ]
  }
  mkdirSync(join(home, 'device'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(home, 'device', 'settings.json'),
    `${JSON.stringify({ version: 1, values }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

/**
 * 交给服务的 PATH 里不能有用户装的 harness：引擎找命令行除了看那几个变量就是看 PATH，
 * 这里的隔离靠的就是“这几个目录里找不到”。找得到就报错退出，不往下走
 */
export function refuseHarnessOnPath(directories) {
  for (const directory of directories) {
    // 装了就默认启用的（dsh、OpenCode、原生 codex）和经 ACP 接的几个 agent 也都不能在
    for (const name of ['claude', 'pi', 'dsh', 'codex', 'opencode', 'gemini', 'qwen']) {
      // Windows 上按名字找命令时还要试各种后缀（npm 装的是 .cmd 和 .ps1，原生的是 .exe）；那里没有执行位，在就算
      const found = WINDOWS
        ? WINDOWS_SUFFIXES.map((suffix) => `${name}${suffix}`).find((file) =>
            existsSync(join(directory, file)),
          )
        : executable(join(directory, name)) && name
      if (!found) continue
      console.error(
        `${directory} 里有一个 ${found}，交给服务的 PATH 里不能有它：隔离不成立，不启动`,
      )
      process.exit(1)
    }
  }
}

const executable = (file) => {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let gitFound
/**
 * Windows 上的 Git：从跑夹具的这个进程的 PATH 里找 git.exe。返回它所在的目录（一般是 Git\cmd，
 * 只放 git 自己，没有 bash 和别的 Unix 工具）和 Git Bash 的位置（Git\bin\bash.exe，没有就是 null）。
 * 找不到 git 是 null。别的系统不用它
 */
export function gitForWindows() {
  if (gitFound !== undefined) return gitFound
  gitFound = null
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (!existsSync(join(directory, 'git.exe'))) continue
    // Git\cmd、Git\bin、Git\mingw64\bin 都可能放着 git.exe，Git Bash 在安装目录的 bin 下面
    const top = directory.replace(/[\\/](?:cmd|bin|mingw64[\\/]bin)[\\/]?$/i, '')
    const bash = join(top, 'bin', 'bash.exe')
    gitFound = { dir: directory, bash: existsSync(bash) ? bash : null }
    break
  }
  return gitFound
}

/**
 * 备好三个引擎各走一遍用的工作目录：一个提交过一次的 git 仓库（差异面板看的是没提交的改动），
 * 里面给三家各放一份技能。git 只在这个目录里跑，不读用户自己的 git 配置，也不许它往上找别的仓库
 */
export function prepareWorkDirectory(cwd, engines) {
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# 三个引擎各走一遍用的工作目录\n')
  installProjectSkill(cwd, engines)
  const git = (...args) => {
    const done = spawnSync(
      'git',
      ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: dirname(cwd),
          GIT_CONFIG_NOSYSTEM: '1',
          // Windows 上没有 /dev/null，对应的是 NUL
          GIT_CONFIG_GLOBAL: WINDOWS ? 'NUL' : '/dev/null',
          GIT_CEILING_DIRECTORIES: dirname(cwd),
          GIT_TERMINAL_PROMPT: '0',
          // Windows 上的程序少了它有的会起不来
          ...(WINDOWS ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
    )
    if (done.status !== 0) throw new Error(`git ${args[0]} 没成：${done.stderr || done.error}`)
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', '起点')
}

/**
 * 交给界面的工作目录用哪种写法（就绪行里的 engines.cwd）。macOS 上 /tmp、/var 是指向 /private/tmp、/private/var
 * 的符号链接：这里故意给和真实路径不一样的那种（真实路径是 /private/tmp/…，就给 /tmp/…）。Claude Code 报的是解开
 * 链接之后的真实路径（它的工作目录取自 process.cwd()，模型照着写出完整路径），用户在 macOS 上用 $TMPDIR 下的目录时
 * 就是这样：工作区的根和 harness 给的路径是同一个目录的两种写法。界面要把两种写法认成一处
 * （packages/core/src/text/paths.mts 的 pathTwin），三引擎验收的每一步都在这种情形下走，“在差异里看”曾因此找不到文件。
 * 别的系统、不在这几处下面的照原样给
 */
export function spelledApart(dir) {
  const real = realpathSync(dir)
  const found = /^\/private(\/(?:tmp|var)(?:\/.*)?)$/.exec(real)
  return found ? found[1] : dir
}

/**
 * 在一个工作目录里给三家各放一份同名的技能。三家找项目技能的位置不一样：
 * Claude Code 是 .claude/skills，Pi 是 .pi/skills，dsh 是 .dsh/skills，OpenCode 是 .opencode/skills。
 * 返回各家那份文件的位置
 */
export function installProjectSkill(cwd, engines) {
  const places = {
    ...(engines.claude ? { 'claude-code': '.claude' } : {}),
    pi: '.pi',
    ...(engines.dsh ? { dsh: '.dsh' } : {}),
    ...(engines.opencode ? { opencode: '.opencode' } : {}),
  }
  const files = {}
  for (const [id, directory] of Object.entries(places)) {
    const folder = join(cwd, directory, 'skills', FIXTURE_SKILL.name)
    mkdirSync(folder, { recursive: true })
    files[id] = join(folder, 'SKILL.md')
    writeFileSync(files[id], skillFile())
  }
  return files
}
