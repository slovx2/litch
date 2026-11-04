import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { BootstrapFrame, inputConfig, outputConfig } from './bootstrap.mjs'

export type WireEvent = Record<string, any>
export interface RuntimeOptions {
  executable: string
  args?: string[]
  home: string
  config: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  event: (event: WireEvent) => void
  failed: (error: Error) => void
}

export class LocalHarness {
  private child: ChildProcessWithoutNullStreams | null = null
  private socket: WebSocket | null = null
  private closing: Promise<void> | null = null
  private failure: Error | null = null
  private failStartup: ((error: Error) => void) | null = null
  private ready = false
  private readonly options: RuntimeOptions
  constructor(options: RuntimeOptions) {
    this.options = options
  }

  async start(): Promise<WireEvent> {
    const { options } = this
    const storage = join(options.home, 'storage')
    await mkdir(storage, { recursive: true, mode: 0o700 })
    // 用户真实 HOME 不传给 SDK：设置、凭据和历史全部属于这个引擎。
    // key 经初始化消息提供；不继承其他 harness 或 Google 的登录环境。
    const childHome = join(options.home, 'runtime-home')
    await mkdir(childHome, { recursive: true, mode: 0o700 })
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TMPDIR: process.env.TMPDIR,
      ...options.env,
      HOME: childHome,
      USERPROFILE: childHome,
      XDG_CONFIG_HOME: join(childHome, '.config'),
      XDG_CACHE_HOME: join(childHome, '.cache'),
    }
    const child = spawn(options.executable, options.args ?? [], {
      cwd: childHome,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    this.child = child
    // stderr 可能包含服务端返回的请求正文或 key；不转发、不落盘。
    child.stderr.resume()
    child.on('error', () => this.fail(new Error('无法启动 localharness，请检查安装路径与执行权限')))
    child.on('exit', () => this.fail(new Error('localharness 已退出；请检查鉴权和固定版本安装')))
    child.stdin.on('error', () => this.fail(new Error('localharness 启动通道已关闭')))
    const timeout = options.timeoutMs ?? 30000
    let timer: NodeJS.Timeout | undefined
    try {
      return await new Promise<WireEvent>((resolve, reject) => {
        this.failStartup = reject
        timer = setTimeout(
          () => this.fail(new Error('localharness 握手超时，请重试或重新安装')),
          timeout,
        )
        const decoder = new BootstrapFrame()
        const onData = (chunk: Buffer) => {
          try {
            const payload = decoder.push(chunk)
            if (!payload) return
            child.stdout.off('data', onData)
            child.stdout.resume()
            const { port, token } = outputConfig(payload)
            const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
              headers: { 'x-goog-api-key': token },
              maxPayload: 16 * 1024 * 1024,
              handshakeTimeout: timeout,
            })
            this.socket = ws
            ws.on('error', () => this.fail(new Error('localharness WebSocket 连接失败')))
            ws.on('close', () => this.fail(new Error('localharness 连接已断开')))
            ws.on('open', () => this.send({ config: options.config }))
            ws.on('message', (raw) => {
              try {
                const event = JSON.parse(raw.toString()) as WireEvent
                if (!event || typeof event !== 'object' || Array.isArray(event))
                  throw new Error('localharness 返回了无效消息')
                if (!this.ready) {
                  const response = event.initializeConversationResponse
                  if (!response?.cascadeId)
                    throw new Error('localharness 会话初始化失败，请检查鉴权与版本')
                  this.ready = true
                  this.failStartup = null
                  resolve(response)
                } else options.event(event)
              } catch (error) {
                this.fail(error instanceof Error ? error : new Error('localharness 消息无效'))
              }
            })
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error('localharness 引导失败'))
          }
        }
        child.stdout.on('data', onData)
        child.stdin.write(inputConfig(storage))
      })
    } catch (error) {
      await this.close()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  send(message: WireEvent): void {
    if (this.failure || this.closing || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('localharness 尚未连接或已关闭')
    this.socket.send(JSON.stringify(message))
  }
  private fail(error: Error): void {
    if (this.failure || this.closing) return
    this.failure = error
    this.failStartup?.(error)
    if (this.ready) this.options.failed(error)
    void this.close()
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.failStartup?.(new Error('localharness 启动已取消'))
      this.failStartup = null
      this.socket?.terminate()
      const child = this.child
      if (!child?.pid) return
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === 'win32')
            spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
              timeout: 3000,
            })
          else process.kill(-(child.pid as number), signal)
        } catch {
          /* 进程组已退出 */
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        kill('SIGKILL')
        return
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => kill('SIGKILL'), 1500)
        child.once('exit', () => {
          clearTimeout(timer)
          kill('SIGKILL')
          resolve()
        })
        kill('SIGTERM')
      })
    })()
    return this.closing
  }
}
