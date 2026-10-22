// 看护 ACP agent 进程：第一次要用时才起，握手（initialize），退出了收尾，下一次要用时再起一个。
import { type ChildProcess, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { takeLogDir } from '../../shared/src/log-file.mjs'
import { type ResolvedAgent, resolveAgent } from './agent.mjs'
import { AcpConnection, AcpError } from './connection.mjs'
import { type AgentCapabilities, capabilitiesOf } from './declaration.mjs'
import { versions } from './versions.mjs'

export interface AgentHandle {
  connection: AcpConnection
  caps: AgentCapabilities
  resolved: ResolvedAgent
  /** 第几个 agent 进程。会话在哪个进程里打开过按它认（进程换了，会话要重新接上） */
  generation: number
  child: ChildProcess
}

export interface RuntimeEvents {
  /** agent 反过来问我们（权限、文件、终端） */
  request(method: string, params: any, agent: AgentHandle): Promise<unknown>
  /** agent 发来的通知（session/update） */
  notification(method: string, params: any, agent: AgentHandle): void
  /** agent 进程退出了（握手成功之后的才报） */
  closed(error: Error, agent: AgentHandle): void
}

/** 握手的时限：有的 agent 起来要装载一大堆东西（Gemini CLI 冷启动要好几秒） */
const INITIALIZE_TIMEOUT_MS = 60_000
/** 收场时依次等的：关掉标准输入之后等它自己退、发结束信号之后再等，到点强杀 */
const EXIT_TIMING = {
  graceMs: 2_000,
  termMs: 2_000,
  signalledGraceMs: 1_000,
  signalledTermMs: 1_500,
}

export class AcpRuntime {
  private readonly home: string
  private readonly events: RuntimeEvents
  private readonly env: NodeJS.ProcessEnv
  private starting: Promise<AgentHandle> | null = null
  private running: AgentHandle | null = null
  private generations = 0
  /** 最近一次握手拿到的能力。进程退了也留着：声明照它报，下一次起来多半还是这样 */
  known: AgentCapabilities | null = null
  /** agent 写到标准错误的最后一段，起不来的时候带进报错里 */
  private stderrTail = ''

  constructor(home: string, events: RuntimeEvents, env: NodeJS.ProcessEnv = process.env) {
    this.home = home
    this.events = events
    this.env = env
  }

  /** 现成的 agent，没有就是 null；不为这个去起 */
  current(): AgentHandle | null {
    return this.running
  }

  /** 要用 agent：没起就起一个，等握手完 */
  agent(): Promise<AgentHandle> {
    if (this.running && !this.running.connection.closed) return Promise.resolve(this.running)
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /**
   * agent 的启动命令和标准错误，写在命令行给的日志目录（LITCH_LOG_DIR）下的 agent.log；没给就不写。
   * 大小由起它的命令行按 .log 的规矩换（复制再截断，见 cmd/codex-harness-adapter/logs.go）
   */
  private log(text: string): void {
    const directory = takeLogDir()
    if (!directory) return
    const path = join(directory, 'agent.log')
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      appendFileSync(path, text, { mode: 0o600 })
    } catch {}
  }

  private async start(): Promise<AgentHandle> {
    const resolved = resolveAgent(this.env)
    mkdirSync(this.home, { recursive: true, mode: 0o700 })
    const [command, ...args] = resolved.argv as [string, ...string[]]
    this.log(`\n[${new Date().toISOString()}] 启动 ${resolved.argv.join(' ')}\n`)
    this.stderrTail = ''
    // 和适配器同一个进程组：适配器被强杀时，命令行给整组发的信号也送到 agent
    const child = spawn(command, args, {
      cwd: this.home,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.log(chunk)
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    const generation = ++this.generations
    let handle: AgentHandle | null = null
    const connection = new AcpConnection(child.stdout as any, child.stdin as any, {
      request: (method, params) =>
        handle
          ? this.events.request(method, params, handle)
          : Promise.reject(new AcpError(-32603, '还没握手')),
      notification: (method, params) => {
        if (handle) this.events.notification(method, params, handle)
      },
    })
    const ended = new Promise<Error>((resolve) => {
      child.once('error', (error) => resolve(error))
      child.once('exit', (code, signal) =>
        resolve(
          new Error(
            `${resolved.spec.displayName} 进程已退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}）${this.tail()}`,
          ),
        ),
      )
    })
    void ended.then((error) => {
      connection.close(new AcpError(-32000, error.message))
      if (handle && this.running === handle) {
        this.running = null
        this.events.closed(error, handle)
      }
    })
    let response: any
    try {
      response = await Promise.race([
        connection.request(
          'initialize',
          {
            protocolVersion: versions.acpProtocol,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
            clientInfo: { name: 'litch', title: 'Litch', version: versions.adapter },
          },
          INITIALIZE_TIMEOUT_MS,
        ),
        ended.then((error) => {
          throw error
        }),
      ])
    } catch (error) {
      child.kill('SIGKILL')
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${resolved.spec.displayName} 没有完成 ACP 握手：${message}${this.tail()}`)
    }
    const caps = capabilitiesOf(response)
    // 协议版本只认这一个。命令行的诊断按“ACP 协议版本不符”这几个字认原因，改要两边一起改。
    if (caps.protocolVersion !== versions.acpProtocol) {
      child.kill('SIGKILL')
      throw new Error(
        `ACP 协议版本不符：适配器支持 ${versions.acpProtocol}，${resolved.spec.displayName} 回报 ${String(response?.protocolVersion)}`,
      )
    }
    this.known = caps
    handle = { connection, caps, resolved, generation, child }
    this.running = handle
    return handle
  }

  private tail(): string {
    const text = this.stderrTail.trim()
    return text ? `；标准错误的最后几行：${text.split('\n').slice(-5).join(' | ')}` : ''
  }

  /**
   * 关掉 agent：先关它的标准输入（ACP 的 agent 读到头就该自己收尾），等不到再发结束信号，最后强杀。
   * signalled：适配器自己是被结束信号要求退出的，同一组里的 agent 多半也收到了，时限短一些
   *（命令行等运行时一共 5 秒）。
   */
  async close(signalled = false): Promise<void> {
    const starting = this.starting
    if (starting) await starting.catch(() => null)
    const handle = this.running
    this.running = null
    if (!handle) return
    const { child } = handle
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // 等到点的计时器用完就清掉，不让它把适配器自己的退出拖住
    const wait = async (ms: number) => {
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<boolean>((r) => {
        timer = setTimeout(r, ms, false)
      })
      try {
        return await Promise.race([exited.then(() => true), late])
      } finally {
        clearTimeout(timer)
      }
    }
    child.stdin?.end()
    if (await wait(signalled ? EXIT_TIMING.signalledGraceMs : EXIT_TIMING.graceMs)) return
    child.kill('SIGTERM')
    if (await wait(signalled ? EXIT_TIMING.signalledTermMs : EXIT_TIMING.termMs)) return
    child.kill('SIGKILL')
    await wait(1_000)
  }
}
