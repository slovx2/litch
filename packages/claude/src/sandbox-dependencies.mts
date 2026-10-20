import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

// 受限命令经适配器自己的包装器进系统沙箱（Linux 用 bwrap，macOS 用 sandbox-exec），SDK 自带的沙箱是关着的；
// 缺了就不能声称完整权限能力可用。
export function validateSandboxDependencies(
  platform = process.platform,
  probe: (command: string, args: string[]) => void = (command, args) => {
    if (command === '/usr/bin/sandbox-exec') accessSync(command, constants.X_OK)
    else execFileSync(command, args, { timeout: 5_000, stdio: 'pipe' })
  },
): void {
  // Windows 可运行原生 SDK；受限 Bash 仍由 command-sandbox 明确拒绝，绝不自动提权。
  if (platform === 'win32') return
  const commands: Array<[string, string[]]> =
    platform === 'linux'
      ? [['bwrap', ['--version']]]
      : platform === 'darwin'
        ? [['/usr/bin/sandbox-exec', []]]
        : []
  if (!commands.length) throw new Error(`Claude 完整权限运行时暂不支持平台 ${platform}`)
  for (const [command, args] of commands) {
    try {
      probe(command, args)
    } catch {
      throw new Error(`Claude 沙箱依赖不可用: ${command}；不能降级为无沙箱执行`)
    }
  }
}
