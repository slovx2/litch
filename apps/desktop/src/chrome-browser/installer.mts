import { randomBytes } from 'node:crypto'
import { chmod, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHROME_HOST_NAME } from '../../../../packages/protocol/src/chrome-browser.mjs'

export interface ChromeInstallOptions {
  root: string
  assets: string
  nativeBinary: string
  socketPath: string
  /** 只给隔离验收指定，不来自模型或普通界面参数。 */
  manifestDirectory?: string
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
async function privateJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.new`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
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
    const { root, assets, nativeBinary, socketPath } = this.options
    const identity = await chromeIdentity(assets)
    if (!(await stat(nativeBinary)).isFile())
      throw new Error('Litch native host executable is missing.')
    await mkdir(root, { recursive: true, mode: 0o700 })
    await cp(assets, this.extensionDirectory, { recursive: true })
    await privateJson(this.configPath, { socketPath, token: this.token, extensionId: identity.id })
    const launcher = join(root, 'native-host')
    await writeFile(
      launcher,
      `#!/bin/sh\nexec ${quote(nativeBinary)} chrome-host --config ${quote(this.configPath)} "$@"\n`,
      { mode: 0o700 },
    )
    await chmod(launcher, 0o700)
    const directory =
      this.options.manifestDirectory ??
      join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await privateJson(join(directory, `${CHROME_HOST_NAME}.json`), {
      name: CHROME_HOST_NAME,
      description: 'Litch Chrome bridge',
      path: launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${identity.id}/`],
    })
  }
}
