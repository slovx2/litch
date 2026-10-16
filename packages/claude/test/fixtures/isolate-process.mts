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
// 进程内起的 CLI 也不往本机共用的 /tmp/claude-<uid> 里写（它不看 TMPDIR）
process.env.CLAUDE_CODE_TMPDIR = join(home, 'ct')
// 进程内解析 CLI 路径的用例同样不能落到 PATH 里的 claude。
process.env.CHA_CLAUDE_CLI = configuredClaudeCli()
