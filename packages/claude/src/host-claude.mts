import { execFileSync } from 'node:child_process'
import { cliCommand, resolveHostCli } from '../../shared/src/host-cli.mjs'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'

// 入口自己用的一次性 CLI（追加上下文、读用量、起标题这类）不开本机收件箱（Claude Code 的跨会话消息）：
// 不登记套接字，本机别处的 Claude 会话看不见它们。放在 ...process.env 之后，压过外面环境里带进来的值。
export const hostClaudeEnvOverrides = { CLAUDE_CODE_HARBOR_KITE: '0' } as const

// 会话的 CLI：设置里“接收别的 Claude 会话的消息”开着（CHA_CLAUDE_CROSS_SESSION_INBOX，默认开）时不关收件箱，
// 别处的 Claude 会话能列出它、发消息进来；关着时和一次性的一样关掉
export function hostClaudeSessionEnv(inbox: boolean): Readonly<Record<string, string>> {
  return inbox ? {} : hostClaudeEnvOverrides
}

// 后台命令的时长上限：CLI 取 max(2 小时, BASH_MAX_TIMEOUT_MS)，到点停掉命令。Litch 起的 CLI 放宽到 24 小时；
// 用户在 harness 的环境设置或启动环境里写了就照它，settings.json 的 env 里写的本来就盖过进程环境。
// 这个变量同时是前台命令超时的上限（CLI 默认 10 分钟），一起变；默认超时（BASH_DEFAULT_TIMEOUT_MS）不动
export const CLAUDE_BASH_MAX_TIMEOUT_MS = String(24 * 60 * 60 * 1000)

export function claudeBashTimeoutEnv(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  return env.BASH_MAX_TIMEOUT_MS?.trim() ? {} : { BASH_MAX_TIMEOUT_MS: CLAUDE_BASH_MAX_TIMEOUT_MS }
}

// 解析真实文件，保留 npm CLI 的 .js 后缀，让 SDK 使用其官方 Node 启动方式。
export function hostClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const command = env.CHA_CLAUDE_CLI?.trim() || 'claude'
  try {
    return resolveHostCli(command, '@anthropic-ai/claude-code', 'bin/claude.exe', env)
  } catch {
    throw new Error(
      `宿主 Claude CLI 不可执行或未找到: ${command}；请配置 CHA_CLAUDE_CLI 或当前用户 PATH`,
    )
  }
}

export function hostClaudeVersion(cli: string, minimum: string): string {
  let actual: string
  try {
    const [command, ...args] = cliCommand(cli, ['--version'])
    actual = execFileSync(command!, args, { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    throw new Error(`无法读取宿主 Claude CLI 版本: ${cli}`)
  }
  if (!isVersionAtLeast(/^(\S+) \(Claude Code\)$/.exec(actual)?.[1], minimum))
    throw new Error(`宿主 Claude CLI 版本不符: 需要 >= ${minimum} (Claude Code)，实际 ${actual}`)
  return actual
}
