import { createHash, randomUUID } from 'node:crypto'
import type {
  ChromeGrant,
  ChromeTabState,
} from '../../automation-contracts/src/litch/chrome-browser.mjs'
import { newRefBook } from '../../browser/src/browser/ax.mjs'
import { runBrowserActions } from '../../browser/src/browser/batch.mjs'
import type { BrowserExecutor, TabState } from '../../browser/src/browser/executor.mjs'
import { createSiteBook, type SiteBook } from '../../browser/src/browser/sites.mjs'
import type {
  ClientToolCallResponse,
  ClientToolContext,
  ClientToolInvocation,
} from '../../browser/src/tool-port.mjs'
import { chromeOrigin } from '../../chrome-extension/src/origin.mjs'
import { type ChromeBridge, ChromeBridgeError, incompatibleMessage } from './bridge.mjs'
import { ChromePage } from './page.mjs'
import { executePageTool } from './tools.mjs'

interface ListedTab extends ChromeTabState {
  origins: string[]
  busy: boolean
}
interface ClaimToken {
  instanceId: string
  epoch: string
  tab: ListedTab
  session: string
  expires: number
}
export interface ChromeExecutorOptions {
  bridge: ChromeBridge
  namespace: string
  productName: string
  sites?: SiteBook
  allowed(invocation: ClientToolInvocation): boolean
}
const session = (invocation: ClientToolInvocation): string =>
  JSON.stringify([invocation.device.id, invocation.threadId])
