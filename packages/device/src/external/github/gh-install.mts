import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { ExternalPrivateFiles } from '../secrets-files.mjs'
import { downloadGithubCli, githubCliAsset, MANAGED_GITHUB_CLI_VERSION } from './gh-download.mjs'
import { installedGithubCli, managedGithubCliPath } from './gh-version.mjs'
import { GithubWriteFault } from './write-api.mjs'

const exec = promisify(execFile)
const safeToRemove = '.retired-safe'

export async function extractGithubCli(archive: string, assetName: string, binary: string) {
  // Windows 与 macOS 自带的 bsdtar 支持 zip；Linux 用系统 tar 读 tar.gz。
  const systemRoot = process.env.SystemRoot
  const tar =
    process.platform === 'win32' && systemRoot && isAbsolute(systemRoot)
      ? join(systemRoot, 'System32', 'tar.exe')
      : '/usr/bin/tar'
  const unzip = archive.endsWith('.zip') && process.platform === 'linux'
  const options = {
    encoding: 'buffer',
    maxBuffer: 80 * 1024 * 1024,
    timeout: 15_000,
    windowsHide: true,
    env: systemRoot && process.platform === 'win32' ? { SystemRoot: systemRoot } : {},
  } as const
  const run = async (args: string[]) =>
    (await exec(unzip ? '/usr/bin/unzip' : tar, args, options)).stdout
  try {
    const entries = (await run(unzip ? ['-Z1', archive] : ['-tf', archive]))
      .toString()
      .split(/\r?\n/)
    const root = assetName.replace(/\.(?:zip|tar\.gz)$/, '')
    const extract = async (member: string) => {
      const matches = entries.filter((entry) => entry === member || entry === `${root}/${member}`)
      if (matches.length !== 1) throw new Error('archive member must be unique')
      const name = matches[0] as string
      return run(unzip ? ['-p', archive, name] : ['-xOf', archive, name])
    }
    await mkdir(dirname(binary), { mode: 0o700, recursive: true })
    await writeFile(binary, await extract(`bin/${basename(binary)}`), { mode: 0o700, flag: 'wx' })
    await writeFile(join(dirname(dirname(binary)), 'LICENSE'), await extract('LICENSE'), {
      mode: 0o600,
      flag: 'wx',
    })
  } catch {
    throw new GithubWriteFault('github_gh_install_archive')
  }
}

type Asset = ReturnType<typeof githubCliAsset>
type InstallFixture = { asset: Asset; proxyEnv?: NodeJS.ProcessEnv; backoffMs?: number }

/** 与设备状态锁同寿命；所有入口共用一个下载，取消单次授权不会中断其他入口。 */
export class ManagedGithubCli {
  private readonly stop = new AbortController()
  private flight: Promise<string> | undefined
  private downloading = false
  private readonly listeners = new Set<() => void>()
  private initialized = false
  private active = 0
  private readonly stateDirectory: string
  private readonly log: (message: string) => void
  private readonly fixture: InstallFixture | undefined

  constructor(
    stateDirectory: string,
    log: (message: string) => void = () => {},
    fixture?: InstallFixture,
  ) {
    this.stateDirectory = stateDirectory
    this.log = log
    this.fixture = fixture
  }

  get path(): string {
    return managedGithubCliPath(this.stateDirectory)
  }

  async use<T>(work: (path: string) => Promise<T>, downloading?: () => void, signal?: AbortSignal) {
    this.active++
    try {
      const path = await this.ensure(downloading, signal)
      signal?.throwIfAborted()
      return await work(path)
    } finally {
      this.active--
    }
  }

