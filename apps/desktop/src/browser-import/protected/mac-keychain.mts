// Litch 的接线入口；实现只在通用浏览器包维护。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type MacKeychainRuntime,
  readMacKeychain as read,
} from '../../../../../packages/browser/src/browser-import/protected/mac-keychain.mjs'
import type { BrowserId } from '../types.mjs'
import { runCommand } from './process.mjs'

export type { MacKeychainRuntime }
export function defaultRuntime(): MacKeychainRuntime {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resources && join(resources, 'browser-import-native')
  const directory =
    packaged && existsSync(join(packaged, 'keychain.node'))
      ? packaged
      : join(dirname(fileURLToPath(import.meta.url)), 'browser-import-native')
  return { executable: process.execPath, directory, run: runCommand }
}
export function readMacKeychain(
  browser: BrowserId,
  signal: AbortSignal,
  runtime = defaultRuntime(),
) {
  return read(browser, signal, runtime)
}
