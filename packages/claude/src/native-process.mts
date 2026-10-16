import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { debugLog } from './util.mjs'

// 控制请求超时并不等于 CLI 已停止；必须确认进程和管道关闭后才能释放审批。
export class NativeProcess {
  private child?: ChildProcessWithoutNullStreams
  private closed = false
  private exited: Promise<void> = Promise.resolve()
  private terminating: Promise<void> | undefined
  private gracefulClose = false

  private readonly threadId: string
  private readonly turnId: string

  constructor(threadId: string, turnId: string) {
    this.threadId = threadId
    this.turnId = turnId
  }

  spawn(options: SpawnOptions): SpawnedProcess {
    if (this.child) throw new Error('同一个原生回合不能启动第二个 CLI')
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./native-process-guard.mjs', import.meta.url)),
        options.command,
        ...options.args,
      ],
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    ) as ChildProcessWithoutNullStreams
    this.child = child
    const identity = child.stdio[3]
    if (!identity || !('read' in identity)) throw new Error('无法读取 CLI 进程身份')
    createInterface({ input: identity }).on('line', (line) => {
      const { childPid } = JSON.parse(line) as { childPid: number }
      debugLog('native.process.started', {
        threadId: this.threadId,
        turnId: this.turnId,
        childPid,
        guardianPid: child.pid,
      })
    })
    child.stderr.on('data', (data) => process.stderr.write(data))
    this.exited = new Promise<void>((resolve) => {
      child.once('close', () => {
        this.closed = true
        debugLog('native.process.closed', {
          threadId: this.threadId,
          turnId: this.turnId,
          childPid: child.pid,
        })
        resolve()
      })
    })
    return child
  }

  get hasExited(): boolean {
    return this.closed
  }

  async wait(milliseconds: number): Promise<boolean> {
    return succeedsWithin(this.exited, milliseconds)
  }

  allowGracefulClose(): void {
    if (this.gracefulClose || this.closed) return
    if (this.control('g')) this.gracefulClose = true
  }

  // 让守护进程记下 CLI 当前的后台命令进程；CLI 崩溃时守护进程据此清理。
  trackBackgroundProcesses(): void {
    if (!this.closed) this.control('s')
  }

  private control(flag: string): boolean {
    const control = this.child?.stdio[4]
    if (!control || !('write' in control)) return false
    control.write(flag)
    return true
  }

  async stopIfUnconfirmed(): Promise<void> {
    if (!this.gracefulClose) await this.terminate()
  }

  terminate(): Promise<void> {
    return (this.terminating ??= this.stopProcess().catch((error) => {
      // 保留进程身份与执行屏障；后续显式停止仍可重试。
      this.terminating = undefined
      throw error
    }))
  }

  private async stopProcess(): Promise<void> {
    if (!this.child || this.closed) return
    // 只通知守护进程：它先让 CLI 自己停掉后台命令并退出，再清理整个进程组。
    // 直接对进程组发信号会让 CLI 来不及收尾，后台命令变成孤儿。
    this.signal('SIGTERM', false)
    if (await this.wait(2_000)) return
    this.signal('SIGKILL', true)
    if (!(await this.wait(2_000))) throw new Error('Claude CLI 未能在期限内退出，禁止释放执行屏障')
  }

  private signal(signal: NodeJS.Signals, group: boolean): void {
    const child = this.child
    if (!child || this.closed || !child.pid) return
    try {
      if (process.platform === 'win32' || !group) child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

export async function succeedsWithin(
  work: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
