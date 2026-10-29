import { randomUUID } from 'node:crypto'
import type {
  ChromeGrant,
  ChromeTabState,
} from '../../../../packages/protocol/src/chrome-browser.mjs'
import type { ClientToolCallResponse } from '../../../../packages/protocol/src/client-tools.mjs'
import { chromeOrigin } from '../../../chrome-extension/src/origin.mjs'
import { newRefBook } from '../browser/ax.mjs'
import type { BrowserExecutor, TabState } from '../browser/executor.mjs'
import type { ClientToolContext, ClientToolInvocation } from '../client-tools/types.mjs'
import { type ChromeBridge, ChromeBridgeError } from './bridge.mjs'
import { ChromePage } from './page.mjs'
import { executePageTool } from './tools.mjs'

interface ListedTab extends ChromeTabState {
  origins: string[]
  busy: boolean
}
interface ClaimToken {
  instanceId: string
  tab: ListedTab
  session: string
  expires: number
}
export interface ChromeExecutorOptions {
  bridge: ChromeBridge
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
  readonly namespace = 'litch_browser'
  readonly pages = new Map<string, ChromePage>()
  private tokens = new Map<string, ClaimToken>()
  private states = new Map<string, TabState & { generation: number }>()
  private approvals = new Map<string, Set<string>>()
  private denied = new Set<string>()
  private busy = new Set<string>()
  private timer: ReturnType<typeof setInterval>
  private off: () => void
  private options: ChromeExecutorOptions
  constructor(options: ChromeExecutorOptions) {
    this.options = options
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
    if (!found.compatible)
      throw new ChromeBridgeError(
        'versionMismatch',
        'Reload the Litch extension from chrome://extensions.',
      )
    return id
  }
  async approve(
    invocation: ClientToolInvocation,
    context: ClientToolContext,
    instanceId: string,
    origins: string[],
  ): Promise<void> {
    for (const origin of origins) {
      if (origin === 'about:blank') continue
      if (chromeOrigin(origin) !== origin)
        throw new ChromeBridgeError('invalid', 'Unsupported origin.')
      const key = `${instanceId}:${session(invocation)}`
      const once = `${key}:${invocation.turnId}`
      if (this.approvals.get(key)?.has(origin) || this.approvals.get(once)?.has(origin)) continue
      if (this.denied.has(`${once}:${origin}`))
        throw new ChromeBridgeError(
          'originNotApproved',
          'The user declined this origin for this turn. Do not bypass the decision.',
        )
      const answer = await context.ask({ kind: 'site', origin, url: origin, browser: 'chrome' })
      if (answer === 'decline') this.denied.add(`${once}:${origin}`)
      if (context.signal.aborted || !answer || answer === 'decline')
        throw new ChromeBridgeError(
          'originNotApproved',
          `Access to ${origin} was not approved. Do not try to use another tab or tool to bypass the decision.`,
        )
      const scope = answer === 'once' ? once : key
      const allowed = this.approvals.get(scope) ?? new Set<string>()
      allowed.add(origin)
      this.approvals.set(scope, allowed)
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
      await old.release()
    }
    await this.approve(invocation, context, token.instanceId, token.tab.origins)
    const grant: ChromeGrant = {
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
    try {
      if (!this.options.allowed(invocation))
        throw new ChromeBridgeError(
          'targetUnavailable',
          'Chrome control is disabled for this source device. Enable it in Litch Settings → Browser → Chrome.',
        )
      const args = invocation.arguments as Record<string, unknown>
      if (!args || typeof args !== 'object')
        throw new ChromeBridgeError('invalid', 'Expected an argument object.')
      if (invocation.tool === 'targets')
        return ok(
          JSON.stringify({
            targets: this.options.bridge.instances().map((instance) => ({
              ...instance,
              targetId: `chrome:${instance.id}`,
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
      let page: ChromePage
      if (
        (invocation.tool === 'navigate' && (!args.tabId || args.newTab === true)) ||
        (invocation.tool === 'tabs' && args.action === 'new')
      ) {
        const instanceId = this.instance(args.targetId)
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
        return await executePageTool(this, page, invocation, context, args)
      } finally {
        page.unbind()
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
    for (const key of this.denied)
      if (key.includes(`:${ended}:${turn.turnId}:`)) this.denied.delete(key)
    for (const key of this.approvals.keys())
      if (key.endsWith(`:${turn.turnId}`)) this.approvals.delete(key)
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
