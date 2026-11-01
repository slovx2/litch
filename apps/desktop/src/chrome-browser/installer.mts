import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
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

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

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

/** Chrome 在 Windows 上经 cmd.exe 起宿主，所以启动脚本是 .bat；% 在批处理里要写成 %%。 */
function launcherOf(root: string, binary: string, config: string): { path: string; text: string } {
  if (process.platform === 'win32') {
    const bat = (value: string) => `"${value.replaceAll('%', '%%')}"`
    return {
      path: join(root, 'native-host.bat'),
      text: `@echo off\r\n${bat(binary)} chrome-host --config ${bat(config)} %*\r\n`,
    }
  }
  return {
    path: join(root, 'native-host'),
    text: `#!/bin/sh\nexec ${quote(binary)} chrome-host --config ${quote(config)} "$@"\n`,
  }
}
async function privateJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.new`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}

/**
 * 打包后扩展在 app.asar 里，Electron 的 asar 补丁不支持 fs.cp，只能逐个文件读写。
 * 构建产物是平铺的几个文件，遇到子目录直接报错，免得漏拷。
 */
async function copyExtension(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Unexpected entry in Chrome extension: ${entry.name}`)
    await writeFile(join(to, entry.name), await readFile(join(from, entry.name)))
  }
}

export async function chromeIdentity(assets: string): Promise<{ id: string; version: string }> {
  return JSON.parse(await readFile(join(assets, 'identity.json'), 'utf8'))
}

export class ChromeInstaller {
  readonly token = randomBytes(32).toString('hex')
  readonly extensionDirectory: string
  readonly configPath: string
  private options: ChromeInstallOptions
  constructor(options: ChromeInstallOptions) {
    this.options = options
    this.extensionDirectory = join(options.root, 'extension')
    this.configPath = join(options.root, 'native-config.json')
  }
  async prepared(): Promise<boolean> {
    return stat(join(this.extensionDirectory, 'manifest.json')).then(
      () => true,
      () => false,
    )
  }
  async prepare(): Promise<void> {
    const { root, assets, nativeBinary, socketPath, extensionIds } = this.options
    if (!nativeBinary || !(await stat(nativeBinary)).isFile())
      throw new Error('Litch native host executable is missing.')
    await mkdir(root, { recursive: true, mode: 0o700 })
    await copyExtension(assets, this.extensionDirectory)
    await privateJson(this.configPath, { socketPath, token: this.token, extensionIds })
    const launcher = launcherOf(root, nativeBinary, this.configPath)
    await writeFile(launcher.path, launcher.text, { mode: 0o700 })
    await chmod(launcher.path, 0o700)
    const manifest = {
      name: CHROME_HOST_NAME,
      description: 'Litch Chrome bridge',
      path: launcher.path,
      type: 'stdio',
      allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
    }
    const directories = this.options.manifestDirectories ?? (await manifestDirectories(root))
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await privateJson(join(directory, `${CHROME_HOST_NAME}.json`), manifest)
    }
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
          join(root, `${CHROME_HOST_NAME}.json`),
          '/f',
        ],
        { windowsHide: true },
      )
  }
}
