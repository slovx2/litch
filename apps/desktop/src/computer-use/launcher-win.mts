// Windows 上拉起并连上 Computer Use 助手（看护的另一半在 supervisor.mts；协议见 wire.mts）。
//
// 怎么拉起：主进程直接 spawn `litch-computer-use.exe --parent-pid <主进程号>`，连接就是它的标准输入输出这对匿名管道，
// 标准错误只写日志（转进 [computer-use] 日志）。不开命名管道、不开端口，别的进程连不上它，所以不要 macOS 那套
// 对端验签和一次性令牌。理由：Windows 上同一用户的任何进程本来就能调 SendInput、UIA、截屏，助手没有多出来的系统权限，
// 能被保护的只有“Litch 的审批”这一层，而这一层在主进程里。
//
// 主进程没了助手跟着走：Node 在 Windows 上拉起的非 detached 子进程挂在 libuv 的作业对象上（KILL_ON_JOB_CLOSE）；
// 助手自己还盯着 --parent-pid 和标准输入的结尾，作为兜底。助手 60 秒没有请求自己退出，下一次用到时再起（onDemand）。
// 单实例由助手自己用命名互斥量守着：两个 Litch 各起一个时，后起的那个握手前就退出，这边报“没起来”。
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { childChannel, HelperClient } from './helper-client.mjs'
import type { HelperLauncher } from './supervisor.mjs'
import { HELPER_PROTOCOL_WIN, HelperError, isWinHello, type WinHelloResult } from './wire.mjs'

export interface WinLauncherOptions {
  /** litch-computer-use.exe 的路径 */
  exePath: string
  /** 期望的助手版本（Litch 的版本）；null 表示不比 */
  version: string | null
  /** 交给助手盯着的父进程号，默认是这个进程 */
  parentPid?: number
  /** 测试用：替换 spawn（在 macOS 上用 node 跑假助手） */
  spawn?(file: string, args: string[]): ChildProcessWithoutNullStreams
}

export class WinLauncher implements HelperLauncher {
  readonly respawn = 'onDemand' as const
  private readonly options: WinLauncherOptions
  /** 最近一次拉起的子进程（重启时等它退出） */
  private child: ChildProcessWithoutNullStreams | null = null

  constructor(options: WinLauncherOptions) {
    this.options = options
  }

  async establish(lang: string, log: (line: string) => void): Promise<HelperClient> {
    const { exePath } = this.options
    const args = ['--parent-pid', String(this.options.parentPid ?? process.pid)]
    const child = this.options.spawn
      ? this.options.spawn(exePath, args)
      : spawn(exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    createInterface({ input: child.stderr }).on('line', (line) => log(`助手：${line}`))
    child.stderr.on('error', () => {})

    // 起不来（文件不在、不是可执行文件）时只有 error 没有 spawn
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) =>
        reject(new HelperError('failed', `cannot start ${exePath}: ${error.message}`)),
      )
    })
    child.on('exit', (code, signal) => log(`助手进程退出了（${signal ?? code}）`))

    const client = new HelperClient(childChannel(child))
    let hello: WinHelloResult
    try {
      hello = await client.handshake<WinHelloResult>(null, lang, HELPER_PROTOCOL_WIN)
      if (!isWinHello(hello) || hello.protocol !== HELPER_PROTOCOL_WIN) {
        throw new HelperError(
          'failed',
          `${exePath} speaks protocol ${String(hello?.protocol)}, Litch needs ${HELPER_PROTOCOL_WIN} on Windows`,
        )
      }
      // 每次都是现起的自己那一份；版本对不上说明装坏了（换了文件），重拉也一样，直接报
      if (this.options.version && hello.version !== this.options.version) {
        await client.request('shutdown', {}, 2000).catch(() => {})
        throw new HelperError(
          'failed',
          `${exePath} is version ${String(hello.version)}, Litch is ${this.options.version}; reinstall Litch`,
        )
      }
    } catch (error) {
      client.close()
      throw error instanceof HelperError
        ? error
        : new HelperError('failed', `helper did not start: ${(error as Error).message}`)
    }
    log(
      `助手已就绪：进程 ${hello.pid}，版本 ${hello.version}，完整性 ${hello.integrity}，UAC ${hello.uacEnabled ? '开' : '关'}`,
    )
    return client
  }

  /** 等最近一次拉起的进程退出（最多 3 秒，过了就结束它） */
  async afterShutdown(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
