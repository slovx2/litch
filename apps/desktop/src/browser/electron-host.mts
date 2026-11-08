// Litch 的接线入口；实现只在通用浏览器包维护。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { createElectronHost as createHost } from '../../../../third_party/litch-automation/packages/browser/src/browser/electron-host.mjs'
import { failurePage } from './forwarding.mjs'

export type {
  ElectronBrowserHost,
  Rect,
} from '../../../../third_party/litch-automation/packages/browser/src/browser/electron-host.mjs'
export function createElectronHost() {
  const host = createHost({
    partition: 'persist:litch-browser',
    autofillPreload: join(dirname(fileURLToPath(import.meta.url)), 'autofill-preload.cjs'),
    failurePage,
    blockedDownload: (name) =>
      `A download (${name}) was blocked: the Litch browser does not download files.`,
    downloads: {
      stagingRoot: join(app.getPath('userData'), 'browser', 'download-staging'),
      downloadsDirectory: app.getPath('downloads'),
    },
  })
  app.on('will-quit', () => host.downloads?.dispose())
  return host
}
