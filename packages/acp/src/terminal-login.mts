import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AcpAuthLogin } from '../../protocol/src/acp-controls.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'

const TIMING = { linkMs: 15_000, inputMs: 600_000, submitMs: 120_000 }
interface Attempt {
  id: string
  submitted: boolean
  child: ChildProcess
  done: Promise<Error | null>
  stop(reason: Error): void
  submitting(): void
}

/** 只运行官方终端登录，不探测浏览器、不记录 URL 或授权码。 */
export class TerminalLogin {
  private active: Attempt | null = null
  private readonly spawn: () => ChildProcess
  private readonly timing: typeof TIMING

  constructor(spawn: () => ChildProcess, timing = TIMING) {
    this.spawn = spawn
    this.timing = timing
  }

  async start(): Promise<AcpAuthLogin> {
    if (this.active) throw new ProtocolError(-32004, '已有 agy 登录正在进行')
    const child = this.spawn()
    const id = randomUUID()
    let settle!: (error: Error | null) => void
    const done = new Promise<Error | null>((resolve) => {
      settle = resolve
    })
    let giveUrl!: (url: string) => void
    let failUrl!: (error: Error) => void
    const url = new Promise<string>((resolve, reject) => {
      giveUrl = resolve
      failUrl = reject
    })
    let ended = false
    let found = false
    let timer: NodeJS.Timeout
    let killTimer: NodeJS.Timeout | undefined
    const finish = (error: Error | null) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      if (this.active?.id === id) this.active = null
      failUrl(error ?? new Error('agy 未返回登录链接'))
      settle(error)
    }
    const stop = (reason: Error) => {
      if (ended) return
      finish(reason)
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
      killTimer.unref()
    }
    const arm = (ms: number, message: string) => {
      clearTimeout(timer)
      timer = setTimeout(() => stop(new Error(message)), ms)
    }
    const attempt: Attempt = {
      id,
      child,
      done,
      stop,
      submitted: false,
      submitting: () => arm(this.timing.submitMs, 'agy 登录等待超时'),
    }
    this.active = attempt
    child.once('error', () => finish(new Error('agy 登录进程无法启动')))
    child.once('close', (code) => {
      clearTimeout(killTimer)
      finish(
        code === 0 && attempt.submitted
          ? null
          : new Error(`agy 登录失败（退出码 ${String(code)}）`),
      )
    })
    child.stdin?.on('error', () => stop(new Error('agy 登录进程已关闭输入')))
    // 按流分别缓冲，整行到了才提取链接，避免把分块 URL 提前送到客户端。
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = ''
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => {
        if (found || ended) return
        buffer = (buffer + chunk).slice(-32_768)
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          const match = /^https:\/\/accounts\.google\.com\/\S+$/.exec(line)
          if (!match) continue
          found = true
          arm(this.timing.inputMs, 'agy 登录等待回填超时，请重新开始')
          giveUrl(match[0])
          return
        }
      })
    }
    arm(this.timing.linkMs, 'agy 登录链接生成超时')
    return {
      attemptId: id,
      url: await url,
      prompt: { id: 'authorizationCode', title: '授权码或回调 URL', secret: false },
    }
  }

  async submit(id: string, code: string): Promise<void> {
    const attempt = this.active
    if (!attempt || attempt.id !== id) throw new ProtocolError(-32602, 'agy 登录已失效，请重新开始')
    if (attempt.submitted) throw new ProtocolError(-32004, '授权码已提交')
    const value = code.trim()
    if (!value || value.length > 16_384 || /[\r\n\0]/.test(value))
      throw new ProtocolError(-32602, '请输入一行授权码或完整回调 URL')
    attempt.submitted = true
    attempt.submitting()
    attempt.child.stdin?.end(`${value}\n`)
    const error = await attempt.done
    if (error) throw error
  }

  cancel(id: string): void {
    if (this.active?.id === id) this.active.stop(new Error('agy 登录已取消'))
  }

  close(): void {
    this.active?.stop(new Error('agy 登录已取消'))
  }
}
