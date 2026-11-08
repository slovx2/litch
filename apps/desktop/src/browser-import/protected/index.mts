// Litch 的接线入口；实现只在通用浏览器包维护。

import { systemSecrets } from '../../../../../third_party/litch-automation/packages/browser/src/browser-import/protected/chromium-crypto.mjs'
import { createProtectedReader as createReader } from '../../../../../third_party/litch-automation/packages/browser/src/browser-import/protected/index.mjs'
import { defaultRuntime } from './mac-keychain.mjs'
import { runCommand } from './process.mjs'
export function createProtectedReader() {
  return createReader({
    platform: process.platform,
    secrets: systemSecrets(runCommand, defaultRuntime()),
  })
}
