// Litch 的接线入口；实现只在通用浏览器包维护。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronHost as createHost } from '../../../../packages/browser/src/browser/electron-host.mjs'
import { failurePage } from './forwarding.mjs'

export type {
  ElectronBrowserHost,
  Rect,
} from '../../../../packages/browser/src/browser/electron-host.mjs'
export function createElectronHost() {
  return createHost({
    partition: 'persist:litch-browser',
    autofillPreload: join(dirname(fileURLToPath(import.meta.url)), 'autofill-preload.cjs'),
    failurePage,
    blockedDownload: (name) =>
      `A download (${name}) was blocked: the Litch browser does not download files.`,
  })
}
