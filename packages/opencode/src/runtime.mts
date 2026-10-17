import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { cliCommand } from '../../shared/src/host-cli.mjs'
import { sleep } from '../../shared/src/util.mjs'
import { OpencodeApi } from './api.mjs'
import { assertOpencodeVersion } from './host-opencode.mjs'
import { compatibilityHint, detectHostOpencode, type HostOpencode, versions } from './versions.mjs'

export interface RuntimeHandlers {
  /** /global/event 上的一条事件：directory 是它所属的目录实例（全局事件是 null） */
  event(directory: string | null, payload: any): void
  /** 事件流断过又接上了：SSE 没有事件号、不能续传，断开期间漏掉的要由调用方按会话重拉补齐 */
  resync(): void
  /** serve 进程退出了（不是适配器自己要关的） */
  closed(error: Error): void
}

export interface ExitTiming {
  // 平时等 serve 退出多久再强杀
  graceMs: number
  // 适配器自己被结束信号要求退出时等多久：主进程停运行时整组发结束信号、等 5 秒就整组强杀
  //（cmd/codex-harness-adapter/serve.go），比它短，给适配器自己的收尾留出时间。
  signalledGraceMs: number
  // 事件流多久没有任何数据就当它断了（serve 每 10 秒发一次心跳）
  idleMs: number
}
export const EXIT_TIMING: ExitTiming = { graceMs: 6000, signalledGraceMs: 4000, idleMs: 30000 }

const redact = (text: string) => text.replace(/(password|token)=\S+/gi, '$1=<已隐去>')

// 看护一个长驻的 `opencode serve` 子进程，所有线程、所有目录共用；第一次要用时才拉起，进程退出后下次使用时重新拉起。
// OpenCode 是用户自己安装的可执行文件，每次拉起前重新定位并核对版本下限；拉起后再用 /global/health 报的版本核一次
//（PATH 上的和真正跑起来的可能不是同一个）。
export class OpencodeRuntime {
  // 最近一次拉起时检测到的 OpenCode；尚未拉起过时为 null。
  host: HostOpencode | null = null
  private readonly home: string
  private readonly handlers: RuntimeHandlers
  private readonly timing: ExitTiming
  private child: ChildProcess | null = null
  private starting: Promise<OpencodeApi> | null = null
  private connected: OpencodeApi | null = null
  private stream: AbortController | null = null
  private closing = false

  constructor(home: string, handlers: RuntimeHandlers, timing: ExitTiming = EXIT_TIMING) {
    this.home = home
    this.handlers = handlers
    this.timing = timing
    process.once('exit', () => this.child?.kill('SIGKILL'))
  }

  api(): Promise<OpencodeApi> {
    if (this.closing) return Promise.reject(new Error('适配器正在关闭'))
    this.starting ??= this.start().catch((error) => {
      this.starting = null
      throw error
    })
    return this.starting
  }

  /** 现成的连接，没有就是 null：只想顺便问一句、不值得为此把 serve 拉起来的地方用 */
  current(): OpencodeApi | null {
    return this.connected
  }

