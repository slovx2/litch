import { execFileSync } from 'node:child_process'
import { cliCommand, resolveHostCli } from '../../shared/src/host-cli.mjs'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'

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
