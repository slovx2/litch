// 看护 Computer Use 助手，和平台无关的那一半：拿连接、断了怎么办、换语言、重启、退出。
// 怎么把助手拉起来、怎么连上、怎么握手是启动器的事：macOS 在 launcher-mac.mts（经 LaunchServices 打开、unix 套接字），
// Windows 在 launcher-win.mts（spawn 子进程、标准输入输出）。
//
// 用到时才拉起（Computer Use 默认关，没用过就不起后台进程）。连接意外断了怎么办看启动器：
//   - eager（macOS）：退避着重拉，一分钟里超过五次就不再自己拉，等下一次用到时再试。
//   - onDemand（Windows）：不自己拉，下一次用到时再起。Windows 助手 60 秒没有请求就自己退出（09 号 9.2），
//     要是退出了就重拉，进程会一直在，“用到时才起”就不成立了；助手崩了，下一次调用照样会起一个新的。
import type { HelperClient } from './helper-client.mjs'
import { HelperError, type HelperStopped } from './wire.mjs'

/** 一个平台把助手拉起来、连上、握好手的办法 */
export interface HelperLauncher {
  /** 断了之后要不要自己重拉 */
  readonly respawn: 'eager' | 'onDemand'
  /** 给出一条握手过的连接（必要时先拉起助手）。失败时抛错 */
  establish(lang: string, log: (line: string) => void): Promise<HelperClient>
  /** 请助手退出之后等它真的走了（重启时用，免得新旧两个同时在） */
  afterShutdown(): Promise<void>
}

export interface SupervisorOptions {
  launcher: HelperLauncher
  /** 现在的界面语言 */
  lang(): string
  onStopped?(notice: HelperStopped): void
  log?(line: string): void
}

export class HelperSupervisor {
  private current: HelperClient | null = null
  private connecting: Promise<HelperClient> | null = null
  private disposed = false
  private crashes: number[] = []
  private retry: ReturnType<typeof setTimeout> | null = null
  /** 上一次拉起或连接出的错（设置页显示），连上之后清掉 */
  lastError: string | null = null

  private readonly options: SupervisorOptions

  constructor(options: SupervisorOptions) {
    this.options = options
  }

  /** 现在连着的那条（不触发拉起） */
  get connected(): HelperClient | null {
    return this.current?.isOpen ? this.current : null
  }

  /** 拿一条握手过的连接；没有就连现成的或拉起一个 */
  client(): Promise<HelperClient> {
    if (this.disposed) return Promise.reject(new HelperError('failed', 'Computer Use is shut down'))
    if (this.current?.isOpen) return Promise.resolve(this.current)
    this.connecting ??= this.options.launcher
      .establish(this.options.lang(), (line) => this.log(line))
      .then(
        (client) => this.adopt(client),
        (error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error)
          throw error
        },
      )
      .finally(() => {
        this.connecting = null
      })
    return this.connecting
  }

  /** 改了界面语言：告诉在跑的助手（下次握手也会带上） */
  setLanguage(lang: string): void {
    this.connected?.request('setLanguage', { lang }).catch(() => {})
  }

  /** 让助手退出再起一个（macOS 屏幕录制授权之后要重启进程才生效；设置页的“重启助手”） */
  async restart(): Promise<void> {
    const client = this.connected
    this.current = null
    if (client) {
      await client.request('shutdown', {}, 2000).catch(() => {})
      client.close()
      await this.options.launcher.afterShutdown()
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

  private adopt(client: HelperClient): HelperClient {
    if (this.disposed) {
      client.close()
      throw new HelperError('failed', 'Computer Use is shut down')
    }
    this.current = client
    this.lastError = null
    client.events = {
      onClose: () => this.lost(client),
      onStopped: (notice) => this.options.onStopped?.(notice),
    }
    return client
  }

  /** 连接断了：按启动器说的，退避着重拉，或者等下一次用到 */
  private lost(client: HelperClient): void {
    if (this.current !== client || this.disposed) return
    this.current = null
    if (this.options.launcher.respawn === 'onDemand') {
      this.log('助手退出了，下一次用到时再起')
      return
    }
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
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
