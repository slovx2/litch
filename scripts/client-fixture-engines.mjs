// 三引擎的隔离环境：让由适配器主进程管着的那份设备服务除了 Pi，把 Claude Code 和 DeepSeek Harness（dsh）
// 也起来，模型请求一样打到回环上的假模型。device-fixture.mjs --managed 和 client-local-fixture.mjs 共用这一份。
//
// 开关是 --engines claude,pi,dsh（Pi 一直在，写不写都起）。要哪个引擎就得给它一份隔离的命令行：
//   CHA_CLAUDE_CLI     隔离的 Claude Code（流水线上是装到 .artifacts/host-cli 的那一份）
//   CHA_DSH_CLI        隔离的 dsh（流水线上是装到 .artifacts/host-dsh 的那一份）
//   CHA_OPENCODE_CLI   隔离的 opencode（--engines 里写了 opencode 才要；三引擎验收还不带它）
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
import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FIXTURE_SKILL, skillFile } from './client-fixture-marks.mjs'

/** 开关里的名字 → harness 的标识、给它命令行的环境变量 */
const ENGINES = {
  claude: { id: 'claude-code', variable: 'CHA_CLAUDE_CLI', name: 'Claude Code' },
  dsh: { id: 'dsh', variable: 'CHA_DSH_CLI', name: 'DeepSeek Harness' },
  opencode: { id: 'opencode', variable: 'CHA_OPENCODE_CLI', name: 'OpenCode' },
}

/** 经 ACP 接的几个 harness：夹具不起它们（要真的 agent），一律在设置里停用 */
const ACP_HARNESSES = ['gemini', 'qwen', 'acp']

/**
 * 读开关。返回要起的那几个引擎的命令行：{ claude: 路径或 null, dsh: 路径或 null }。
 * 没带开关时两个都是 null，夹具照旧只有 Pi。说不通的地方报错退出
 */
export function wantedEngines(argv = process.argv, env = process.env) {
  const at = argv.indexOf('--engines')
  const wanted = { claude: null, dsh: null, opencode: null }
  if (at < 0) return wanted
  const names = (argv[at + 1] ?? '').split(',').filter(Boolean)
  const unknown = names.filter((name) => name !== 'pi' && !ENGINES[name])
  if (names.length === 0 || unknown.length > 0) {
    console.error(
      `--engines 后面写要起的引擎，用逗号隔开（claude、pi、dsh、opencode）${unknown.join(' ')}`,
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
]

const plain = (name, value) => ({ name, value })
const secret = (name, value) => ({ name, value, secret: true })

/**
 * 把这两个引擎的配置写进设置文件（主进程起来之前写，它一起来就照着起）。
 * modelUrl 是假模型的地址（不带路径），root 是夹具的临时目录。Pi 的审批顺手打开：三家都调到“会问”
 */
export function writeEngineSettings({ home, root, modelUrl, engines }) {
  const values = {
    'harness.pi.approvals': true,
    'harness.opencode.enabled': Boolean(engines.opencode),
  }
  for (const id of ACP_HARNESSES) values[`harness.${id}.enabled`] = false
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
    // OpenCode 的配置、数据、缓存都按 XDG 找：全指进夹具，不碰 ~/.config/opencode、~/.local/share/opencode。
    // 模型走回环上的假模型（OpenAI 兼容的那一种，和 Pi 同一路），配置整份经 OPENCODE_CONFIG_CONTENT 给。
    // 还没对着真的 OpenCode 引擎跑过（引擎包在另一条线上），合进来之后要核对
    const xdg = join(root, 'oc')
    values['harness.opencode.cliPath'] = engines.opencode
    values['harness.opencode.env'] = [
      plain('XDG_CONFIG_HOME', join(xdg, 'config')),
      plain('XDG_DATA_HOME', join(xdg, 'data')),
      plain('XDG_CACHE_HOME', join(xdg, 'cache')),
      plain('XDG_STATE_HOME', join(xdg, 'state')),
      plain('OPENCODE_DISABLE_AUTOUPDATE', '1'),
      plain('OPENCODE_DISABLE_MODELS_FETCH', '1'),
      plain('OPENCODE_DISABLE_LSP_DOWNLOAD', '1'),
      plain(
        'OPENCODE_CONFIG_CONTENT',
        JSON.stringify({
          autoupdate: false,
          share: 'disabled',
          model: 'fixture/gate',
          provider: {
            fixture: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Fixture',
              // 地址里带着 harness 的标识，假模型据此知道请求是谁发来的
              options: { baseURL: `${modelUrl}/opencode/v1`, apiKey: 'fixture-only' },
              models: { gate: { name: 'Gate' } },
            },
          },
        }),
      ),
    ]
    for (const name of ['config', 'data', 'cache', 'state']) {
      mkdirSync(join(xdg, name), { recursive: true })
    }
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
      try {
        accessSync(join(directory, name), constants.X_OK)
      } catch {
        continue
      }
      console.error(`${directory} 里有一个 ${name}，交给服务的 PATH 里不能有它：隔离不成立，不启动`)
      process.exit(1)
    }
  }
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
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CEILING_DIRECTORIES: dirname(cwd),
          GIT_TERMINAL_PROMPT: '0',
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
