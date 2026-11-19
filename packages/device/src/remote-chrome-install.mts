// 登记从 Chrome 所在用户的终端准备，服务重启只刷新自己拥有的宿主的本机端点。
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { chromeClaimDirectory } from '../../../third_party/litch-automation/packages/chrome-bridge/src/claim-directory.mjs'
import {
  applyRegistration,
  FileRegistrationStore,
  sameOwnerPolicy,
} from '../../../third_party/litch-automation/packages/chrome-bridge/src/registration.mjs'
import {
  CHROME_HOST_NAME,
  CHROME_STORE_URL,
  chromeExtensionIds,
} from '../../protocol/src/chrome-browser.mjs'
import { configureDeviceChrome, readDeviceChromeStatus } from './remote-chrome-status.mjs'

export const quoteChromePath = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`
const systemHost = '/etc/opt/chrome/native-messaging-hosts'

export function chromeManifestDirectory(env = process.env): string {
  const base = env.CHROME_CONFIG_HOME || env.XDG_CONFIG_HOME || join(homedir(), '.config')
  if (!isAbsolute(base)) throw new Error('The Chrome configuration root must be an absolute path.')
  return join(base, 'google-chrome', 'NativeMessagingHosts')
}

export async function writePrivateChromeFile(file: string, body: string, mode = 0o600) {
  const temporary = `${file}.${randomUUID()}.new`
  await writeFile(temporary, body, { mode, flag: 'wx' })
  try {
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export class DeviceChromeInstall {
  readonly token = randomBytes(32).toString('hex')
  readonly adminToken = randomBytes(32).toString('hex')
  readonly launcher: string
  readonly config: string
  readonly adminProof: string
  readonly enabledFile: string

  readonly root: string

  constructor(root: string) {
    this.root = root
    this.launcher = join(root, 'native-host')
    this.config = join(root, 'native-config.json')
    this.adminProof = join(root, 'admin-token')
    this.enabledFile = join(root, 'enabled')
  }

  private get registration(): string {
    return join(this.root, 'registration.json')
  }

  async privateRoot(): Promise<void> {
    if (process.platform !== 'linux' || !process.getuid)
      throw new Error('Device Chrome is available on Linux.')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
      throw new Error('The device Chrome directory must be private and owned by this Linux user.')
  }

  async inspect(): Promise<'unprepared' | 'conflict' | 'owned'> {
    const registration = await readFile(this.registration, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (registration === null) return 'unprepared'
    const directory: unknown = JSON.parse(registration)
    if (typeof directory !== 'string' || !isAbsolute(directory))
      throw new Error('Invalid device Chrome registration path.')
    const system = (await new FileRegistrationStore(systemHost, '').inspect(CHROME_HOST_NAME))
      .registration
    if (system) return 'conflict'
    const found = (await new FileRegistrationStore(directory, '').inspect(CHROME_HOST_NAME))
      .registration
    if (found?.ownerId !== this.launcher) return found ? 'conflict' : 'unprepared'
    const launcher = await lstat(this.launcher).catch(() => null)
    return launcher?.isFile() &&
      launcher.uid === process.getuid?.() &&
      (launcher.mode & 0o077) === 0
      ? 'owned'
      : 'unprepared'
  }

  async prepare(binary: string, directory: string): Promise<void> {
    await this.privateRoot()
    if (!isAbsolute(binary) || !(await lstat(binary)).isFile())
      throw new Error('The adapter executable is missing.')
    const known = await readFile(this.registration, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (known !== null && JSON.parse(known) !== directory)
      throw new Error('Device Chrome was prepared for another Chrome configuration directory.')
    const store = new FileRegistrationStore(directory, 'Litch device Chrome bridge')
    const desired = {
      hostName: CHROME_HOST_NAME,
      executable: this.launcher,
      ownerId: this.launcher,
      extensionIds: chromeExtensionIds(),
    }
    const signal = new AbortController().signal
    const system = (await new FileRegistrationStore(systemHost, '').inspect(CHROME_HOST_NAME))
      .registration
    const policy = await sameOwnerPolicy.decide(
      await store.inspect(CHROME_HOST_NAME),
      desired,
      signal,
    )
    // 先持久化选定的 Chrome 配置位置：发生冲突时设备页也能诊断。
    await writePrivateChromeFile(this.registration, JSON.stringify(directory))
    if (system || policy.decision === 'deny')
      throw new Error('The Chrome native host is already registered to another owner.')
    await this.writeLauncher(binary)
    await applyRegistration(store, sameOwnerPolicy, desired, signal)
  }

  /** 移除仅限自己拥有的当前登记；保留站点设置和独立状态。 */
  async unprepare(): Promise<void> {
    await this.privateRoot()
    const directory = await readFile(this.registration, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (directory === null) return
    const path: unknown = JSON.parse(directory)
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new Error('Invalid device Chrome registration path.')
    const store = new FileRegistrationStore(path, '')
    const current = await store.inspect(CHROME_HOST_NAME)
    if (current.registration && current.registration.ownerId !== this.launcher)
      throw new Error('The Chrome native host belongs to another owner; it was left untouched.')
    await writePrivateChromeFile(this.enabledFile, 'false')
    if (
      current.registration &&
      !(await store.remove(CHROME_HOST_NAME, this.launcher, current.revision))
    )
      throw new Error('Native host registration changed; run chrome status and try again.')
    await unlink(this.registration)
  }

  private async writeLauncher(binary: string): Promise<void> {
    await writePrivateChromeFile(
      this.launcher,
      `#!/bin/sh\nexec ${quoteChromePath(binary)} chrome-host --config ${quoteChromePath(this.config)} "$@"\n`,
      0o700,
    )
  }

  async connectTo(socketPath: string, binary?: string): Promise<void> {
    if ((await this.inspect()) !== 'owned')
      throw new Error('Device Chrome does not own its registration.')
    if (binary) await this.writeLauncher(binary)
    await writePrivateChromeFile(this.adminProof, this.adminToken)
    await writePrivateChromeFile(
      this.config,
      JSON.stringify({
        socketPath,
        token: this.token,
        extensionIds: chromeExtensionIds(),
        claimLockDirectory: chromeClaimDirectory(homedir(), 'linux'),
      }),
    )
  }

  enabledNow(): boolean {
    try {
      return readFileSync(this.enabledFile, 'utf8') === 'true'
    } catch {
      return false
    }
  }

  async enabled(): Promise<boolean> {
    return (
      (await readFile(this.enabledFile, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })) === 'true'
    )
  }
}

