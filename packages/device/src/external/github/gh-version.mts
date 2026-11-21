import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { githubCliAsset, MANAGED_GITHUB_CLI_VERSION } from './gh-download.mjs'
import { GithubWriteFault } from './write-api.mjs'

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

export function managedGithubCliPath(
  stateDirectory: string,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): string {
  githubCliAsset(platform, arch)
  if (!isAbsolute(stateDirectory)) throw new GithubWriteFault('github_gh_install_failed')
  return join(
    stateDirectory,
    'tools',
    'github-cli',
    MANAGED_GITHUB_CLI_VERSION,
    `${platform}-${arch}`,
    'bin',
    platform === 'win32' ? 'gh.exe' : 'gh',
  )
}

export async function installedGithubCli(expected: string, root: string): Promise<string | null> {
  let path: string
  try {
    const file = await lstat(expected)
    const base = await realpath(root)
    path = await realpath(expected)
    if (relative(base, path) !== relative(root, expected) || !file.isFile()) throw new Error()
    await access(path, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new GithubWriteFault('github_gh_install_failed')
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
        cwd: root,
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
  if (version !== MANAGED_GITHUB_CLI_VERSION)
    throw new GithubWriteFault('github_gh_version_mismatch')
  return path
}
