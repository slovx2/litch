import type {
  ChromeGrant,
  ChromeRequest,
  ChromeTabState,
} from '../../../../packages/protocol/src/chrome-browser.mjs'
import type {
  BrowserPage,
  ConsoleEntry,
  DialogInfo,
  LoadOutcome,
  TabInfo,
} from '../browser/model.mjs'
import { type ChromeBridge, ChromeBridgeError } from './bridge.mjs'

export class ChromePage implements BrowserPage {
  readonly id: string
  readonly instanceId: string
  readonly grant: ChromeGrant
  state: ChromeTabState
  valid = true
  paused = false
  scripted = false
  private dialogState: DialogInfo | null = null
  private dialogWaiters = new Set<(value: DialogInfo) => void>()
  private bridge: ChromeBridge
  private signal: AbortSignal | undefined
  private activeGeneration: number | undefined
  constructor(
    id: string,
    instanceId: string,
    grant: ChromeGrant,
    state: ChromeTabState,
    bridge: ChromeBridge,
  ) {
    this.id = id
    this.instanceId = instanceId
    this.grant = grant
    this.state = state
    this.bridge = bridge
  }
  bind(signal: AbortSignal, generation: number): void {
    this.signal = signal
    this.activeGeneration = generation
  }
  unbind(): void {
    this.signal = undefined
    this.activeGeneration = undefined
  }
  info(): TabInfo {
    return {
      id: this.id,
      owner: this.grant.owner,
      kind: 'agent',
      url: this.state.url,
      title: this.state.title,
      loading: this.state.loading,
      canGoBack: false,
      canGoForward: false,
      agentActive: this.valid,
      keep: this.grant.keep,
    }
  }
  async request<T = unknown>(
    op: ChromeRequest['op'],
    args: Record<string, unknown> = {},
    guarded = true,
  ): Promise<T> {
    if (!this.valid)
      throw new ChromeBridgeError(
        'staleLease',
        'Chrome reconnected or the lease was released. List tabs and claim again.',
      )
    if (guarded && this.paused)
      throw new ChromeBridgeError(
        'signingIn',
        'The user is signing in. Wait until they return control.',
      )
    return this.bridge.call<T>(
      this.instanceId,
      {
        op,
        leaseId: this.grant.leaseId,
        ...(guarded && this.activeGeneration !== undefined
          ? { generation: this.activeGeneration }
          : {}),
        args,
      },
      this.signal,
    )
  }
  async cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>('command', { method, params })
  }
  async authorize(origins: string[], keep = this.grant.keep): Promise<void> {
    await this.request('authorize', { origins, keep }, false)
    this.grant.origins = origins
    this.grant.keep = this.grant.original || keep
  }
  async load(url: string, timeoutMs: number): Promise<LoadOutcome> {
    this.state = await this.request('navigate', { url })
    this.activeGeneration = undefined
    return { ok: await this.waitForLoad(timeoutMs, this.signal ?? new AbortController().signal) }
  }
  async history(action: 'back' | 'forward' | 'reload', timeoutMs: number): Promise<LoadOutcome> {
    this.state = await this.request('history', { action })
    this.activeGeneration = undefined
    return { ok: await this.waitForLoad(timeoutMs, this.signal ?? new AbortController().signal) }
  }
  async waitForLoad(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal.aborted || !this.valid) return false
      const tabs = await this.bridge.call<ChromeTabState[]>(
        this.instanceId,
        { op: 'list', args: {} },
        signal,
      )
      const next = tabs.find((tab) => tab.id === this.grant.tabId)
      if (!next) throw new ChromeBridgeError('targetUnavailable', 'The Chrome tab was closed.')
      this.state = next
      if (!next.loading) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }
  consoleEntries(): ConsoleEntry[] {
    return []
  }
  clearConsole(): void {}
  dialog(): DialogInfo | null {
    return this.dialogState
  }
  updateDialog(dialog: DialogInfo | null): void {
    this.dialogState = dialog
    if (dialog) {
      for (const waiter of this.dialogWaiters) waiter(dialog)
      this.dialogWaiters.clear()
    }
  }
  dialogOpened(): Promise<DialogInfo> {
    return this.dialogState
      ? Promise.resolve(this.dialogState)
      : new Promise((resolve) => this.dialogWaiters.add(resolve))
  }
  takeNotices(): string[] {
    return []
  }
  setAgentActive(): void {}
  async pointAt(x: number, y: number, width?: number, height?: number): Promise<void> {
    await this.request('pointer', { x, y, width, height })
  }
  async release(close = false): Promise<void> {
    if (!this.valid) return
    try {
      await this.request('release', { close }, false)
    } finally {
      this.valid = false
    }
  }
}
