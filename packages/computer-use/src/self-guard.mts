// 自身访问的授权只由主进程保存。一次调用（含整批及最终观察）共用一次授权，
// 会话授权按设备和会话隔离；24 小时授权落在这台桌面的用户数据目录。
import { AsyncLocalStorage } from 'node:async_hooks'
import { COMPUTER_TOOL } from '../../automation-contracts/src/litch/client-tools-computer.mjs'
import { validateComputerActions } from './batch.mjs'
import type {
  ClientToolAnswer,
  ClientToolContext,
  ClientToolInvocation,
  SelfApprovalCard,
} from './call-types.mjs'
import type { HelperAccess, HelperRequester } from './executor-shared.mjs'
import { HelperError } from './wire.mjs'

const DAY = 24 * 60 * 60 * 1000
const METHODS = new Set([
  'getAppState',
  'click',
  'typeText',
  'pressKey',
  'scroll',
  'setValue',
  'drag',
  'selectText',
])
const DENIED =
  'Access to Litch itself was not approved. The protected action was not executed. Do not use another app, tool or route to bypass this decision.'
const token = () => globalThis.crypto.randomUUID()
const keyOf = (call: ClientToolInvocation) => JSON.stringify([call.device.id, call.threadId])
interface Scope {
  call: ClientToolInvocation
  context: ClientToolContext
  approved: boolean
  generation: number
  preflightDone: boolean
}

export interface SelfGuardOptions {
  productName: string
  storage?: { read(): number | null; write(expiresAt: number | null): void }
  now?(): number
  remote?: {
    desktopId(): string | null
    verify(
      card: SelfApprovalCard,
      raw: unknown,
    ): { ok: false } | { ok: true; choice: string | null }
    landed(card: SelfApprovalCard): void
  }
}

export class ComputerSelfGuard {
  private readonly scopes = new AsyncLocalStorage<Scope>()
  private readonly sessions = new Set<string>()
  private readonly pending = new Map<
    string,
    { card: SelfApprovalCard; answer: (choice: ClientToolAnswer) => void }
  >()
  private until: number | null = null
  private generation = 0
  private readonly now: () => number
  private readonly options: SelfGuardOptions
  constructor(options: SelfGuardOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    try {
      const until = options.storage?.read()
      if (
        typeof until === 'number' &&
        Number.isFinite(until) &&
        until > this.now() &&
        until <= this.now() + DAY
      )
        this.until = until
    } catch {
      // 存储不可读不能产生授权。
    }
  }
  private message(text: string): string {
    return text.replaceAll('Litch', this.options.productName)
  }
  endSession(deviceId: string, threadId: string): void {
    this.sessions.delete(JSON.stringify([deviceId, threadId]))
  }
  dispose(): void {
    this.generation++
    this.sessions.clear()
    for (const waiting of this.pending.values()) waiting.answer('decline')
  }
  expiresAt(): number | null {
    return this.until !== null && this.until > this.now() ? this.until : null
  }
  revoke(): void {
    this.generation++
    this.until = null
    this.sessions.clear()
    for (const waiting of this.pending.values()) waiting.answer('decline')
    this.save()
  }
  private save(): void {
    this.options.storage?.write(this.until)
  }

