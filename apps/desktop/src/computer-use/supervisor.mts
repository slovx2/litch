// 拉起并看护 Computer Use 助手。
//
// 怎么拉起：经 LaunchServices（`open -n -g -a 助手.app`），不直接 spawn。实测：直接 spawn 出来的
// 助手，系统记的“责任进程”是拉起它的那一个（Litch），辅助功能、屏幕录制的授权会算在 Litch 头上；经 open 打开的助手
// 父进程是 launchd，责任进程是它自己，授权记在 “Litch Computer Use” 名下。所以只能用 open。
// 代价：拿不到子进程句柄，助手活没活着靠套接字连接来看；进程号由握手告诉我们。
//
// 用到时才拉起（Computer Use 默认关，没用过就不起后台进程）。连接断了（崩溃、被杀）就退避着重拉，一分钟里超过
// 五次就不再自己拉，等下一次用到时再试。助手没有连接满 60 秒会自己退出，所以 Litch 退出后不会留下它。
//
// 已经有一个助手在这个目录里时：握手通过、是同一份应用、同一个版本就接着用；版本或位置不对（升级了 Litch、
// 换了一份开发构建）就请它退出再起自己的；握手不过（开发期上一次的令牌对不上）就按它留下的进程号文件结束它。
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { HelperClient } from './helper-client.mjs'
import { type HelloResult, HelperError, type StoppedNotice } from './wire.mjs'

/** 套接字路径的上限（sockaddr_un 的 sun_path 是 104 字节，含结尾的 0） */
const MAX_SOCKET_PATH = 103

export interface SupervisorOptions {
  /** 助手应用的路径（Litch Computer Use.app） */
  appPath: string
  /** 套接字、日志、进程号文件所在的目录 */
  directory: string
  /** 期望的助手版本（Litch 的版本）；null 表示不比 */
  version: string | null
  /** 现在的界面语言 */
  lang(): string
  onStopped?(notice: StoppedNotice): void
  log?(line: string): void
  /** 测试用：替换“经 LaunchServices 打开”这一步 */
  launch?(appPath: string, env: Record<string, string>): Promise<void>
  /** 测试用：结束一个进程 */
  kill?(pid: number): void
}

export class HelperSupervisor {
  private current: HelperClient | null = null
  private connecting: Promise<HelperClient> | null = null
  private disposed = false
  private crashes: number[] = []
  private retry: ReturnType<typeof setTimeout> | null = null

  private readonly options: SupervisorOptions

  constructor(options: SupervisorOptions) {
    this.options = options
  }

  get socketPath(): string {
    return join(this.options.directory, 'helper.sock')
  }

  /** 现在连着的那条（不触发拉起） */
  get connected(): HelperClient | null {
    return this.current?.isOpen ? this.current : null
  }

