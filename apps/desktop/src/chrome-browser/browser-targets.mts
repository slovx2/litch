// Chrome 设置、安装和命名空间分流。页面数据仍由执行器经既有 clientTools 回传。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ChromeSettingsRequest,
  ChromeSettingsState,
} from '../../../../packages/protocol/src/chrome-browser.mjs'
import type { BrowserExecutor } from '../browser/executor.mjs'
import type { ClientToolExecutor, ClientToolInvocation } from '../client-tools/types.mjs'
import { ChromeBridge } from './bridge.mjs'
import { ChromeExecutor, chromeFailure } from './executor.mjs'
import { ChromeInstaller, chromeIdentity } from './installer.mjs'

export interface BrowserTargetsOptions {
  root: string
  assets: string
  nativeBinary: string
  openExtensions(): Promise<void>
  openDirectory(directory: string): Promise<void>
}
export class BrowserTargets {
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
    this.initialized = this.initialize().catch((error) => {
      this.lastError = String(error)
    })
  }
  private async initialize(): Promise<void> {
    if (process.platform !== 'darwin') return
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
    const socketPath = join(this.options.root, `${randomUUID().slice(0, 8)}.sock`)
    this.installer = new ChromeInstaller({ ...this.options, socketPath })
    this.bridge = new ChromeBridge({
      socketPath,
      token: this.installer.token,
      extensionId: this.identity.id,
      version: this.identity.version,
    })
    await this.bridge.start()
    this.chrome = new ChromeExecutor({
      bridge: this.bridge,
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
        throw new Error(this.lastError ?? 'Chrome control is available on macOS only.')
      if (request.kind === 'chrome.prepare') {
        await this.installer.prepare()
        this.lastError = null
      }
      if (request.kind === 'chrome.extensions') await this.options.openExtensions()
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
      if (request.kind === 'chrome.stop') this.chrome.stop()
    }
    return {
      supported: process.platform === 'darwin',
      prepared: (await this.installer?.prepared()) ?? false,
      enabled: this.enabled,
      allowedDevices: [...this.devices],
      extensionId: this.identity.id,
      expectedVersion: this.identity.version,
      extensionDirectory: this.installer?.extensionDirectory ?? '',
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
