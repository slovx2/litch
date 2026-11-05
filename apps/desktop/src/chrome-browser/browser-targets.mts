// Chrome 设置、安装和命名空间分流。页面数据仍由执行器经既有 clientTools 回传。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CHROME_STORE_URL,
  type ChromeSettingsRequest,
  type ChromeSettingsState,
  chromeExtensionIds,
} from '../../../../packages/protocol/src/chrome-browser.mjs'
import type { BrowserExecutor } from '../browser/executor.mjs'
import { createSiteBook } from '../browser/sites.mjs'
import { blockedHostOf } from '../browser/url.mjs'
import type { ClientToolExecutor, ClientToolInvocation } from '../client-tools/types.mjs'
import { ChromeBridge } from './bridge.mjs'
import { ChromeExecutor, chromeFailure } from './executor.mjs'
import { ChromeInstaller, chromeIdentity } from './installer.mjs'

const SUPPORTED = ['darwin', 'win32', 'linux'].includes(process.platform)
/** 这一版只认随 Litch 发布的扩展；用户自编扩展的 ID 以后由设置里的显式操作加进来。 */
const extensionIds = chromeExtensionIds()

export interface BrowserTargetsOptions {
  root: string
  assets: string
  nativeBinary: string
  /** 在 Google Chrome 里打开网址（扩展页、商店页都要在 Chrome 里开，不能交给默认浏览器）。 */
  openInChrome(url: string): Promise<void>
  openDirectory(directory: string): Promise<void>
}
export class BrowserTargets {
  private sites
  private enabled = false
  private devices = new Set<string>()
  private lastError: string | null = null
  private options: BrowserTargetsOptions
  private installer: ChromeInstaller | null = null
  private bridge: ChromeBridge | null = null
  private chrome: ChromeExecutor | null = null
  private identity = { id: '', version: '' }
  private initialized: Promise<void>
  constructor(options: BrowserTargetsOptions) {
    this.options = options
    this.sites = createSiteBook(join(options.root, 'sites.json'))
    this.initialized = this.initialize().catch((error) => {
      this.lastError = String(error)
    })
  }
  private async initialize(): Promise<void> {
    if (!SUPPORTED) return
    this.identity = await chromeIdentity(this.options.assets)
    try {
      const prefs = JSON.parse(await readFile(join(this.options.root, 'settings.json'), 'utf8'))
      this.enabled = prefs.enabled === true
      this.devices = new Set(
        Array.isArray(prefs.devices)
          ? prefs.devices.filter((id: unknown) => typeof id === 'string')
          : [],
      )
    } catch {
      /* 首次安装保持关闭。 */
    }
    // Windows 上 Node 的本地套接字是命名管道；原生宿主照配置里的地址连
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\litch-chrome-${randomUUID()}`
        : join(this.options.root, `${randomUUID().slice(0, 8)}.sock`)
    this.installer = new ChromeInstaller({ ...this.options, socketPath, extensionIds })
    this.bridge = new ChromeBridge({
      socketPath,
      token: this.installer.token,
      extensionIds,
      version: this.identity.version,
    })
    await this.bridge.start()
    this.chrome = new ChromeExecutor({
      bridge: this.bridge,
      sites: this.sites,
      allowed: (invocation) => this.allowed(invocation),
    })
    // 已安装时更新宿主本次连接地址；扩展重连后必须重新认领，不恢复旧授权。
    if (await this.installer.prepared()) await this.installer.prepare()
  }
  private allowed(invocation: ClientToolInvocation): boolean {
    return (
      this.enabled && (invocation.device.kind === 'local' || this.devices.has(invocation.device.id))
    )
  }
  private async save(): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    await writeFile(
      join(this.options.root, 'settings.json'),
      JSON.stringify({ enabled: this.enabled, devices: [...this.devices] }),
      { mode: 0o600 },
    )
  }
  async settings(request: ChromeSettingsRequest): Promise<ChromeSettingsState> {
    await this.initialized
    if (request.kind !== 'chrome.status') {
      if (!this.installer || !this.chrome)
        throw new Error(this.lastError ?? 'Chrome control is not available on this platform.')
      if (request.kind === 'chrome.prepare') {
        await this.installer.prepare()
        this.lastError = null
      }
      if (request.kind === 'chrome.extensions')
        await this.options.openInChrome('chrome://extensions')
      if (request.kind === 'chrome.store') {
        if (!CHROME_STORE_URL) throw new Error('The Chrome Web Store listing is not available yet.')
        await this.options.openInChrome(CHROME_STORE_URL)
      }
      if (request.kind === 'chrome.directory')
        await this.options.openDirectory(this.installer.extensionDirectory)
      if (request.kind === 'chrome.enable') {
        this.enabled = request.enabled
        if (!this.enabled) this.chrome.stop()
        await this.save()
      }
      if (request.kind === 'chrome.device') {
        if (request.enabled) this.devices.add(request.deviceId)
        else {
          this.devices.delete(request.deviceId)
          this.chrome.stop(request.deviceId)
        }
        await this.save()
      }
      if (request.kind === 'chrome.trust') this.sites.setTrustAll(request.on)
      if (request.kind === 'chrome.block') {
        const host = blockedHostOf(request.site)
        if (!host) throw new Error('Invalid website hostname.')
        this.sites.block(host)
      }
      if (request.kind === 'chrome.unblock') this.sites.unblock(request.host ?? undefined)
      if (request.kind === 'chrome.forget') this.sites.forget(request.origin ?? undefined)
      if (request.kind === 'chrome.stop') this.chrome.stop()
    }
    return {
      sitePolicy: this.sites.policy(),
      savedSites: this.sites.saved(),
      supported: SUPPORTED,
      platform: SUPPORTED ? (process.platform as 'darwin' | 'win32' | 'linux') : null,
      prepared: (await this.installer?.prepared()) ?? false,
      enabled: this.enabled,
      allowedDevices: [...this.devices],
      extensionId: this.identity.id,
      allowedExtensionIds: extensionIds,
      bundledVersion: this.identity.version,
      extensionDirectory: this.installer?.extensionDirectory ?? '',
      storeUrl: CHROME_STORE_URL,
      instances: this.bridge?.instances() ?? [],
      lastError: this.lastError,
    }
  }
  dispatch(builtin: BrowserExecutor): ClientToolExecutor {
    return {
      namespace: 'litch_browser',
      call: async (invocation, context) => {
        const args = invocation.arguments as Record<string, unknown> | null
        const explicit =
          ['targets', 'claim', 'release'].includes(invocation.tool) ||
          (invocation.tool === 'run_actions' &&
            Array.isArray(args?.actions) &&
            args.actions.some(
              (action) =>
                typeof action?.arguments?.tabId === 'string' &&
                action.arguments.tabId.startsWith('chrome:'),
            )) ||
          typeof args?.targetId === 'string' ||
          (typeof args?.tabId === 'string' && args.tabId.startsWith('chrome:'))
        if (!explicit) return builtin.call(invocation, context)
        await this.initialized
        if (!this.chrome)
          return chromeFailure(
            new Error(this.lastError ?? 'Chrome is unavailable on this platform.'),
          )
        return this.chrome.call(invocation, context)
      },
      turnEnded: (turn) => {
        builtin.turnEnded?.(turn)
        this.chrome?.turnEnded(turn)
      },
      phoneAnswer: (answer) => builtin.phoneAnswer?.(answer),
    }
  }
  async dispose(): Promise<void> {
    await this.initialized
    this.chrome?.dispose()
    await this.bridge?.close()
  }
}
