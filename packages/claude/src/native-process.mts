import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { debugLog } from './util.mjs'

// 守护进程（Go，cmd/claude-process-guard）夹在入口和 CLI 之间：按进程组起 CLI、转发输入输出、
// 记下后台命令的进程身份，入口崩溃、CLI 崩溃都不留孤儿。约定写在它的 main.go 开头：
// 文件描述符 3 报 CLI 的进程号，4 是入口给的单字节指令（g、s），读到结束就是入口没了。
// 各平台的一份由 scripts/build-process-guard.mjs 编进 dist 里这个文件旁边的 process-guard/。
const GO_OS: Partial<Record<NodeJS.Platform, string>> = { win32: 'windows' }
const GO_ARCH: Partial<Record<string, string>> = { x64: 'amd64', arm64: 'arm64' }

function guardBinary(): string {
  const target = `${GO_OS[process.platform] ?? process.platform}-${GO_ARCH[process.arch] ?? process.arch}`
  const name = `claude-process-guard${process.platform === 'win32' ? '.exe' : ''}`
  const path = fileURLToPath(new URL(`./process-guard/${target}/${name}`, import.meta.url))
  if (!existsSync(path))
    throw new Error(`缺少 ${target} 的守护进程 ${path}，先在 packages/claude 下 npm run build`)
  return path
}

/**
 * 入口自己起的、还活着的 CLI：进程号 → 会话。看本机原生会话被谁占着（native-owner.mts）时，这些进程不算别人
 */
const ownProcesses = new Map<number, string>()
/** 每个会话上入口自己的 CLI 最后一次退出的时刻（毫秒）：那之前原生记录的改动是入口自己写的 */
const ownExits = new Map<string, number>()

export function ownCliPids(): ReadonlySet<number> {
  return new Set(ownProcesses.keys())
}

/** 入口此刻有没有为这个会话开着 CLI */
export function ownCliAlive(threadId: string): boolean {
  for (const owner of ownProcesses.values()) if (owner === threadId) return true
  return false
}

/** 入口自己的 CLI 最后一次在这个会话上退出的时刻（毫秒），没有过是 0 */
export function ownCliExitedAt(threadId: string): number {
  return ownExits.get(threadId) ?? 0
}

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
    const child = spawn(guardBinary(), [options.command, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams
    this.child = child
    let cliPid: number | null = null
    const identity = child.stdio[3]
    if (!identity || !('read' in identity)) throw new Error('无法读取 CLI 进程身份')
    createInterface({ input: identity }).on('line', (line) => {
      const { childPid } = JSON.parse(line) as { childPid: number }
      cliPid = childPid
      ownProcesses.set(childPid, this.threadId)
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
        if (cliPid !== null) ownProcesses.delete(cliPid)
        ownExits.set(this.threadId, Date.now())
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
