// Electron 44 的 setFeedURL 会重建 SQRLUpdater；其 housekeeping 会删除 update.*。
// 已验证的旧包先复制到我们的目录，并原子更新 ShipIt 请求，之后才允许下一次检查。
// 即使连续失败或用户在下载中退出，ShipIt 始终有一份完整的待装包。
// 依据：Electron v44.7.0/DEPS 固定的 Squirrel fffea30（SQRLUpdater.m、SQRLShipItRequest.m）。
// 升级 Electron 时必须重跑 check-updater-mac.mjs，验证请求格式与原生安装行为。
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { UpdateOffer } from '@litch/core'
import { app, autoUpdater } from 'electron'

const exec = promisify(execFile)

interface ShipItRequest {
  updateBundleURL: string
  targetBundleURL: string
  bundleIdentifier: string
  launchAfterInstallation: boolean
  useUpdateBundleName: boolean
}

/** 独立出来供磁盘回归验证；只接触当前应用的 ShipIt 请求和自己的备份目录。 */
export class PendingMacUpdate {
  private readonly stateFile: string
  private readonly target: string
  private readonly directory: string

  constructor(stateFile: string, target: string, directory: string) {
    this.stateFile = stateFile
    this.target = target
    this.directory = directory
  }

  private async read(): Promise<ShipItRequest> {
    const request = JSON.parse(await readFile(this.stateFile, 'utf8')) as ShipItRequest
    if (
      typeof request.updateBundleURL !== 'string' ||
      typeof request.targetBundleURL !== 'string' ||
      resolve(fileURLToPath(request.targetBundleURL)) !== resolve(this.target)
    )
      throw new Error('待安装更新不属于当前应用，已保留原状')
    return request
  }

  private async write(request: ShipItRequest): Promise<void> {
    const temporary = `${this.stateFile}.${randomUUID()}`
    try {
      await writeFile(temporary, JSON.stringify(request), { mode: 0o600 })
      await rename(temporary, this.stateFile)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async protect(): Promise<ShipItRequest> {
    const request = await this.read()
    const source = fileURLToPath(request.updateBundleURL)
    if (dirname(dirname(source)) === this.directory) return request
    const folder = join(this.directory, randomUUID())
    const target = join(folder, basename(source))
    await mkdir(folder, { recursive: true })
    try {
      // ditto 保留应用签名所需的符号链接、权限及扩展属性。
      await exec('/usr/bin/ditto', [source, target])
      const current = await this.read()
      if (JSON.stringify(current) !== JSON.stringify(request)) {
        throw new Error('待安装更新已被其他进程更改')
      }
      const protectedRequest = { ...request, updateBundleURL: pathToFileURL(target).href }
      await this.write(protectedRequest)
      return protectedRequest
    } catch (error) {
      await rm(folder, { recursive: true, force: true })
      throw error
    }
  }

  async restore(request: ShipItRequest): Promise<void> {
    const current = await this.read()
    if (current.updateBundleURL === request.updateBundleURL) return
    await this.write({
      ...request,
      // 用户可能已在下载期间点了重启；恢复旧包时不能撤回这次重开请求。
      launchAfterInstallation: current.launchAfterInstallation || request.launchAfterInstallation,
    })
  }

  async discard(request: ShipItRequest): Promise<void> {
    const folder = dirname(fileURLToPath(request.updateBundleURL))
    if (dirname(folder) === this.directory) await rm(folder, { recursive: true, force: true })
  }

  async relaunch(): Promise<void> {
    await this.write({ ...(await this.read()), launchAfterInstallation: true })
  }
}

/** 原生收到 304 等空结果会清掉 available 标志，但我们仍持有已验证的 ShipIt 请求。 */
export async function relaunchMacUpdate(dataDir: string): Promise<void> {
  await (await pendingUpdate(dataDir)).relaunch()
  app.quit()
}

async function pendingUpdate(dataDir: string): Promise<PendingMacUpdate> {
  const contents = dirname(dirname(app.getPath('exe')))
  const { stdout } = await exec('/usr/libexec/PlistBuddy', [
    '-c',
    'Print:CFBundleIdentifier',
    join(contents, 'Info.plist'),
  ])
  const identifier = stdout.trim()
  if (!/^[a-zA-Z0-9.-]+$/.test(identifier)) throw new Error('应用标识无效')
  return new PendingMacUpdate(
    join(app.getPath('home'), 'Library', 'Caches', `${identifier}.ShipIt`, 'ShipItState.plist'),
    dirname(contents),
    join(dataDir, 'updates', 'squirrel-ready'),
  )
}

/** 固定本次要下的版本，避免 Squirrel 再读 latest 时拿到另一份清单。 */
export async function downloadMacUpdate(
  offer: UpdateOffer,
  dataDir: string,
  hasReady: boolean,
  log: (message: string) => void,
): Promise<void> {
  const pending = await pendingUpdate(dataDir)
  const previous = hasReady ? await pending.protect() : null
  const token = `/${randomUUID()}`
  const server = createServer((request, response) => {
    if (request.url !== token) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(
      JSON.stringify({
        url: offer.asset.url,
        name: offer.version,
        notes: '',
        sha256: offer.asset.sha256,
        size: offer.asset.size,
      }),
    )
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动更新清单服务')
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        autoUpdater.off('error', failed)
        autoUpdater.off('update-not-available', unavailable)
        autoUpdater.off('update-downloaded', downloaded)
      }
      const failed = (error: Error) => {
        clean()
        reject(error)
      }
      const unavailable = () => failed(new Error('Squirrel 未下载指定的更新'))
      const downloaded = () => {
        clean()
        resolve()
      }
      autoUpdater.on('error', failed)
      autoUpdater.on('update-not-available', unavailable)
      autoUpdater.on('update-downloaded', downloaded)
      try {
        autoUpdater.setFeedURL({ url: `http://127.0.0.1:${address.port}${token}` })
        autoUpdater.checkForUpdates()
      } catch (error) {
        failed(error as Error)
      }
    })
    if (previous) await pending.discard(previous).catch((error) => log(`清理旧更新失败：${error}`))
  } catch (error) {
    // prepareUpdateForInstallation 写了新请求后，启动 ShipIt 仍可能失败。
    if (previous) await pending.restore(previous)
    throw error
  } finally {
    server.close()
    server.closeAllConnections()
  }
}