export async function deviceChromeCommand(
  command: string,
  stateDir: string,
  binary: string,
  userDataDir: string,
  site: string,
) {
  const install = new DeviceChromeInstall(join(stateDir, 'chrome'))
  if (['sites', 'trust-on', 'trust-off', 'block', 'unblock', 'forget'].includes(command)) {
    await install.privateRoot()
    const proof = await readFile(install.adminProof, 'utf8').catch(() => {
      throw new Error('Enable the device Chrome bridge before changing website permissions.')
    })
    if (command === 'sites' || command === 'trust-on' || command === 'trust-off')
      return configureDeviceChrome(stateDir, proof, { action: command })
    if (command === 'block' || command === 'unblock' || command === 'forget')
      return configureDeviceChrome(stateDir, proof, { action: command, site })
  }
  if (userDataDir && !isAbsolute(userDataDir))
    throw new Error('Chrome user data directory must be an absolute path.')
  if (command === 'prepare')
    await install.prepare(
      binary,
      userDataDir ? join(userDataDir, 'NativeMessagingHosts') : chromeManifestDirectory(),
    )
  else if (command === 'unprepare') await install.unprepare()
  else if (command === 'enable' || command === 'disable') {
    await install.privateRoot()
    if (command === 'enable' && (await install.inspect()) !== 'owned')
      throw new Error('Run chrome prepare as the Chrome user before enabling device Chrome.')
    await writePrivateChromeFile(install.enabledFile, String(command === 'enable'))
  } else if (command !== 'status') throw new Error('Unknown device Chrome command.')
  return {
    bridge: command === 'status' ? await readDeviceChromeStatus(stateDir) : null,
    registration: await install.inspect(),
    enabled: await install.enabled(),
    storeUrl: CHROME_STORE_URL,
  }
}
