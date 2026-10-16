import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

// SDK 的 Linux 文件/网络沙箱同时需要两个可执行文件；缺失时不能声称完整权限能力可用。
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
      ? [
          ['bwrap', ['--version']],
          ['socat', ['-V']],
        ]
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
