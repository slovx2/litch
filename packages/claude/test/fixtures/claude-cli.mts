import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'

// 真实 CLI 用例只用运行测试的人通过 CHA_CLAUDE_CLI 显式指定的隔离 CLI。
// 没指定时既不跳过，也不改用 PATH 里的 claude（那是开发者自己在用的安装）：
// 测试进程和被测进程拿到的都是下面这个不存在的路径，需要 CLI 的地方会明确失败。
export const missingClaudeCli = '/nonexistent/set-CHA_CLAUDE_CLI-to-an-isolated-claude-cli'

export function configuredClaudeCli(): string {
  return process.env.CHA_CLAUDE_CLI?.trim() || missingClaudeCli
}

// 进程表里 CLI 进程的命令行开头。适配器启动的是解析符号链接之后的路径
// （npm 装出来的 `.bin/claude` 是指向包内二进制的链接），按配置的原路径找不到进程。
export function claudeCliCommand(): string {
  const cli = configuredClaudeCli()
  try {
    return realpathSync(cli)
  } catch {
    return cli
  }
}

export function requiredClaudeCli(): string {
  const cli = configuredClaudeCli()
  if (cli === missingClaudeCli)
    throw new Error(
      '这个用例要启动真实的 Claude Code CLI：请把 CHA_CLAUDE_CLI 设为隔离的 CLI 路径后重跑（未设置时不会改用 PATH 里的 claude）',
    )
  return cli
}

// 夹具的 start() 在创建任何东西之前调用。调用方的用例这时还没进入 try/finally，
// 报错前把交给夹具的临时主目录清掉，配置不对的运行不在临时目录里留下一堆空目录。
export async function requireClaudeCliFor(home: string): Promise<void> {
  try {
    requiredClaudeCli()
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}
