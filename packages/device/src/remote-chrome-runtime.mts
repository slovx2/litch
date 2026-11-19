// 设备端只接本机、同 UID 的 Chrome 宿主。桥和站点判定沿用桌面所用的库。
import { timingSafeEqual } from 'node:crypto'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createSiteBook,
  type SiteBook,
} from '../../../third_party/litch-automation/packages/browser/src/browser/sites.mjs'
import { blockedHostOf } from '../../../third_party/litch-automation/packages/browser/src/browser/url.mjs'
import type { ClientToolContext } from '../../../third_party/litch-automation/packages/browser/src/tool-port.mjs'
import {
  ChromeBridge,
  ChromeBridgeError,
} from '../../../third_party/litch-automation/packages/chrome-bridge/src/bridge.mjs'
import { ChromeExecutor } from '../../../third_party/litch-automation/packages/chrome-bridge/src/executor.mjs'
import { chromeOrigin } from '../../../third_party/litch-automation/packages/chrome-extension/src/origin.mjs'
import {
  CHROME_STORE_URL,
  CHROME_WIRE_MIN,
  CHROME_WIRE_VERSION,
  chromeExtensionIds,
} from '../../protocol/src/chrome-browser.mjs'
import {
  type ClientToolCallParams,
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../protocol/src/client-tools.mjs'
import type { RemoteChromePolicy, RemoteChromeStatus } from '../../protocol/src/remote-chrome.mjs'
import { DeviceChromeInstall, quoteChromePath } from './remote-chrome-install.mjs'
import { isObject } from './wire.mjs'

export type ChromeScope = { harness: string; threadId: string; turnId: string }
export type ChromeAsk = Extract<
  Parameters<ClientToolContext['ask']>[0],
  { kind: 'site' | 'chromeSignIn' }
>

const deviceId = 'session-device-chrome'
const session = (scope: ChromeScope): string => JSON.stringify([scope.harness, scope.threadId])
const owner = (scope: ChromeScope) => ({ deviceId, threadId: session(scope), turnId: scope.turnId })
const operationTimeoutMs = 120_000

export class DeviceChromeRuntime {
  private install: DeviceChromeInstall
  private socketDirectory: string | null = null
  private bridge: ChromeBridge | null = null
  private chrome: ChromeExecutor | null = null
  private siteBook: SiteBook | null = null
  private active = new Map<
    AbortController,
    { instances: ReadonlySet<string>; scope: ChromeScope }
  >()
  private scopes = new Map<string, { scope: ChromeScope; instances: Set<string> }>()
  private stopped = new Map<string, number>()
  private stopSequence = 0
  private sessionSites = new Map<string, Set<string>>()
  private refreshWork: Promise<void> | null = null
  private timer: NodeJS.Timeout
  private closed = false
  private statusValue: RemoteChromeStatus

  private readonly version: string
  private readonly binary: string | undefined
  private readonly changed: (status: RemoteChromeStatus) => void
  private readonly log: (line: string) => void

  constructor(
    stateDir: string,
    version: string,
    changed: (status: RemoteChromeStatus) => void,
    log: (line: string) => void,
    binary?: string,
  ) {
    this.version = version
    this.binary = binary
    this.changed = changed
    this.log = log
    this.install = new DeviceChromeInstall(join(stateDir, 'chrome'))
    const base = binary ? quoteChromePath(binary) : 'codex-harness-adapter'
    const stateHome = dirname(stateDir)
    const flags =
      stateHome === join(homedir(), '.codex-harness-adapter')
        ? ''
        : ` --home ${quoteChromePath(stateHome)}`
    const command = (action: string) => `${base} chrome ${action}${flags}`
    this.statusValue = {
      hostLabel: hostname(),
      enabled: false,
      condition: 'unprepared',
      prepareCommand: command('prepare'),
      enableCommand: command('enable'),
      disableCommand: command('disable'),
      storeUrl: CHROME_STORE_URL,
    }
    this.timer = setInterval(() => void this.refresh(), 1000).unref()
    void this.refresh()
  }

  get status(): RemoteChromeStatus {
    return this.statusValue
  }

  get instances() {
    return (
      this.bridge?.instances().map((peer) => ({
        ...peer,
        // 停止后即使扩展没有断线，旧目标也不能跨过这次控制代次继续派发。
        epoch: `${peer.epoch}:${this.stopped.get(peer.id) ?? 0}`,
      })) ?? []
    )
  }

  private setStatus(changes: Partial<RemoteChromeStatus>): void {
    const next = { ...this.statusValue, ...changes }
    if (JSON.stringify(next) === JSON.stringify(this.statusValue)) return
    this.statusValue = next
    this.changed(next)
  }

  private handshakeStatus(): void {
    const instances = this.instances
    this.setStatus({
      condition: instances.some((peer) => peer.protocol !== null && !peer.stopped)
        ? 'connected'
        : instances.some((peer) => peer.stopped)
          ? 'stopped'
          : instances.length
            ? 'incompatible'
            : 'waiting',
    })
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.refreshWork)
      this.refreshWork = this.update()
        .catch(async (error: unknown) => {
          if (this.status.condition !== 'error') this.log(`设备 Chrome：${String(error)}`)
          await this.stopBridge()
          this.setStatus({ enabled: false, condition: 'error' })
        })
        .finally(() => {
          this.refreshWork = null
        })
    return this.refreshWork
  }

  private async update(): Promise<void> {
    const prepared = await this.install.inspect()
    const enabled = await this.install.enabled()
    if (!enabled || prepared !== 'owned') {
      this.setStatus({
        enabled: enabled && prepared === 'owned',
        condition: prepared === 'owned' ? 'waiting' : prepared,
      })
      await this.stopBridge()
      return
    }
    if (this.bridge) return
    await this.install.privateRoot()
    // Linux 的 Unix 路径有长度限制。私有短目录只在本次服务存在；宿主由 Chrome 启动，不需要 DISPLAY。
    this.socketDirectory = await mkdtemp('/tmp/litch-device-chrome-')
    const socketPath = join(this.socketDirectory, 'native.sock')
    const bridge = new ChromeBridge({
      socketPath,
      token: this.install.token,
      extensionIds: chromeExtensionIds(),
      version: this.version,
      productName: 'Litch',
      protocol: { min: CHROME_WIRE_MIN, max: CHROME_WIRE_VERSION },
    })
    this.bridge = bridge
    await bridge.start()
    await this.install.connectTo(socketPath, this.binary)
    const book = createSiteBook(join(this.install.root, 'sites.json'))
    this.siteBook = book
    this.chrome = new ChromeExecutor({
      bridge,
      namespace: 'litch_browser',
      productName: 'Litch',
      allowed: () => this.status.enabled && !this.closed && this.install.enabledNow(),
      sites: {
        ...book,
        verdict: (key, turn, origin) =>
          book.verdict(key, turn, origin) ??
          (this.sessionSites.get(key)?.has(origin) ? 'allow' : undefined),
        allowSession: (key, origin) => {
          const values = this.sessionSites.get(key) ?? new Set<string>()
          values.add(origin)
          this.sessionSites.set(key, values)
        },
      },
    })
    bridge.onEvent((instance, event) => {
      if (bridge !== this.bridge) return
      if (event.kind === 'hello' || event.kind === 'disconnected' || event.kind === 'control') {
        if (event.kind !== 'control' || event.stopped) {
          if (event.kind === 'control') this.stopped.set(instance, ++this.stopSequence)
          else this.stopped.delete(instance)
          for (const [abort, active] of this.active)
            if (active.instances.has(instance))
              abort.abort(new Error('Chrome stopped or disconnected.'))
          for (const { scope, instances } of this.scopes.values())
            if (instances.has(instance)) {
              const key = JSON.stringify([deviceId, session(scope)])
              book.turnEnded(key, scope.turnId)
              this.sessionSites.delete(key)
            }
        }
        this.handshakeStatus()
      }
    })
    this.setStatus({ enabled: true })
    this.handshakeStatus()
  }

  configure(params: unknown): RemoteChromePolicy {
    const proof =
      isObject(params) && typeof params.proof === 'string' && params.proof.length === 64
        ? Buffer.from(params.proof)
        : null
    const expected = Buffer.from(this.install.adminToken)
    if (!proof || proof.length !== expected.length || !timingSafeEqual(proof, expected))
      throw new Error('Change device Chrome policy from the Chrome user’s terminal.')
    const book = this.siteBook
    if (!book || !isObject(params)) throw new Error('Enable the device Chrome bridge first.')
    const site = typeof params.site === 'string' ? params.site : ''
    switch (params.action) {
      case 'sites':
        break
      case 'trust-on':
        book.setTrustAll(true)
        break
      case 'trust-off':
        book.setTrustAll(false)
        break
      case 'block':
      case 'unblock': {
        const host = blockedHostOf(site)
        if (!host) throw new Error('Invalid website hostname.')
        if (params.action === 'block') book.block(host)
        else book.unblock(host)
        break
      }
      case 'forget': {
        if (!site || chromeOrigin(site) !== site) throw new Error('Specify an HTTP(S) origin.')
        book.forget(site)
        break
      }
      default:
        throw new Error('Unknown device Chrome policy action.')
    }
    return { ...book.policy(), saved: book.saved() }
  }

  async call(
    scope: ChromeScope,
    params: ClientToolCallParams,
    instances: ReadonlySet<string>,
    signal: AbortSignal,
    ask: (
      prompt: ChromeAsk,
      signal: AbortSignal,
    ) => Promise<'once' | 'session' | 'always' | 'decline' | null>,
  ): Promise<ClientToolCallResponse> {
    const chrome = this.chrome
    if (!this.status.enabled || !chrome)
      return clientToolFailure(
        'disabled',
        'Device Chrome is unavailable. Check Device Chrome in Litch settings.',
      )
    if (signal.aborted) return clientToolFailure('failed', 'The Chrome call was cancelled.')
    const abort = new AbortController()
    const combined = AbortSignal.any([signal, abort.signal])
    let timer: NodeJS.Timeout | null = null
    let holds = 0
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = holds ? null : setTimeout(() => abort.abort(), operationTimeoutMs).unref()
    }
    const hold = () => {
      holds++
      arm()
      return () => {
        holds--
        arm()
      }
    }
    arm()
    const key = JSON.stringify(scope)
    const used = this.scopes.get(key)?.instances ?? new Set<string>()
    for (const instance of instances) used.add(instance)
    this.scopes.set(key, { scope, instances: used })
    this.active.set(abort, { instances, scope })
    try {
      return await chrome.call(
        {
          ...params,
          ...owner(scope),
          id: params.callId,
          namespace: 'litch_browser',
          device: { id: deviceId, name: this.status.hostLabel, kind: 'local', target: null },
          cwd: null,
          harness: scope.harness,
        },
        {
          signal: combined,
          hold,
          ask: async (prompt) => {
            if (prompt.kind !== 'site' && prompt.kind !== 'chromeSignIn') return null
            const resume = hold()
            try {
              return await ask(prompt, combined)
            } finally {
              resume()
            }
          },
        },
      )
    } catch (error) {
      const text =
        error instanceof ChromeBridgeError
          ? error.message
          : 'Device Chrome failed; an action may have executed. Inspect before retrying.'
      return clientToolFailure('failed', text)
    } finally {
      this.active.delete(abort)
      if (timer) clearTimeout(timer)
    }
  }

  endTurn(harness: string, turnId: string): void {
    for (const [key, { scope }] of this.scopes)
      if (scope.harness === harness && scope.turnId === turnId) this.endScope(key, scope)
  }

  endSession(harness: string, threadId: string): void {
    for (const [key, { scope }] of this.scopes)
      if (scope.harness === harness && scope.threadId === threadId) this.endScope(key, scope)
    this.sessionSites.delete(JSON.stringify([deviceId, session({ harness, threadId, turnId: '' })]))
  }

  private endScope(key: string, scope: ChromeScope): void {
    for (const [abort, active] of this.active)
      if (active.scope === scope || JSON.stringify(active.scope) === key) abort.abort()
    this.chrome?.turnEnded(owner(scope))
    this.scopes.delete(key)
  }

  private async stopBridge(): Promise<void> {
    for (const abort of this.active.keys()) abort.abort()
    this.scopes.clear()
    this.stopped.clear()
    this.sessionSites.clear()
    this.chrome?.dispose()
    this.chrome = null
    this.siteBook = null
    const bridge = this.bridge
    this.bridge = null
    await bridge?.close()
    if (this.socketDirectory) await rmdir(this.socketDirectory).catch(() => {})
    this.socketDirectory = null
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await this.refreshWork
    await this.stopBridge()
  }
}
