import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configuredClaudeCli } from './claude-cli.mjs'

// 由测试命令用 --import 预加载：测试进程自身也不读取个人配置。
// 进程内构造服务对象的用例会经 homedir() 读到本机用户级的 MCP、技能与设置。
const home = mkdtempSync(join(tmpdir(), 'codex-harness-adapter-home-'))
process.once('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.CLAUDE_CONFIG_DIR
// 会话里跑测试时可能继承了真实状态目录的变量：日志只写进用例自己给的位置
delete process.env.LITCH_LOG_DIR
delete process.env.CHA_CLAUDE_DEBUG_LOG
delete process.env.CHA_CLAUDE_HOME
// 跑测试的人自己的模型凭据、网关、云厂商开关：进程内的模型目录会把它们当成用户自己另配的供应商
for (const name of Object.keys(process.env))
  if (
    /^ANTHROPIC_/.test(name) ||
    /^CLAUDE_CODE_USE_/.test(name) ||
    name === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    name === 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'
  )
    delete process.env[name]
// 进程内起的 CLI 也不往本机共用的 /tmp/claude-<uid> 里写（它不看 TMPDIR）
process.env.CLAUDE_CODE_TMPDIR = join(home, 'ct')
// 进程内解析 CLI 路径的用例同样不能落到 PATH 里的 claude。
process.env.CHA_CLAUDE_CLI = configuredClaudeCli()