const ok = (text: string): ClientToolCallResponse => ({
  success: true,
  contentItems: [{ type: 'inputText', text }],
})
export const chromeFailure = (error: unknown): ClientToolCallResponse => ({
  success: false,
  contentItems: [
    {
      type: 'inputText',
      text: JSON.stringify({
        code: error instanceof ChromeBridgeError ? error.code : 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    },
  ],
})

export class ChromeExecutor implements BrowserExecutor {
  readonly namespace: string
  readonly pages = new Map<string, ChromePage>()
  private tokens = new Map<string, ClaimToken>()
  private states = new Map<string, TabState & { generation: number }>()
  readonly sites: SiteBook
  private instancePermits = new Map<string, Set<string>>()
  private deniedInstances = new Set<string>()
  private busy = new Set<string>()
  private calls = new Map<
    string,
    { turn: string; fingerprint: string; promise: Promise<ClientToolCallResponse> }
  >()
  private endedTurns = new Set<string>()
  private timer: ReturnType<typeof setInterval>
  private off: () => void
  private options: ChromeExecutorOptions
  constructor(options: ChromeExecutorOptions) {
    this.options = options
    this.namespace = options.namespace
    this.sites = options.sites ?? createSiteBook(null)
    this.off = options.bridge.onEvent((instanceId, event) => {
      for (const page of this.pages.values()) {
        if (page.instanceId !== instanceId) continue
        if (
          event.kind === 'hello' ||
          event.kind === 'disconnected' ||
          (event.kind === 'removed' && event.tabId === page.grant.tabId) ||
          (event.kind === 'revoked' && event.leaseId === page.grant.leaseId)
        )
          page.valid = false
        if (event.kind === 'tab' && event.tab.id === page.grant.tabId) page.state = event.tab
        if (
          event.kind === 'dialog' &&
          event.tabId === page.grant.tabId &&
          event.generation === page.state.generation
        )
          page.updateDialog(event.dialog)
      }
    })
    this.timer = setInterval(() => {
      for (const page of this.pages.values())
        if (page.valid)
          void page.request('renew', {}, false).catch(() => {
            page.valid = false
          })
      // 旧编号短期保留错误语义，但不让长驻桌面无限积累已释放页面。
      if (this.pages.size > 256)
        for (const [id, page] of this.pages)
          if (!page.valid) {
            this.pages.delete(id)
            this.states.delete(id)
          }
      for (const [id, token] of this.tokens) if (token.expires < Date.now()) this.tokens.delete(id)
    }, 4000)
    this.timer.unref()
  }
  state(page: ChromePage): TabState {
    let state = this.states.get(page.id)
    if (!state || state.generation !== page.state.generation) {
      state = {
        book: newRefBook(),
        lastSnapshot: null,
        shotScale: 1,
        forwardNote: null,
        generation: page.state.generation,
      }
      this.states.set(page.id, state)
    }
    return state
  }
  private instance(target: unknown): string {
    if (typeof target !== 'string' || !target.startsWith('chrome:'))
      throw new ChromeBridgeError('invalid', 'Choose an explicit Chrome targetId from targets.')
    const id = target.slice(7)
    const found = this.options.bridge.instances().find((instance) => instance.id === id)
    if (!found)
      throw new ChromeBridgeError(
        'disconnected',
        'This Chrome instance disconnected. List targets again.',
      )
    if (found.incompatible)
      throw new ChromeBridgeError(
        'versionMismatch',
        incompatibleMessage(found, this.options.productName),
      )
    return id
  }
  private async permitInstance(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
    instanceId: string,
  ): Promise<void> {
    const instance = this.options.bridge.instances().find((item) => item.id === instanceId)
    if (!instance)
      throw new ChromeBridgeError('disconnected', 'Chrome disconnected. List targets again.')
    const identity = `${instanceId}:${instance.epoch}`
    const key = session(invocation)
    const once = `${key}:${invocation.turnId}`
    if (
      this.instancePermits.get(key)?.has(identity) ||
      this.instancePermits.get(once)?.has(identity)
    )
      return
    if (this.deniedInstances.has(`${once}:${identity}`))
      throw new ChromeBridgeError(
        'originNotApproved',
        'The user declined access to this Chrome instance. Do not switch targets to bypass the decision.',
      )
    const answer = await context.ask({
      kind: 'chromeInstance',
      instanceId,
      name: `${instance.name} · ${instanceId.slice(0, 8)}`,
    })
    if (answer === 'decline') this.deniedInstances.add(`${once}:${identity}`)
    if (!answer || answer === 'decline' || context.signal.aborted)
      throw new ChromeBridgeError('originNotApproved', 'Chrome instance access was not approved.')
    if (
      this.options.bridge.instances().find((item) => item.id === instanceId)?.epoch !==
      instance.epoch
    )
      throw new ChromeBridgeError(
        'staleLease',
        'Chrome reconnected during approval. List targets again.',
      )
    const scope = answer === 'session' ? key : once
    const permitted = this.instancePermits.get(scope) ?? new Set<string>()
    permitted.add(identity)
    this.instancePermits.set(scope, permitted)
  }
  async approve(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
    origins: string[],
  ): Promise<void> {
    for (const origin of origins) {
      if (origin === 'about:blank') continue
      if (chromeOrigin(origin) !== origin)
        throw new ChromeBridgeError('invalid', 'Unsupported origin.')
      const key = session(invocation)
      const verdict = this.sites.verdict(key, invocation.turnId, origin)
      if (verdict === 'allow') continue
      if (verdict === 'decline' || verdict === 'blocked')
        throw new ChromeBridgeError(
          'originNotApproved',
          verdict === 'blocked'
            ? `The user blocked ${origin}. Do not bypass the blocklist.`
            : 'The user declined this origin for this turn. Do not bypass the decision.',
        )
      const answer = await context.ask({ kind: 'site', origin, url: origin, browser: 'chrome' })
      if (context.signal.aborted || !answer)
        throw new ChromeBridgeError('cancelled', 'Site approval was cancelled.')
      if (answer === 'decline') {
        this.sites.decline(key, invocation.turnId, origin)
        throw new ChromeBridgeError('originNotApproved', `Access to ${origin} was declined.`)
      }
      if (answer === 'always') this.sites.allowAlways(origin)
      else if (answer === 'session') this.sites.allowSession(key, origin)
      else this.sites.allowOnce(key, invocation.turnId, origin)
      // 等审批时设置可能已改变；黑名单仍有最终决定权。
      if (this.sites.verdict(key, invocation.turnId, origin) === 'blocked')
        throw new ChromeBridgeError('originNotApproved', `The user blocked ${origin}.`)
    }
  }
  private page(invocation: ClientToolInvocation, id: unknown): ChromePage {
    const page = typeof id === 'string' ? this.pages.get(id) : null
    if (
      !page ||
      JSON.stringify([page.grant.owner.deviceId, page.grant.owner.threadId]) !== session(invocation)
    )
      throw new ChromeBridgeError(
        'tabNotClaimed',
        'This tab is not claimed by this conversation. List tabs and claim first.',
      )
    if (!page.valid || page.grant.owner.turnId !== invocation.turnId)
      throw new ChromeBridgeError(
        'staleLease',
        'The lease belongs to an ended turn or disconnected Chrome. List and claim again.',
      )
    if (page.paused)
      throw new ChromeBridgeError(
        'signingIn',
        'The user is signing in. All observation and actions are paused.',
      )
    return page
  }
  private async claim(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
    token: ClaimToken,
    original = true,
    keep = true,
  ): Promise<ChromePage> {
    if (token.session !== session(invocation) || token.expires < Date.now())
      throw new ChromeBridgeError('staleDocument', 'The tab listing expired. List tabs again.')
    for (const old of this.pages.values()) {
      if (!old.valid || old.instanceId !== token.instanceId || old.grant.tabId !== token.tab.id)
        continue
      if (
        session(invocation) !==
          JSON.stringify([old.grant.owner.deviceId, old.grant.owner.threadId]) ||
        old.paused ||
        this.busy.has(old.id)
      )
        throw new ChromeBridgeError('busy', 'This tab is in use.')
      original = old.grant.original
      keep = old.grant.keep
      await old.release()
    }
    await this.permitInstance(invocation, context, token.instanceId)
    await this.approve(invocation, context, token.tab.origins)
    if (original) {
      const answer = await context.ask({
        kind: 'chromeTab',
        url: token.tab.url,
        title: token.tab.title,
      })
      if (answer !== 'once' || context.signal.aborted)
        throw new ChromeBridgeError(
          'tabNotClaimed',
          'The user did not approve control of this tab.',
        )
    }
    if (
      this.options.bridge.instances().find((instance) => instance.id === token.instanceId)
        ?.epoch !== token.epoch ||
      token.expires < Date.now()
    )
      throw new ChromeBridgeError(
        'staleLease',
        'Chrome reconnected or the tab listing expired during approval. List tabs again.',
      )
    const grant: ChromeGrant = {
      ...(invocation.sessionTitle ? { sessionTitle: invocation.sessionTitle } : {}),
      leaseId: randomUUID(),
      tabId: token.tab.id,
      owner: {
        deviceId: invocation.device.id,
        threadId: invocation.threadId,
        turnId: invocation.turnId,
      },
      origins: token.tab.origins,
      expiresAt: Date.now() + 15_000,
      original,
      keep,
    }
    const result = await this.options.bridge.call<{ tab: ChromeTabState }>(
      token.instanceId,
      {
        op: 'claim',
        args: { grant, expectedUrl: token.tab.url, expectedGeneration: token.tab.generation },
      },
      context.signal,
    )
    const page = new ChromePage(
      `chrome:${randomUUID()}`,
      token.instanceId,
      grant,
      result.tab,
      this.options.bridge,
    )
    this.pages.set(page.id, page)
    return page
  }
  async call(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
  ): Promise<ClientToolCallResponse> {
    if (!this.options.allowed(invocation))
      return chromeFailure(
        new ChromeBridgeError(
          'targetUnavailable',
          'Chrome control is disabled for this source device.',
        ),
      )
    const args = invocation.arguments as Record<string, unknown> | null
    const target =
      typeof args?.targetId === 'string'
        ? args.targetId.slice(7)
        : typeof args?.tabId === 'string'
          ? this.pages.get(args.tabId)?.instanceId
          : typeof args?.claimToken === 'string'
            ? this.tokens.get(args.claimToken)?.instanceId
            : undefined
    if (
      target &&
      [...this.pages.values()].some(
        (page) => page.valid && page.paused && page.instanceId === target,
      ) &&
      !['targets', 'request_sign_in'].includes(invocation.tool)
    )
      return chromeFailure(
        new ChromeBridgeError('signingIn', 'This Chrome instance is paused for sign-in.'),
      )
    const turn = JSON.stringify([invocation.device.id, invocation.threadId, invocation.turnId])
    if (this.endedTurns.has(turn))
      return chromeFailure(
        new ChromeBridgeError(
          'staleLease',
          'This turn has ended. Start a new turn and claim again.',
        ),
      )
    const key = JSON.stringify([turn, invocation.callId])
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([invocation.tool, invocation.arguments]))
      .digest('hex')
    const previous = this.calls.get(key)
    if (previous)
      return previous.fingerprint === fingerprint
        ? previous.promise
        : chromeFailure(
            new ChromeBridgeError('invalid', 'A callId cannot be reused with different arguments.'),
          )
    if (this.calls.size >= 4096)
      return chromeFailure(
        new ChromeBridgeError(
          'busy',
          'Too many calls are retained for active turns. End an active turn before continuing.',
        ),
      )
    const promise = this.execute(invocation, context)
    const entry = { turn, fingerprint, promise }
    this.calls.set(key, entry)
    const response = await promise
    // 大结果不无限保留；重复调用仍不得重放动作，而是明确报告结果已淘汰。
    if (JSON.stringify(response).length > 65536)
      entry.promise = Promise.resolve(
        chromeFailure(
          new ChromeBridgeError(
            'failed',
            'This call already ran; its large result is no longer cached. Do not repeat an action blindly.',
          ),
        ),
      )
    return response
  }
  private async execute(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
  ): Promise<ClientToolCallResponse> {
    try {
      if (!this.options.allowed(invocation))
        throw new ChromeBridgeError(
          'targetUnavailable',
          `Chrome control is disabled for this source device. Enable it in ${this.options.productName} Settings → Browser → Chrome.`,
        )
      const args = invocation.arguments as Record<string, unknown>
      if (!args || typeof args !== 'object')
        throw new ChromeBridgeError('invalid', 'Expected an argument object.')
      if (context.signal.aborted)
        throw new ChromeBridgeError('cancelled', 'The call was cancelled.')
      if (invocation.tool === 'run_actions') {
        const generations = new Map<string, number>()
        return runBrowserActions(invocation, context, this.call.bind(this), true, (action) => {
          const id = action.arguments.tabId as string
          const generation = this.pages.get(id)?.state.generation
          if (generation === undefined) return null // 普通执行入口给出无租约错误。
          const previous = generations.get(id)
          if (
            previous !== undefined &&
            previous !== generation &&
            ['click', 'type', 'press', 'scroll'].includes(action.tool)
          )
            return chromeFailure(
              new ChromeBridgeError(
                'staleDocument',
                'The document changed during the batch. Take a fresh snapshot before further input.',
              ),
            )
          if (previous === undefined) generations.set(id, generation)
          return null
        })
      }
      if (invocation.tool === 'targets')
        return ok(
          JSON.stringify({
            targets: this.options.bridge.instances().map((instance) => ({
              ...instance,
              targetId: `chrome:${instance.id}`,
              ...(instance.incompatible
                ? { unavailableReason: incompatibleMessage(instance, this.options.productName) }
                : {}),
              browser: 'chrome',
              location: 'controller',
            })),
          }),
        )
      // 登录弹窗也可能承载凭据；用户交还之前暂停整个实例的代理入口。
      const target =
        typeof args.targetId === 'string'
          ? args.targetId.slice(7)
          : typeof args.tabId === 'string'
            ? this.pages.get(args.tabId)?.instanceId
            : typeof args.claimToken === 'string'
              ? this.tokens.get(args.claimToken)?.instanceId
              : undefined
      if (
        target &&
        [...this.pages.values()].some(
          (page) => page.valid && page.paused && page.instanceId === target,
        )
      )
        throw new ChromeBridgeError(
          'signingIn',
          'The user is signing in in this Chrome instance. All observation and actions are paused until they return control.',
        )
      if (invocation.tool === 'tabs' && args.action === 'list') {
        const instanceId = this.instance(args.targetId)
        await this.permitInstance(invocation, context, instanceId)
        const tabs = await this.options.bridge.call<ListedTab[]>(
          instanceId,
          { op: 'list', args: {} },
          context.signal,
        )
        const list = tabs
          .filter(
            (tab) =>
              ![...this.pages.values()].some(
                (page) =>
                  page.instanceId === instanceId && page.grant.tabId === tab.id && page.paused,
              ),
          )
          .map((tab) => {
            const claimToken = randomUUID()
            this.tokens.set(claimToken, {
              instanceId,
              epoch:
                this.options.bridge.instances().find((instance) => instance.id === instanceId)
                  ?.epoch ?? '',
              tab,
              session: session(invocation),
              expires: Date.now() + 30_000,
            })
            return {
              title: tab.title,
              url: tab.url,
              claimToken,
              busy: tab.busy,
              origins: tab.origins,
            }
          })
        return ok(JSON.stringify({ tabs: list }))
      }
      if (invocation.tool === 'claim') {
        const token = typeof args.claimToken === 'string' ? this.tokens.get(args.claimToken) : null
        if (!token)
          throw new ChromeBridgeError('invalid', 'Use a claimToken from a fresh tabs list.')
        this.tokens.delete(args.claimToken as string)
        const page = await this.claim(invocation, context, token)
        return ok(
          JSON.stringify({
            tabId: page.id,
            url: page.state.url,
            note: 'Use this tabId in subsequent calls. The user tab will be released, not closed, when the turn ends.',
          }),
        )
      }
      if (invocation.tool === 'release' && typeof args.tabId === 'string') {
        const released = this.pages.get(args.tabId)
        if (
          released &&
          !released.valid &&
          JSON.stringify([released.grant.owner.deviceId, released.grant.owner.threadId]) ===
            session(invocation)
        )
          return ok('The Chrome tab was already released.')
      }
      let page: ChromePage
      if (
        (invocation.tool === 'navigate' && (!args.tabId || args.newTab === true)) ||
        (invocation.tool === 'tabs' && args.action === 'new')
      ) {
        const instanceId = this.instance(args.targetId)
        await this.permitInstance(invocation, context, instanceId)
        const tab = await this.options.bridge.call<ChromeTabState>(
          instanceId,
          { op: 'new', args: {} },
          context.signal,
        )
        page = await this.claim(
          invocation,
          context,
          {
            instanceId,
            epoch:
              this.options.bridge.instances().find((instance) => instance.id === instanceId)
                ?.epoch ?? '',
            tab: { ...tab, origins: ['about:blank'], busy: false },
            session: session(invocation),
            expires: Date.now() + 30_000,
          },
          false,
          args.keep === true,
        )
      } else page = this.page(invocation, args.tabId)
      if (this.busy.has(page.id))
        throw new ChromeBridgeError('busy', 'Another operation is running on this Chrome tab.')
      this.busy.add(page.id)
      page.bind(context.signal, page.state.generation)
      try {
        // 每次操作重新判断，已发出的租约不能绕过用户刚设置的黑名单。
        if (invocation.tool !== 'release')
          await this.approve(invocation, context, page.grant.origins)
        return await executePageTool(this, page, invocation, context, args)
      } finally {
        page.unbind()
        // 审批检查与实际请求之间也可能取消；这时桥还没有收到请求，需主动释放租约。
        if (context.signal.aborted) await page.release().catch(() => {})
        this.busy.delete(page.id)
      }
    } catch (error) {
      return chromeFailure(error)
    }
  }
  currentTab(): string | null {
    return null
  }
  turnEnded(turn: { deviceId: string; threadId: string; turnId: string }): void {
    const identity = JSON.stringify([turn.deviceId, turn.threadId, turn.turnId])
    this.endedTurns.add(identity)
    if (this.endedTurns.size > 512)
      this.endedTurns.delete(this.endedTurns.values().next().value ?? '')
    for (const [key, call] of this.calls) if (call.turn === identity) this.calls.delete(key)
    for (const page of this.pages.values())
      if (
        page.grant.owner.deviceId === turn.deviceId &&
        page.grant.owner.threadId === turn.threadId &&
        page.grant.owner.turnId === turn.turnId
      )
        void page.release(!page.grant.original && !page.grant.keep).catch(() => {
          page.valid = false
        })
    const ended = JSON.stringify([turn.deviceId, turn.threadId])
    for (const [id, token] of this.tokens) if (token.session === ended) this.tokens.delete(id)
    this.sites.turnEnded(ended, turn.turnId)
    this.instancePermits.delete(`${ended}:${turn.turnId}`)
    for (const key of this.deniedInstances)
      if (key.startsWith(`${ended}:${turn.turnId}:`)) this.deniedInstances.delete(key)
  }
  stop(deviceId?: string): void {
    for (const page of this.pages.values())
      if (page.valid && (!deviceId || page.grant.owner.deviceId === deviceId))
        void page
          .request('stop', {}, false)
          .finally(() => {
            page.valid = false
          })
          .catch(() => {})
  }
  dispose(): void {
    clearInterval(this.timer)
    this.stop()
    this.off()
  }
}
