import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { cliCommand } from '../../shared/src/host-cli.mjs'
import { sleep } from '../../shared/src/util.mjs'
import { type RemoteHandlers, WebRemote } from './remote.mjs'
import { compatibilityHint, detectHostDsh, type HostDsh } from './versions.mjs'

// 关闭 dsh 默认随模型请求上传的会话日志；CHA_DSH_SESSION_LOG=1 时保留 dsh 默认行为。
const SESSION_LOG_OFF = '- id: session-log-deepseek\n  config:\n    enabled: false\n'
const redact = (text: string) => text.replace(/token=[\w-]+/g, 'token=<已隐去>')

/**
 * dsh 自己的配置目录（DSH_HOME）：和用户自己用 dsh 时是同一份，登录、密钥、模型、MCP、会话都共用。
 * 用户设了 DSH_HOME 就用它（只有空白的当没设，和 dsh 自己的取法一样），没设是 ~/.dsh。
 * 会话日志上传照旧由起 dsh 时的 --patch 关掉（SESSION_LOG_OFF），不写进这个目录。
 */
export const dshHome = (): string => {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), '.dsh')
}

/** Litch 起的 dsh 用的 profile：和 dsh 官方的 Web、桌面端是同一个，设置、MCP 都落在它的补丁文件里 */
export const DSH_PROFILE = 'web'

/** 会话日志上传是不是被 Litch 关着（CHA_DSH_SESSION_LOG=1 时照 dsh 的默认） */
export const sessionLogForcedOff = (): boolean => process.env.CHA_DSH_SESSION_LOG !== '1'

// 关 dsh 只有发结束信号这一条路，它的 Web Remote 接口里没有“请收尾退出”的请求。它收到信号后有序收尾
//（没落盘的事件在这时落盘），平时不到 0.1 秒，系统的文件监视关得慢时要几秒；它给自己的上限是 5 秒，到点自己退出。
// 这些是对着 dsh 0.2.0-rc.2 看的和量的。
export interface ExitTiming {
  // 平时等它多久再强杀：比它自己的上限长，正常的 dsh 到这时一定自己退了，强杀只留给卡死的。
  graceMs: number
  // 适配器自己被结束信号要求退出时等多久：主进程停运行时是给整个进程组发结束信号、等 5 秒就整组强杀
  //（cmd/codex-harness-adapter/serve.go），比它短，给适配器自己的收尾留出时间。
  signalledGraceMs: number
  // 被信号要求退出时，同一个进程组里的 dsh 多半也收到了。它收场的头一件事是断开 Web Remote 的连接，
  // 信号到了之后十几毫秒；等这么久连接还在，才当它没收到、由适配器来发。
  hangupWaitMs: number
}
export const EXIT_TIMING: ExitTiming = { graceMs: 6000, signalledGraceMs: 4000, hangupWaitMs: 500 }

// 看护一个长驻的 `dsh --profile web` 子进程，所有线程共用；进程退出后下次使用时重新拉起。
// dsh 是用户自己安装的可执行文件，每次拉起前重新定位并核对版本下限。
export class DshRuntime {
  // 最近一次拉起时检测到的 dsh；尚未拉起过时为 null。
  host: HostDsh | null = null
  private readonly home: string
  private readonly handlers: RemoteHandlers
  private readonly timing: ExitTiming
  // 补丁文件里另加的部分（客户端工具的插件，见 client-tools.mts），每次拉起前现取
  private readonly extraPatch: () => Promise<string>
  private child: ChildProcess | null = null
  private starting: Promise<WebRemote> | null = null
  // 已经连上的那一条；没起、正在起、已经退出都是 null。
  private connected: WebRemote | null = null
  private closing = false
  // 正在收场的那个 dsh（见 dismiss）和它退出的那一刻；下一个要等它退干净才起。
  private leaving: { child: ChildProcess; exited: Promise<void> } | null = null

  constructor(
    home: string,
    handlers: RemoteHandlers,
    timing: ExitTiming = EXIT_TIMING,
    extraPatch: () => Promise<string> = async () => '',
  ) {
    this.home = home
    this.handlers = handlers
    this.timing = timing
    this.extraPatch = extraPatch
    process.once('exit', () => {
      this.child?.kill('SIGKILL')
      this.leaving?.child.kill('SIGKILL')
    })
  }

  remote(): Promise<WebRemote> {
    if (this.closing) return Promise.reject(new Error('适配器正在关闭'))
    this.starting ??= this.start().catch((error) => {
      this.starting = null
      throw error
    })
    return this.starting
  }

  /** 现成的连接，没有就是 null：只想顺便问一句、不值得为此把 dsh 拉起来的地方用 */
  current(): WebRemote | null {
    return this.connected
  }

