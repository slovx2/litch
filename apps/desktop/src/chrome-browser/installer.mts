import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CHROME_HOST_NAME } from '../../../../packages/protocol/src/chrome-browser.mjs'

export interface ChromeInstallOptions {
  root: string
  assets: string
  nativeBinary: string
  socketPath: string
  /** 宿主清单 allowed_origins 与原生宿主都认的扩展 ID（chromeExtensionIds）。 */
  extensionIds: readonly string[]
  /** 只给隔离验收指定：清单写到这些目录，不写系统位置（Windows 照样写注册表）。 */
  manifestDirectories?: string[]
}

/**
 * Windows 上 Chrome 正式版按这个注册表键找宿主清单（每用户）；Chromium、Edge 各有自己的键，这一版不写。
 * 卸载由安装程序删（packaging/litch.iss 的 [Registry]）。
 */
export const CHROME_HOST_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CHROME_HOST_NAME}`

/**
 * 宿主清单放哪：macOS 是 Chrome 正式版的每用户目录；Linux 是 google-chrome，装过 Chromium 的再加它的目录；
 * Windows 放在 Litch 自己的目录里，再登记到注册表。
 */
async function manifestDirectories(root: string): Promise<string[]> {
  if (process.platform === 'darwin')
    return [join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')]
  if (process.platform === 'win32') return [root]
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const chromium = join(config, 'chromium')
  const hasChromium = await stat(chromium).then(
    (info) => info.isDirectory(),
    () => false,
  )
  return [
    join(config, 'google-chrome/NativeMessagingHosts'),
    ...(hasChromium ? [join(chromium, 'NativeMessagingHosts')] : []),
  ]
}

// 路径选择和系统登记属于 Litch 外壳，库只接显式的存储端口。
import { ChromeInstaller as Installer } from '../../../../packages/chrome-bridge/src/installer.mjs'
import { FileRegistrationStore } from '../../../../packages/chrome-bridge/src/registration.mjs'

export { chromeIdentity } from '../../../../packages/chrome-bridge/src/installer.mjs'

export class ChromeInstaller {
  private options: ChromeInstallOptions
  private directories: Promise<string[]>
  constructor(options: ChromeInstallOptions) {
    this.options = options
    this.directories = options.manifestDirectories
      ? Promise.resolve(options.manifestDirectories)
      : manifestDirectories(options.root)
    // 随机令牌和原有目录形状不变；存储目录的异步探测延到 prepare。
    this.base = new Installer({
      ...options,
      identity: {
        hostName: CHROME_HOST_NAME,
        extensionIds: options.extensionIds,
        productName: 'Litch',
      },
      nativeArgs: ['chrome-host'],
      registrations: async () =>
        (await this.directories).map(
          (directory) => new FileRegistrationStore(directory, 'Litch Chrome bridge'),
        ),
    })
  }
  private base: Installer
  get token(): string {
    return this.base.token
  }
  get extensionDirectory(): string {
    return this.base.extensionDirectory
  }
  get configPath(): string {
    return this.base.configPath
  }
  prepared(): Promise<boolean> {
    return this.base.prepared()
  }
  async prepare(): Promise<void> {
    // 同一实例的 token 必须稳定；只替换登记端口。
    await this.base.prepare()
    if (process.platform === 'win32' && !this.options.manifestDirectories)
      await promisify(execFile)(
        'reg.exe',
        [
          'add',
          CHROME_HOST_REGISTRY_KEY,
          '/ve',
          '/t',
          'REG_SZ',
          '/d',
          join(this.options.root, `${CHROME_HOST_NAME}.json`),
          '/f',
        ],
        { windowsHide: true },
      )
  }
}
