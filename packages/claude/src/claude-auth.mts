// Anthropic 账号登录：子进程跑 `claude auth login`（订阅加 --claudeai，Console 加 --console）。
// CLI 不在终端里时会打印一条手动授权的链接，从标准输入读 `code#state`：用户在自己的浏览器里打开链接、
// 授权后把页面上给的码粘回来，设备在不在本机都一样（不用回调到设备的 127.0.0.1）。
// 凭据由 CLI 自己存（macOS 钥匙串，其他系统 <配置目录>/.credentials.json）。
// 状态用 `claude auth status --json`，登出 `claude auth logout`。
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { cliCommand } from '../../shared/src/host-cli.mjs'
import { hostClaudeExecutable } from './host-claude.mjs'
import { newId } from './util.mjs'

export interface ClaudeAuthStatus {
  loggedIn: boolean
  /** none、claude.ai、oauth_token、api_key、api_key_helper、third_party */
  authMethod: string
  apiKeySource: string | null
  email: string | null
  orgName: string | null
  subscriptionType: string | null
}

export type LoginMode = 'claudeai' | 'console'

/** 一次登录的结局：成功、失败（带 CLI 的原话）、被取消 */
export type LoginOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }

function cliArgs(args: string[], env: NodeJS.ProcessEnv): [string, string[]] {
  const [command, ...rest] = cliCommand(hostClaudeExecutable(env), args)
  return [command!, rest]
}

// 不让 CLI 在设备上开浏览器：链接交给客户端在用户那边打开。CLI 用 $BROWSER 打开链接，`true` 什么也不做；
// Windows 上没有 `true`，给一个不存在的命令，CLI 打不开就算了，照样等粘贴的码
function loginEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, BROWSER: process.platform === 'win32' ? 'litch-no-browser' : 'true' }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function claudeAuthStatus(env: NodeJS.ProcessEnv): Promise<ClaudeAuthStatus> {
  const [command, args] = cliArgs(['auth', 'status', '--json'], env)
  return new Promise((resolve, reject) => {
    // 没登录时 CLI 以 1 退出，输出照样是 JSON
    execFile(command, args, { env, timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(stdout)
      } catch {
        reject(new Error((stderr || error?.message || 'claude auth status 没有输出').trim()))
        return
      }
      resolve({
        loggedIn: parsed.loggedIn === true,
        authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : 'none',
        apiKeySource: stringOrNull(parsed.apiKeySource),
        email: stringOrNull(parsed.email),
        orgName: stringOrNull(parsed.orgName),
        subscriptionType: stringOrNull(parsed.subscriptionType),
      })
    })
  })
}

export function claudeAuthLogout(env: NodeJS.ProcessEnv): Promise<void> {
  const [command, args] = cliArgs(['auth', 'logout'], env)
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()))
      else resolve()
    })
  })
}

const URL_PATTERN = /visit:\s*(https:\/\/\S+)/
const LOGIN_TIMEOUT_MS = 15 * 60_000

/**
 * 进行中的一次登录。start() 等 CLI 打出授权链接；submit() 把粘贴的码交给它并等结局。
 * 结局（成功、失败、超时、取消）只报一次，经 onSettled 告诉调用方。
 */
export class ClaudeLoginAttempt {
  readonly id = newId()
  readonly mode: LoginMode
  private child: ChildProcessWithoutNullStreams | null = null
  private stdout = ''
  private stderr = ''
  private settled: LoginOutcome | null = null
  private readonly waiters: Array<(outcome: LoginOutcome) => void> = []
  private timer: NodeJS.Timeout | null = null
  onSettled: ((outcome: LoginOutcome) => void) | null = null

  constructor(mode: LoginMode) {
    this.mode = mode
  }

  get outcome(): LoginOutcome | null {
    return this.settled
  }

  /** 起 CLI，等它打出授权链接（最多 urlTimeoutMs） */
  start(env: NodeJS.ProcessEnv, urlTimeoutMs = 30_000): Promise<string> {
    const childEnv = loginEnv(env)
    const [command, args] = cliArgs(['auth', 'login', `--${this.mode}`], childEnv)
    const child = spawn(command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.timer = setTimeout(
      () => this.finish({ kind: 'failed', message: '登录超时' }),
      LOGIN_TIMEOUT_MS,
    )
    this.timer.unref()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
    })
    child.on('error', (error) => this.finish({ kind: 'failed', message: error.message }))
    child.on('exit', (code) => {
      if (code === 0) this.finish({ kind: 'done' })
      else this.finish({ kind: 'failed', message: this.failureText(code) })
    })
    return new Promise((resolve, reject) => {
      const urlTimer = setTimeout(() => {
        this.cancel()
        reject(new Error('claude auth login 没有给出授权链接'))
      }, urlTimeoutMs)
      const onData = (chunk: string) => {
        this.stdout += chunk
        const match = URL_PATTERN.exec(this.stdout)
        if (!match) return
        clearTimeout(urlTimer)
        child.stdout.off('data', onData)
        child.stdout.on('data', (more: string) => {
          this.stdout += more
        })
        resolve(match[1]!)
      }
      child.stdout.on('data', onData)
      this.waitOutcome().then((outcome) => {
        clearTimeout(urlTimer)
        if (outcome.kind === 'failed') reject(new Error(outcome.message))
        else if (outcome.kind === 'cancelled') reject(new Error('登录已取消'))
      })
    })
  }

  /** 交上粘贴的 `code#state`，等 CLI 换完令牌退出（最多 timeoutMs）。格式不对直接回 null，CLI 那边不动 */
  async submit(code: string, timeoutMs = 60_000): Promise<LoginOutcome | null> {
    const trimmed = code.trim()
    const [left, right] = trimmed.split('#')
    if (!left || !right || /\s/.test(trimmed)) return null
    if (this.settled) return this.settled
    const child = this.child
    if (!child) return { kind: 'failed', message: '登录还没开始' }
    const before = this.stderr.length
    child.stdin.write(`${trimmed}\n`)
    let timer: NodeJS.Timeout | undefined
    let check: (() => void) | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    // CLI 认为码不完整时只在 stderr 说一句、接着等：那种情况按格式不对处理
    const invalid = new Promise<'invalid'>((resolve) => {
      check = () => {
        if (/Invalid code/.test(this.stderr.slice(before))) resolve('invalid')
      }
      child.stderr.on('data', check)
    })
    try {
      const result = await Promise.race([this.waitOutcome(), timeout, invalid])
      if (result === 'invalid') return null
      if (result === 'timeout') {
        this.finish({ kind: 'failed', message: '等 claude auth login 换取令牌超时' })
        return this.settled
      }
      return result
    } finally {
      clearTimeout(timer)
      if (check) child.stderr.off('data', check)
    }
  }

  cancel(): void {
    this.finish({ kind: 'cancelled' })
  }

  private waitOutcome(): Promise<LoginOutcome> {
    if (this.settled) return Promise.resolve(this.settled)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private failureText(code: number | null): string {
    const text = this.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^Invalid code/.test(line))
      .join('\n')
    return text || `claude auth login 退出码 ${code}`
  }

  private finish(outcome: LoginOutcome): void {
    if (this.settled) return
    this.settled = outcome
    if (this.timer) clearTimeout(this.timer)
    if (this.child && this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill()
    for (const waiter of this.waiters.splice(0)) waiter(outcome)
    this.onSettled?.(outcome)
  }
}
