// Litch 原生资源构建位置；通用读取器的构建实现由包提供。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildKeychain as build } from '../../../../../../third_party/litch-automation/packages/browser/native/build.mjs'

export { NATIVE_DIRECTORY } from '../../../../../../third_party/litch-automation/packages/browser/native/build.mjs'
export function buildKeychain(options = {}) {
  return build({
    out: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../dist/browser-import-native'),
    nodeHeaders: process.env.LITCH_NODE_HEADERS,
    ...options,
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildKeychain()
