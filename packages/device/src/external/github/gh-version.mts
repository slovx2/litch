import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { GithubWriteFault } from './write-api.mjs'

// 制品由 H 线按各平台固定版本和官方校验和安装到设备运行时目录。
export const BUNDLED_GITHUB_CLI_VERSION = '2.102.0'

/** 仅用于用户明确要求的系统登录导入。顺序与 gh 的配置目录规则一致。 */
export function locateSystemGithubConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh')
  const appData = env.AppData ?? env.APPDATA
  return platform === 'win32' && appData ? join(appData, 'GitHub CLI') : join(home, '.config', 'gh')
}

export function bundledGithubCliPath(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): string {
  if (
    !isAbsolute(runtimeRoot) ||
    !['linux', 'darwin', 'win32'].includes(platform) ||
    !['x64', 'arm64'].includes(arch)
  )
    throw new GithubWriteFault('github_gh_platform_unsupported')
  return join(
    runtimeRoot,
    'tools',
    'github-cli',
    BUNDLED_GITHUB_CLI_VERSION,
    `${platform}-${arch}`,
    'bin',
    platform === 'win32' ? 'gh.exe' : 'gh',
  )
}

export async function resolveBundledGithubCli(runtimeRoot: string): Promise<string> {
  const expected = bundledGithubCliPath(runtimeRoot)
  let path: string
  try {
    const base = await realpath(runtimeRoot)
    path = await realpath(expected)
    const child = relative(base, path)
    if (!child || child.startsWith('..') || isAbsolute(child) || !(await stat(path)).isFile())
      throw new Error()
    await access(path, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
  } catch {
    throw new GithubWriteFault('github_gh_bundled_binary_missing')
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      path,
      ['--version'],
      {
        env:
          process.platform === 'win32' && process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {},
        cwd: runtimeRoot,
        encoding: 'utf8',
        maxBuffer: 8192,
        timeout: 5000,
        windowsHide: true,
      },
      (error, output) =>
        error ? reject(new GithubWriteFault('github_gh_version_unavailable')) : resolve(output),
    )
  })
  const version = /^gh version (\d+\.\d+\.\d+)(?:\s|$)/.exec(stdout)?.[1]
  if (version !== BUNDLED_GITHUB_CLI_VERSION)
    throw new GithubWriteFault('github_gh_version_mismatch')
  return path
}
