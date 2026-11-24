// 设备给 Agent 用的 lark-cli：Litch 从固定的上游标签用 authsidecar 编译、签名后单独发布，设备按需下载、核对校验和。
// 版本固定，跟着 Litch 发版手动升级；升级时要对照新版的接口目录重看 cli-policy.mts 的名单。
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadGithubCli } from '../external/github/gh-download.mjs'
import { FEISHU_CLI_DIRECTORY } from './cli-proxy.mjs'

export const MANAGED_LARK_CLI_VERSION = '1.0.100'
const release = `https://github.com/slovx2/litch/releases/download/lark-cli-sidecar-v${MANAGED_LARK_CLI_VERSION}/`
// 各平台二进制的 SHA-256；发布后填进来，设备不会从网络更新这份清单。
const assets: Partial<Record<string, string>> = {}

/** 按需下载、核对、装好；同一时间只下一份 */
export class ManagedLarkCli {
  private readonly stateDirectory: string
  private readonly fixture: string | undefined
  private flight: Promise<string> | undefined

  /** fixture：测试与联调直接用这份 lark-cli，不下载（只能进程内给） */
  constructor(stateDirectory: string, fixture?: string) {
    this.stateDirectory = stateDirectory
    this.fixture = fixture
  }

  async ensure(): Promise<string> {
    if (this.fixture) return this.fixture
    this.flight ??= this.install().finally(() => {
      this.flight = undefined
    })
    return await this.flight
  }

  private async install(): Promise<string> {
    const windows = process.platform === 'win32'
    const key = `${process.platform}-${process.arch}`
    const sha256 = assets[key]
    if (!sha256) throw new Error(`no published lark-cli build for ${key} yet`)
    const folder = join(
      this.stateDirectory,
      FEISHU_CLI_DIRECTORY,
      'bin',
      MANAGED_LARK_CLI_VERSION,
    )
    const path = join(folder, windows ? 'lark-cli.exe' : 'lark-cli')
    if ((await stat(path).catch(() => null))?.isFile()) return path
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.download`
    await rm(temp, { force: true })
    try {
      await downloadGithubCli(
        {
          url: new URL(`lark-cli-${MANAGED_LARK_CLI_VERSION}-${key}${windows ? '.exe' : ''}`, release),
          sha256,
        },
        temp,
        AbortSignal.timeout(180_000),
      )
      await chmod(temp, 0o700)
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw new Error(`downloading lark-cli failed (${(error as Error).message})`)
    }
    return path
  }
}