  private async start(): Promise<OpencodeApi> {
    if (this.closing) throw new Error('适配器正在关闭')
    const host = detectHostOpencode()
    this.host = host
    if (!host.verified)
      console.error(
        `[opencode] 这个版本的 OpenCode 尚未验证，如遇异常：${compatibilityHint(host.version)}`,
      )
    // serve 的工作目录放在适配器的状态目录下：不带目录的请求落在这里，不碰用户的项目。
    const workdir = join(this.home, 'runtime')
    mkdirSync(workdir, { recursive: true, mode: 0o700 })
    const password = randomBytes(24).toString('base64url')
    const [command, ...args] = cliCommand(host.cli, [
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
    ])
    const child = spawn(command as string, args, {
      cwd: workdir,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: 'opencode',
        // 提问工具只对它自己的几种客户端默认开着；经适配器来的客户端也能答题，明确打开。
        OPENCODE_ENABLE_QUESTION_TOOL: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    const guard = watchdog(child.pid)
    child.once('exit', () => guard?.kill('SIGKILL'))
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
      process.stderr.write(redact(chunk.toString()))
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.starting = null
      this.connected = null
      this.stream?.abort()
      if (!this.closing) this.handlers.closed(new Error(`OpenCode 进程已退出（${signal ?? code}）`))
    })
    try {
      const url = await this.listening(child, () => stderr)
      const api = new OpencodeApi(url, password, host.version)
      const health = await api.request('GET', '/global/health', { timeoutMs: 15000 })
      // 真正跑起来的那个也得过下限：报不出版本的当作不兼容
      assertOpencodeVersion(
        health?.version,
        versions.opencodeMinimum,
        `serve 报告 ${health?.version}`,
      )
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`OpenCode 的事件流没有就绪（${compatibilityHint(host.version)}）`)),
          15000,
        )
        void this.listen(api, child, () => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (this.child === child && !this.closing) this.connected = api
      return api
    } catch (error) {
      // 起来了却没连上的不留着：下一次用到会另起一个。
      if (this.child === child) {
        this.child = null
        this.stream?.abort()
      }
      child.kill('SIGKILL')
      throw error
    }
  }

  // 就绪行：`opencode server listening on http://127.0.0.1:端口`。只在内存里解析，标准输出不转写。
  private listening(child: ChildProcess, stderr: () => string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('OpenCode 启动后没有给出监听地址')), 60000)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (output.length > 65536) return
        output += chunk.toString()
        const url = /listening on (http:\/\/\S+)/.exec(output)?.[1]
        if (!url) return
        clearTimeout(timer)
        resolve(url)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`无法启动 OpenCode: ${error.message}`))
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`OpenCode 提前退出（${code}）: ${redact(stderr()).trim().slice(-600)}`))
      })
    })
  }

  // 订阅 /global/event，断了就重连；第一次连上（收到 server.connected）时调用 ready，之后每次重连上都让调用方补齐。
  private async listen(api: OpencodeApi, child: ChildProcess, ready: () => void): Promise<void> {
    let first = true
    let attempt = 0
    while (this.child === child && !this.closing) {
      const controller = new AbortController()
      this.stream = controller
      let timer: NodeJS.Timeout | undefined
      const alive = () => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), this.timing.idleMs)
      }
      try {
        alive()
        const response = await fetch(`${api.url}/global/event`, {
          headers: api.headers(),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        for await (const frame of frames(response.body, alive)) {
          const payload = frame?.payload
          if (!payload || typeof payload.type !== 'string') continue
          if (payload.type === 'server.connected') {
            attempt = 0
            if (first) ready()
            else this.handlers.resync()
            first = false
            continue
          }
          if (payload.type === 'server.heartbeat' || payload.type === 'sync') continue
          try {
            this.handlers.event(
              typeof frame.directory === 'string' ? frame.directory : null,
              payload,
            )
          } catch (error) {
            console.error(`[opencode] 处理事件 ${payload.type} 出错: ${(error as Error).message}`)
          }
        }
      } catch {}
      clearTimeout(timer)
      if (this.child !== child || this.closing) return
      await sleep(Math.min(2000, 100 * 2 ** attempt++))
    }
  }

  // signalled：适配器是被结束信号要求退出的（同一个进程组里的 serve 多半也收到了），等得短一些。
  async close(signalled = false): Promise<void> {
    this.closing = true
    const api = this.connected
    this.connected = null
    await this.starting?.catch(() => null)
    this.stream?.abort()
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // 先请它把各目录实例收拾掉（会停掉还在跑的回合和工具进程），再发结束信号；到点还没退的强杀。
    if (api && !signalled)
      await api.request('POST', '/global/dispose', { timeoutMs: 1500 }).catch(() => null)
    child.kill('SIGTERM')
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      signalled ? this.timing.signalledGraceMs : this.timing.graceMs,
    )
    await exited
    clearTimeout(timer)
  }
}

// 入口被强杀（SIGKILL、崩溃）时收不了场，serve 会一直留着（它不看标准输入，也不管父进程在不在）。
// 旁边起一个极小的 sh 看着它：sh 的标准输入是入口这头的管道，入口一没、管道读到结尾，sh 就结束 serve，
// 到点还没退的强杀。serve 退了（正常收场也一样）就把 sh 停掉。这个管道不拦着入口退出。
function watchdog(pid: number | undefined): ChildProcess | null {
  if (!pid || process.platform === 'win32') return null
  try {
    const guard = spawn(
      '/bin/sh',
      [
        '-c',
        'read _; kill -TERM "$1" 2>/dev/null; sleep 4; kill -KILL "$1" 2>/dev/null',
        'opencode-guard',
        String(pid),
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    )
    guard.on('error', () => {})
    guard.stdin?.on('error', () => {})
    ;(guard.stdin as any)?.unref?.()
    guard.unref()
    return guard
  } catch {
    return null
  }
}

// SSE 的帧：空行分隔，每帧里的 data: 行拼起来是一段 JSON。每收到一段数据就调一次 alive。
async function* frames(body: ReadableStream<Uint8Array>, alive: () => void): AsyncGenerator<any> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    alive()
    buffer += decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) {
        try {
          yield JSON.parse(data)
        } catch {}
      }
      index = buffer.indexOf('\n\n')
    }
  }
}
