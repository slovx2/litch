import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

// Windows npm 的 .cmd 不能由 execFile 直接执行；定位同一安装内的官方入口，避免 shell 拼接。
export function resolveHostCli(
  command: string,
  npmPackage: string,
  entry: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pathValue = env.PATH ?? env.Path ?? ''
  const roots =
    isAbsolute(command) || /[/\\]/.test(command)
      ? [resolve(command)]
      : pathValue
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, command))
  for (const root of roots) {
    const candidates =
      process.platform === 'win32'
        ? [
            root.endsWith('.exe') || root.endsWith('.js') ? root : `${root}.exe`,
            join(dirname(root), 'node_modules', npmPackage, entry),
            join(dirname(root), '..', npmPackage, entry),
            root,
          ]
        : [root]
    for (const candidate of candidates) {
      try {
        accessSync(candidate, constants.X_OK)
        const path = realpathSync(candidate)
        if (
          process.platform === 'win32' &&
          !['.exe', '.js', '.cjs', '.mjs'].includes(extname(path))
        )
          continue
        return path
      } catch {}
    }
  }
  throw new Error(`宿主 CLI 不可执行或未找到: ${command}`)
}

export function cliCommand(path: string, args: string[]): string[] {
  return /\.[cm]?js$/.test(path) ? [process.execPath, path, ...args] : [path, ...args]
}
