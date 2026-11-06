import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ChromeHostIdentity,
  type RegistrationPolicy,
  type RegistrationStore,
  validateChromeIdentity,
} from '../../automation-contracts/src/chrome.mjs'
import { sameOwnerPolicy } from './registration.mjs'

export interface ChromeInstallOptions {
  root: string
  assets: string
  nativeBinary: string
  socketPath: string
  identity: ChromeHostIdentity
  /** 完整 CHA 用 ['chrome-host']；独立 Go 入口用 []。 */
  nativeArgs: readonly string[]
  registrations: readonly RegistrationStore[] | (() => Promise<readonly RegistrationStore[]>)
  registrationPolicy?: RegistrationPolicy
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Chrome 在 Windows 上经 cmd.exe 起宿主，所以启动脚本是 .bat；% 在批处理里要写成 %%。 */
function launcherOf(
  root: string,
  binary: string,
  config: string,
  args: readonly string[],
): { path: string; text: string } {
  if (process.platform === 'win32') {
    const bat = (value: string) => `"${value.replaceAll('%', '%%')}"`
    return {
      path: join(root, 'native-host.bat'),
      text: `@echo off\r\n${[binary, ...args].map(bat).join(' ')} --config ${bat(config)} %*\r\n`,
    }
  }
  return {
    path: join(root, 'native-host'),
    text: `#!/bin/sh\nexec ${[binary, ...args].map(quote).join(' ')} --config ${quote(config)} "$@"\n`,
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
    validateChromeIdentity(options.identity)
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
  async prepare(signal = new AbortController().signal): Promise<void> {
    const { root, assets, nativeBinary, socketPath, identity } = this.options
    signal.throwIfAborted()
    if (!nativeBinary || !(await stat(nativeBinary)).isFile())
      throw new Error(`${identity.productName} native host executable is missing.`)
    const launcher = launcherOf(root, nativeBinary, this.configPath, this.options.nativeArgs)
    const desired = {
      hostName: identity.hostName,
      executable: launcher.path,
      ownerId: launcher.path,
      extensionIds: identity.extensionIds,
    }
    const policy = this.options.registrationPolicy ?? sameOwnerPolicy
    const registrations =
      typeof this.options.registrations === 'function'
        ? await this.options.registrations()
        : this.options.registrations
    if (!registrations.length) throw new Error('Native host registration store is required')
    const plans = []
    for (const store of registrations) {
      const decision = await policy.decide(await store.inspect(identity.hostName), desired, signal)
      if (decision.decision === 'deny') throw new Error(decision.reason)
      if (JSON.stringify(decision.plan.desired) !== JSON.stringify(desired))
        throw new Error('Registration policy changed identity')
      plans.push({ store, plan: decision.plan })
    }
    signal.throwIfAborted()
    await mkdir(root, { recursive: true, mode: 0o700 })
    await copyExtension(assets, this.extensionDirectory)
    await privateJson(this.configPath, {
      socketPath,
      token: this.token,
      extensionIds: identity.extensionIds,
    })
    await writeFile(launcher.path, launcher.text, { mode: 0o700 })
    await chmod(launcher.path, 0o700)
    for (const { store, plan } of plans) await store.apply(plan, signal)
  }
}

export const prepareNativeHost = async (
  options: ChromeInstallOptions,
  signal?: AbortSignal,
): Promise<ChromeInstaller> => {
  const installer = new ChromeInstaller(options)
  await installer.prepare(signal)
  return installer
}