  private async start(): Promise<WebRemote> {
    // 上一个还在收场的话等它退干净：不让两个 dsh 同时用同一份状态目录。
    await this.leaving?.exited
    if (this.closing) throw new Error('适配器正在关闭')
    // 用户的 DSH_HOME 由 dsh 自己建（照它的权限），这里只建适配器自己的工作目录
    const nativeHome = dshHome()
    const workdir = join(this.home, 'dsh-runtime')
    mkdirSync(workdir, { recursive: true, mode: 0o700 })
    const host = detectHostDsh()
    this.host = host
    if (!host.verified)
      console.error(`[dsh] 这个版本的 dsh 尚未验证，如遇异常：${compatibilityHint(host.version)}`)
    // 启动器选项（--patch）必须写在 profile 自己的选项之前。
    const args = ['--profile', DSH_PROFILE]
    const patchText = (sessionLogForcedOff() ? SESSION_LOG_OFF : '') + (await this.extraPatch())
    if (patchText) {
      // 补丁里有客户端工具插件的连接令牌：只有属主读得到
      const patch = join(this.home, 'dsh.patch.yml')
      writeFileSync(patch, patchText, { mode: 0o600 })
      chmodSync(patch, 0o600)
      args.push('--patch', patch)
    }
    args.push('--no-open', '--port', '0')
    const [command, ...commandArgs] = cliCommand(host.cli, args)
    const child = spawn(command as string, commandArgs, {
      cwd: workdir,
      env: {
        ...process.env,
        DSH_HOME: nativeHome,
        DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
      process.stderr.write(redact(chunk.toString()))
    })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.starting = null
      this.connected = null
    })
    // 就绪行带一次性令牌：只在内存里解析，标准输出一律不转写到日志。
    const launchUrl = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(
        () =>
          reject(
            new Error(`dsh 启动后没有给出 Web 入口地址（${compatibilityHint(host.version)}）`),
          ),
        60000,
      )
      child.stdout.on('data', (chunk: Buffer) => {
        if (output.length > 65536) return
        output += chunk.toString()
        const url = /dsh web: (http:\/\/\S+)/.exec(output)?.[1]
        if (!url) return
        clearTimeout(timer)
        resolve(url)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`无法启动 dsh: ${error.message}`))
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`dsh 提前退出（${code}）: ${redact(stderr).trim().slice(-600)}`))
      })
    }).catch((error) => {
      child.kill('SIGKILL')
      throw error
    })
    const remote = await WebRemote.connect(launchUrl, host.version, {
      waterfall: this.handlers.waterfall,
      emit: this.handlers.emit,
      closed: (error) => {
        // 连接是 dsh 那头断的：它多半已经在收场了（自己收到了结束信号），不急着给它发信号。
        if (this.child === child) this.dismiss(child, false)
        if (!this.closing) this.handlers.closed(error)
      },
    }).catch((error) => {
      // 起来了却没连上的不留着：下一次用到会另起一个。
      if (this.child === child) this.dismiss(child, true)
      throw error
    })
    // 连的这会儿进程已经没了、或者正在收场的不算连上
    if (this.child === child && !this.closing) this.connected = remote
    return remote
  }

  // 送走一个 dsh。它只认头一个结束信号：收场途中再来一个，它丢下没做完的收尾立刻退出，刚完成的回合可能还没落盘，
  // 重读时成了被打断的。所以每个进程至多发一次，到点还没退的强杀。连接是它那头断的（signal 为 false）先不发、只等：
  // 它多半已经在收场。等过了它自己的收场上限还在，那就不是在收场（连接断了、进程还好好的），这时才发那一次，再等一轮。
  private dismiss(child: ChildProcess, signal: boolean): void {
    this.child = null
    this.starting = null
    this.connected = null
    const kill = () => child.kill('SIGKILL')
    let timer = setTimeout(
      signal
        ? kill
        : () => {
            child.kill('SIGTERM')
            timer = setTimeout(kill, this.timing.graceMs)
          },
      this.timing.graceMs,
    )
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('exit', () => resolve())
    }).then(() => {
      clearTimeout(timer)
      if (this.leaving?.child === child) this.leaving = null
    })
    this.leaving = { child, exited }
    if (signal) child.kill('SIGTERM')
  }

  // signalled：适配器是被结束信号要求退出的（时限和要不要自己发信号都不一样，见 ExitTiming）。
  async close(signalled = false): Promise<void> {
    this.closing = true
    this.connected = null
    const remote = await this.starting?.catch(() => null)
    const began = Date.now()
    const child = this.child
    // 等 dsh 自己断开连接：断了（或者退了）它就不再是 this.child。
    if (child && signalled)
      for (let waited = 0; waited < this.timing.hangupWaitMs && this.child === child; waited += 10)
        await sleep(10)
    remote?.close()
    if (child && this.child === child) this.dismiss(child, true)
    const leaving = this.leaving
    if (!leaving) return
    const graceMs = signalled ? this.timing.signalledGraceMs : this.timing.graceMs
    const timer = setTimeout(
      () => leaving.child.kill('SIGKILL'),
      Math.max(0, graceMs - (Date.now() - began)),
    )
    await leaving.exited
    clearTimeout(timer)
  }
}