  /** 拿一条握手过的连接；没有就连现成的或拉起一个 */
  client(): Promise<HelperClient> {
    if (this.disposed) return Promise.reject(new HelperError('failed', 'Computer Use is shut down'))
    if (this.current?.isOpen) return Promise.resolve(this.current)
    this.connecting ??= this.establish().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /** 改了界面语言：告诉在跑的助手（下次握手也会带上） */
  setLanguage(lang: string): void {
    this.connected?.request('setLanguage', { lang }).catch(() => {})
  }

  /** 让助手退出再起一个（屏幕录制授权之后要重启进程才生效） */
  async restart(): Promise<void> {
    const client = this.connected
    this.current = null
    if (client) {
      await client.request('shutdown', {}, 2000).catch(() => {})
      client.close()
      await this.waitGone()
    }
    await this.client()
  }

  /** Litch 退出时：请助手退出 */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.retry) clearTimeout(this.retry)
    const client = this.connected
    this.current = null
    if (client) {
      await client.request('shutdown', {}, 1000).catch(() => {})
      client.close()
    }
  }

  private log(line: string): void {
    this.options.log?.(`[computer-use] ${line}`)
  }

  private async establish(): Promise<HelperClient> {
    if (Buffer.byteLength(this.socketPath) > MAX_SOCKET_PATH) {
      throw new HelperError('failed', `socket path too long: ${this.socketPath}`)
    }
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })

    // 一、现成的助手
    const existing = await this.tryConnect()
    if (existing) {
      try {
        const hello = await existing.handshake(null, this.options.lang())
        if (this.acceptable(hello)) return this.adopt(existing)
        this.log(`在跑的助手不对（版本 ${hello.version}，位置 ${hello.bundlePath}），请它退出`)
        await existing.request('shutdown', {}, 2000).catch(() => {})
      } catch (error) {
        this.log(`在跑的助手不认这条连接（${(error as Error).message}），结束它`)
        this.killStale()
      }
      existing.close()
      await this.waitGone()
    }

    // 二、拉起新的
    const token = randomBytes(32).toString('hex')
    await (this.options.launch ?? openApp)(this.options.appPath, {
      LITCH_COMPUTER_USE_DIR: this.options.directory,
      LITCH_COMPUTER_USE_TOKEN: token,
    })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const client = await this.tryConnect()
      if (client) {
        const hello = await client.handshake(token, this.options.lang()).catch((error) => {
          client.close()
          throw error
        })
        this.log(`助手已就绪：进程 ${hello.pid}，版本 ${hello.version}，校验方式 ${hello.auth}`)
        return this.adopt(client)
      }
      await sleep(150)
    }
    throw new HelperError('failed', 'Litch Computer Use did not start within 15 seconds')
  }

  private acceptable(hello: HelloResult): boolean {
    if (this.options.version && hello.version !== this.options.version) return false
    return samePath(hello.bundlePath, this.options.appPath)
  }

  private adopt(client: HelperClient): HelperClient {
    this.current = client
    client.events = {
      onClose: () => this.lost(client),
      onStopped: (notice) => this.options.onStopped?.(notice),
    }
    return client
  }

  /** 连接意外断了：退避着重拉 */
  private lost(client: HelperClient): void {
    if (this.current !== client || this.disposed) return
    this.current = null
    const now = Date.now()
    this.crashes = [...this.crashes.filter((at) => now - at < 60_000), now]
    if (this.crashes.length > 5) {
      this.log('助手一分钟里断了五次以上，先不重拉，等下一次用到时再试')
      return
    }
    const delay = 500 * 2 ** (this.crashes.length - 1)
    this.log(`助手的连接断了，${delay} 毫秒后重拉`)
    this.retry = setTimeout(() => {
      this.retry = null
      this.client().catch((error) => this.log(`重拉没成：${(error as Error).message}`))
    }, delay)
  }

  private async tryConnect(): Promise<HelperClient | null> {
    try {
      return await HelperClient.connect(this.socketPath, {})
    } catch {
      return null
    }
  }

  /** 等套接字上没人听了（最多 3 秒） */
  private async waitGone(): Promise<void> {
    for (let i = 0; i < 30; i += 1) {
      const probe = await this.tryConnect()
      if (!probe) return
      probe.close()
      await sleep(100)
    }
  }

  /** 按助手留下的进程号文件结束它（只在开发期令牌对不上时用到） */
  private killStale(): void {
    try {
      const pid = Number(readFileSync(join(this.options.directory, 'helper.pid'), 'utf8').trim())
      if (Number.isInteger(pid) && pid > 1) (this.options.kill ?? killHelper)(pid)
    } catch {}
  }
}

/** 经 LaunchServices 打开助手：新实例、不抢前台，环境变量经 --env 交过去 */
export function openApp(appPath: string, env: Record<string, string>): Promise<void> {
  const args = ['-n', '-g', '-a', appPath]
  for (const [name, value] of Object.entries(env)) args.push('--env', `${name}=${value}`)
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', args, (error, _stdout, stderr) => {
      if (error) reject(new HelperError('failed', `open failed: ${stderr || error.message}`))
      else resolve()
    })
  })
}

/** 结束一个进程，先确认它是助手（进程号可能已经被别的进程重用） */
function killHelper(pid: number): void {
  execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], (error, stdout) => {
    if (error || !stdout.includes('LitchComputerUse')) return
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  })
}

function samePath(left: string, right: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  return real(left) === real(right)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
