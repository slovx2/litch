// 一次登录（provider 的 auth/start、MCP 的 mcp/login）的进程：把 Pi 登录流程里的通知和提问接成协议的 auth 步骤。
// 流程走到要用户做事的地方（打开链接、看设备码、填东西）或结束时“停稳”一次：有请求在等（auth/start、
// auth/continue）就作为应答交给它，没有就经 auth/updated 通知声明过 harnessConfig 的连接。
import { randomUUID } from 'node:crypto'
import type {
  HarnessAuthField,
  HarnessAuthStep,
  HarnessText,
} from '../../protocol/src/harness-config.mjs'
import { fail, t } from './harness-common.mjs'

/** 一个流程最长等多久（用户迟迟不授权、回调一直不来），到了按失败收场 */
const ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000
/** 结束了的登录再留一会儿，晚到的 auth/continue、auth/cancel 还认得它 */
const LINGER_MS = 60 * 1000
/** 通知之后紧跟着的提问（打开链接后的“也可以粘贴回调地址”）并成一步，等这么久再停稳 */
const SETTLE_MS = 30

const attempts = new Map<string, AuthAttempt>()

interface Pending {
  fields: HarnessAuthField[]
  resolve(inputs: Record<string, string>): void
  reject(error: Error): void
}

/** 回调到设备回环地址的授权链接：回调的端口（客户端要把它转发到设备上）；不是回环的是 null */
export function callbackPort(url: string): number | null {
  try {
    const redirect = new URL(url).searchParams.get('redirect_uri')
    if (!redirect) return null
    const target = new URL(redirect)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return null
    return Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
  } catch {
    return null
  }
}

export const plain = (message: string): HarnessText => t(message, message)

export class AuthAttempt {
  readonly id = randomUUID()
  readonly controller = new AbortController()
  private step: HarnessAuthStep | undefined
  private pending: Pending | undefined
  private waiters: Array<(step: HarnessAuthStep) => void> = []
  private settleTimer: NodeJS.Timeout | undefined
  private notes: string[] = []
  private finished = false
  private readonly timeout: NodeJS.Timeout
  private readonly announce: (step: HarnessAuthStep) => void

  /** announce：没有请求在等时，怎么把停稳的一步告诉客户端（auth/updated） */
  constructor(announce: (step: HarnessAuthStep) => void) {
    this.announce = announce
    attempts.set(this.id, this)
    this.timeout = setTimeout(
      () => this.controller.abort(new Error('登录超时')),
      ATTEMPT_TIMEOUT_MS,
    ).unref()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** 补充说明（Pi 的 info 通知），并进下一步的 message 里 */
  note(message: string): void {
    this.notes.push(message)
  }

  private message(extra?: string): HarnessText | null {
    const all = [...this.notes.splice(0), ...(extra ? [extra] : [])].join('\n')
    return all ? plain(all) : null
  }

  openUrl(url: string, instructions?: string): void {
    this.show({
      kind: 'openUrl',
      url,
      callbackPort: callbackPort(url),
      message: this.message(instructions),
    })
  }

  deviceCode(url: string, userCode: string): void {
    this.show({ kind: 'deviceCode', url, userCode, message: this.message() })
  }

  /** 要用户填东西：紧跟在打开链接之后的并进那一步（可以粘贴回调地址），否则单独一步 */
  ask(
    fields: HarnessAuthField[],
    message: string,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    if (this.finished) return Promise.reject(new Error('登录已经结束'))
    return new Promise((resolve, reject) => {
      const pending: Pending = { fields, resolve, reject }
      this.pending = pending
      const current = this.step
      if (current?.kind === 'openUrl' && !current.prompt && this.settleTimer)
        this.show({ ...current, prompt: fields })
      else this.show({ kind: 'prompt', fields, message: this.message(message) })
      // 流程那头不再要这个答案了（浏览器回调先到了）：撤掉这一问
      signal?.addEventListener(
        'abort',
        () => {
          if (this.pending !== pending) return
          this.pending = undefined
          reject(new Error('Login cancelled'))
          if (this.step?.kind === 'openUrl') {
            const { prompt: _dropped, ...rest } = this.step
            this.step = rest
          }
        },
        { once: true },
      )
    })
  }

  finish(step: Extract<HarnessAuthStep, { kind: 'done' | 'failed' }>): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timeout)
    this.pending?.reject(new Error('Login cancelled'))
    this.pending = undefined
    this.show(step)
    setTimeout(() => attempts.delete(this.id), LINGER_MS).unref()
  }

  private show(step: HarnessAuthStep): void {
    this.step = step
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => this.settle(), SETTLE_MS)
  }

  private settle(): void {
    this.settleTimer = undefined
    const step = this.step
    if (!step) return
    const waiters = this.waiters.splice(0)
    if (waiters.length) for (const waiter of waiters) waiter(step)
    else this.announce(step)
  }

  /** 等下一次停稳。auth/start 在流程开始之前调，auth/continue 在交答案之前调 */
  next(): Promise<HarnessAuthStep> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** auth/continue：交上这一问要的东西，等流程走到下一步 */
  async answer(inputs: Record<string, string>): Promise<HarnessAuthStep> {
    const pending = this.pending
    if (!pending) {
      if (this.finished && this.step) return this.step
      fail('invalidValue', '这一步不需要填东西', 'This step does not take any input')
    }
    const values: Record<string, string> = {}
    for (const field of pending.fields) {
      const value = typeof inputs?.[field.id] === 'string' ? inputs[field.id]!.trim() : ''
      if (!value && !field.optional)
        fail(
          'invalidValue',
          `${field.title['zh-CN']} 不能为空`,
          `${field.title.en} is required`,
          field.id,
        )
      values[field.id] = value
    }
    this.pending = undefined
    const next = this.next()
    pending.resolve(values)
    return next
  }

  cancel(): void {
    this.controller.abort(new Error('Login cancelled'))
  }
}

export function attempt(id: unknown): AuthAttempt {
  const found = typeof id === 'string' ? attempts.get(id) : undefined
  if (!found) fail('notFound', `没有登录 ${String(id)}`, `No sign-in ${String(id)}`)
  return found
}

/** 登录流程失败或被取消时给人看的话 */
export function failure(error: unknown, signal: AbortSignal): HarnessText {
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : ''
    return reason === '登录超时'
      ? t('登录超时', 'Sign-in timed out')
      : t('登录已取消', 'Sign-in cancelled')
  }
  const message = error instanceof Error ? error.message : String(error)
  return t(`登录失败：${message}`, `Sign-in failed: ${message}`)
}
