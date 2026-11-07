import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const fixture = {
  root: '',
  feed: '',
  checks: 0,
  failPrepare: false,
  installs: [] as string[],
  download: async (_url: string): Promise<Response> => {
    throw new Error('未设置网络夹具')
  },
}
export const net = { fetch: (url: string) => fixture.download(url) }
export const app = {
  getPath: (name: string) =>
    name === 'home' ? fixture.root : join(fixture.root, 'A.app/Contents/MacOS/A'),
  quit() {
    const request = JSON.parse(readFileSync(shipItFile(), 'utf8'))
    if (!request.launchAfterInstallation) throw new Error('必须由 ShipIt 在安装后重开')
    fixture.installs.push(readFileSync(new URL(`${sourceOf()}/version`), 'utf8'))
  },
}
export const shipItFile = () =>
  join(fixture.root, 'Library/Caches/dev.litch.update-test.ShipIt/ShipItState.plist')
const sourceOf = () => JSON.parse(readFileSync(shipItFile(), 'utf8')).updateBundleURL

export const autoUpdater = Object.assign(new EventEmitter(), {
  setFeedURL({ url }: { url: string }) {
    fixture.feed = url
  },
  checkForUpdates() {
    fixture.checks++
    void (async () => {
      const directory = join(fixture.root, 'Library/Caches/dev.litch.update-test.ShipIt')
      mkdirSync(directory, { recursive: true })
      // 模拟原生 setFeedURL 重建后会发生的清理，保护副本必须不受影响。
      for (const name of readdirSync(directory)) {
        if (name.startsWith('update.'))
          rmSync(join(directory, name), { recursive: true, force: true })
      }
      const offer = (await (await fetch(fixture.feed)).json()) as {
        name: string
        url: string
        size: number
        sha256: string
      }
      const response = await fixture.download(offer.url)
      if (response.status === 304) {
        autoUpdater.emit('update-not-available')
        return
      }
      if (!response.ok) throw new Error('下载失败')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (
        bytes.length !== offer.size ||
        createHash('sha256').update(bytes).digest('hex') !== offer.sha256
      ) {
        throw new Error('校验失败')
      }
      const bundle = join(directory, `update.${fixture.checks}`, 'A.app')
      mkdirSync(bundle, { recursive: true })
      writeFileSync(join(bundle, 'version'), bytes)
      writeFileSync(
        shipItFile(),
        JSON.stringify({
          updateBundleURL: pathToFileURL(bundle).href,
          targetBundleURL: pathToFileURL(join(fixture.root, 'A.app')).href,
          bundleIdentifier: 'dev.litch.update-test',
          launchAfterInstallation: false,
          useUpdateBundleName: false,
        }),
      )
      if (fixture.failPrepare) throw new Error('ShipIt 启动失败')
      autoUpdater.emit('update-downloaded', {}, '', offer.name)
    })().catch((error) => autoUpdater.emit('error', error))
  },
  quitAndInstall() {
    fixture.installs.push(readFileSync(new URL(`${sourceOf()}/version`), 'utf8'))
  },
})