  phoneAnswer(raw: unknown): void {
    const id = (raw as { id?: unknown } | null)?.id
    if (typeof id !== 'string') return
    const entry = this.pending.get(id)
    if (!entry) return
    const verdict = this.options.remote?.verify(entry.card, raw)
    if (!verdict?.ok) return
    this.options.remote?.landed(entry.card)
    entry.answer(verdict.choice === null ? 'decline' : (verdict.choice as ClientToolAnswer))
  }
  private async authorize(): Promise<void> {
    const scope = this.scopes.getStore()
    if (!scope || scope.context.signal.aborted)
      throw new HelperError('unauthorized', this.message(DENIED))
    if (scope.generation !== this.generation)
      throw new HelperError('unauthorized', this.message(DENIED))
    if (scope.approved || this.expiresAt() !== null || this.sessions.has(keyOf(scope.call))) return
    if (scope.preflightDone && scope.call.tool === COMPUTER_TOOL.runActions)
      throw new HelperError(
        'unauthorized',
        this.message(
          'The batch target changed to Litch itself after preflight. No protected action was executed. Observe the intended app and submit a new batch with explicit window numbers for approval; do not replay completed actions.',
        ),
      )
    const card: SelfApprovalCard = {
      pairedOnly: true,
      id: token(),
      nonce: token(),
      origin: 'litch://computer-self',
      accounts: ['once', 'session', 'always'].map((ref) => ({ ref })),
      deviceId: scope.call.device.id,
    }
    let answerPhone: (answer: ClientToolAnswer) => void = () => {}
    const phone = new Promise<ClientToolAnswer>((resolve) => {
      answerPhone = resolve
    })
    this.pending.set(card.id, { card, answer: answerPhone })
    let drop: (() => void) | undefined
    let onAbort: () => void = () => {}
    try {
      const ask = {
        kind: 'computerSelf' as const,
        id: card.id,
        nonce: card.nonce,
        desktopId: this.options.remote?.desktopId() ?? null,
      }
      const desktop = scope.context.show
        ? new Promise<ClientToolAnswer | null>((resolve) => {
            drop = scope.context.show?.(ask, resolve)
          })
        : scope.context.ask(ask)
      const aborted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null)
        scope.context.signal.addEventListener('abort', onAbort, { once: true })
      })
      const answer = await Promise.race([desktop, phone, aborted])
      if (
        scope.context.signal.aborted ||
        scope.generation !== this.generation ||
        !['once', 'session', 'always'].includes(answer ?? '')
      )
        throw new HelperError('unauthorized', this.message(DENIED))
      if (answer === 'session') this.sessions.add(keyOf(scope.call))
      if (answer === 'always') {
        this.until = this.now() + DAY
        try {
          this.save()
        } catch (error) {
          this.until = null
          throw error
        }
      }
      scope.approved = true
    } finally {
      drop?.()
      scope.context.signal.removeEventListener('abort', onAbort)
      this.pending.delete(card.id)
    }
  }
  wrap(helper: HelperAccess): HelperAccess {
    const wrapClient = (client: HelperRequester): HelperRequester => ({
      ...(client.hello === undefined ? {} : { hello: client.hello }),
      request: async (method, params = {}, timeout, signal) => {
        if (!METHODS.has(method)) return client.request(method, params, timeout, signal)
        const target = await this.inspect(client, params, signal)
        if (target.self) await this.authorize()
        if (signal?.aborted) throw new HelperError('unauthorized', this.message(DENIED))
        // 永远覆盖模型字段。助手再按实际进程复核，预检后目标变化不能借用授权。
        return client.request(
          method,
          { ...params, selfAllowed: target.self, targetPid: target.pid },
          timeout,
          signal,
        )
      },
    })
    return {
      client: async () => wrapClient(await helper.client()),
      restart: () => helper.restart(),
      get connected() {
        return helper.connected ? wrapClient(helper.connected) : null
      },
    }
  }
  private async inspect(
    client: HelperRequester,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ self: boolean; pid: number }> {
    const result = (await client.request(
      'inspectTarget',
      { app: params.app ?? params.appId, windowId: params.windowId ?? params.window },
      10_000,
      signal,
    )) as { self?: unknown; pid?: unknown }
    if (typeof result?.self !== 'boolean' || typeof result.pid !== 'number')
      throw new HelperError('failed', 'The helper could not verify the target application.')
    return result as { self: boolean; pid: number }
  }
  async run<T>(
    call: ClientToolInvocation,
    context: ClientToolContext,
    helper: HelperAccess,
    body: () => Promise<T>,
  ): Promise<T> {
    return this.scopes.run(
      { call, context, approved: false, generation: this.generation, preflightDone: false },
      async () => {
        if (call.tool === COMPUTER_TOOL.runActions && !validateComputerActions(call.arguments)) {
          const actions = (call.arguments as { actions?: unknown } | null)?.actions
          if (Array.isArray(actions)) {
            const client = await helper.client()
            let needsApproval = false
            // 整批先检查，任何一步的目标是 Litch，都在首个动作之前问。
            for (const action of actions) {
              const app = action?.arguments?.app
              if (typeof app !== 'string') continue
              if ((await this.inspect(client, action.arguments, context.signal)).self)
                needsApproval = true
            }
            if (needsApproval) await this.authorize()
          }
        }
        const scope = this.scopes.getStore()
        if (scope) scope.preflightDone = true
        return body()
      },
    )
  }
}
