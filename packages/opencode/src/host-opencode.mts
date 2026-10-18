import { execFileSync } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cliCommand, resolveHostCli } from '../../shared/src/host-cli.mjs'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'

// OpenCode 本体不随适配器分发：用用户自己装的可执行文件。CHA_OPENCODE_CLI 可指定路径；
// 不指定时先按 PATH 找 opencode，再找官方安装脚本的默认位置 ~/.opencode/bin/opencode。
// 报错的原文是 Go 侧诊断认原因用的（cmd/codex-harness-adapter/diagnostics.go 按开头认），改了要两边一起改：
// 没装：“CLI 不可执行或未找到”；版本低：“OpenCode CLI 版本不符”；读不到版本：“无法读取宿主 OpenCode CLI 版本”。
export function hostOpencodeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CHA_OPENCODE_CLI?.trim()
  const command = configured || 'opencode'
  try {
    return resolveHostCli(command, 'opencode-ai', 'bin/opencode', env)
  } catch {}
  if (!configured) {
    const fallback = join(env.HOME || homedir(), '.opencode', 'bin', 'opencode')
    try {
      accessSync(fallback, constants.X_OK)
      return realpathSync(fallback)
    } catch {}
  }
  throw new Error(
    `宿主 OpenCode CLI 不可执行或未找到: ${command}；请先安装 OpenCode，或配置 CHA_OPENCODE_CLI 或当前用户 PATH`,
  )
}

/** 从一段输出里取第一个形如 1.2.3 的版本号 */
export function parseVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0]
}

/** 版本不低于下限时什么也不做，否则按约定的原文报错（`detail` 是原始输出或来源，截短了带上） */
export function assertOpencodeVersion(
  version: string | undefined,
  minimum: string,
  detail: string,
) {
  if (!isVersionAtLeast(version, minimum))
    throw new Error(`宿主 OpenCode CLI 版本不符: 需要 >= ${minimum}，实际 ${detail.slice(0, 80)}`)
}

// 读取用户安装的 OpenCode 版本并核对下限，返回裸版本号。
export function hostOpencodeVersion(cli: string, minimum: string): string {
  let output: string
  try {
    const [command, ...args] = cliCommand(cli, ['--version'])
    output = execFileSync(command as string, args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new Error(`无法读取宿主 OpenCode CLI 版本: ${cli}`)
  }
  const version = parseVersion(output)
  assertOpencodeVersion(version, minimum, output)
  return version as string
}