  async ensure(onDownload?: () => void, signal?: AbortSignal): Promise<string> {
    this.stop.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (onDownload) this.listeners.add(onDownload)
    this.flight ??= this.install(
      this.path,
      join(this.stateDirectory, 'tools', 'github-cli'),
    ).finally(() => {
      this.flight = undefined
      this.downloading = false
    })
    const flight = this.flight
    try {
      if (this.downloading) onDownload?.()
      if (!signal) return await flight
      return await new Promise<string>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        void flight.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
    } finally {
      if (onDownload) this.listeners.delete(onDownload)
    }
  }

  abort(): void {
    this.stop.abort(new GithubWriteFault('github_gh_download_unavailable'))
  }

  async retire(noAgentUsers: boolean): Promise<void> {
    await this.flight?.catch(() => {})
    if (!this.initialized || !noAgentUsers || this.active !== 0) return
    const marker = join(
      this.stateDirectory,
      'tools',
      'github-cli',
      MANAGED_GITHUB_CLI_VERSION,
      safeToRemove,
    )
    await writeFile(marker, '', { flag: 'wx', mode: 0o600 }).catch(() => {
      this.log('未能标记 GitHub CLI 缓存可清理')
    })
  }

  private async prepare(root: string): Promise<void> {
    if (this.initialized) return
    // 上一进程正常退出且确认无使用者，才会留下可清理标记。非正常退出保留旧版本。
    await rm(join(root, MANAGED_GITHUB_CLI_VERSION, safeToRemove), { force: true })
    this.initialized = true
    const versionParts = (value: string) => value.split('.').map(Number)
    const current = versionParts(MANAGED_GITHUB_CLI_VERSION)
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+\.\d+\.\d+$/.test(entry.name)) continue
      const diff = versionParts(entry.name)
        .map((n, i) => n - (current[i] ?? 0))
        .find((n) => n !== 0)
      if (diff === undefined || diff >= 0) continue
      const directory = join(root, entry.name)
      if (!(await lstat(join(directory, safeToRemove)).catch(() => null))?.isFile()) continue
      await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(
        () => {
          this.log('未能清理旧版 GitHub CLI 缓存')
        },
      )
    }
  }

  private async install(path: string, root: string): Promise<string> {
    let temp: string | undefined
    try {
      if (!this.initialized) {
        new ExternalPrivateFiles(root)
        const child = relative(await realpath(this.stateDirectory), await realpath(root))
        if (child !== join('tools', 'github-cli'))
          throw new Error('managed root outside state directory')
      }
      const installed = await installedGithubCli(path, root)
      if (installed) {
        await this.prepare(root)
        return installed
      }
      const target = dirname(dirname(path))
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      if (
        relative(await realpath(root), await realpath(dirname(target))) !==
        MANAGED_GITHUB_CLI_VERSION
      )
        throw new Error('managed version outside tool cache')
      temp = await mkdtemp(join(root, '.install-'))
      const asset = this.fixture?.asset ?? githubCliAsset(process.platform, process.arch)
      const archive = join(temp, asset.filename)
      this.downloading = true
      for (const notify of this.listeners) notify()
      await downloadGithubCli(
        asset,
        archive,
        this.stop.signal,
        this.fixture?.proxyEnv,
        this.fixture?.backoffMs,
      )
      const staged = join(temp, 'staged')
      await extractGithubCli(archive, asset.filename, join(staged, 'bin', basename(path)))
      this.stop.signal.throwIfAborted()
      await rename(staged, target)
      try {
        const resolved = await installedGithubCli(path, root)
        if (!resolved) throw new GithubWriteFault('github_gh_install_failed')
        await this.prepare(root)
        return resolved
      } catch (error) {
        await rm(target, { recursive: true, force: true, maxRetries: 2 })
        throw error
      }
    } catch (error) {
      if (error instanceof GithubWriteFault) throw error
      throw new GithubWriteFault('github_gh_install_failed')
    } finally {
      if (temp)
        await rm(temp, { recursive: true, force: true, maxRetries: 2 }).catch(() => {
          this.log('未能清理 GitHub CLI 下载的临时目录')
        })
    }
  }
}
