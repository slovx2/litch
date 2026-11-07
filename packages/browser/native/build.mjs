// Node-API 8 不依赖 Electron 的模块 ABI；只用构建机 Node 自带的头文件，不下载依赖。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const NATIVE_DIRECTORY = 'browser-import-native'

export function buildKeychain({ out, nodeHeaders, querySource = join(here, 'keychain.c') } = {}) {
  if (process.platform !== 'darwin') return undefined
  if (!out) throw new Error('宿主必须指定原生模块输出目录')
  const destination = resolve(out)
  const candidates = [
    nodeHeaders,
    resolve(dirname(realpathSync(process.execPath)), '../include/node'),
  ].filter(Boolean)
  const headers = candidates.find((path) => existsSync(join(path, 'node_api.h')))
  if (!headers)
    throw new Error('找不到 Node 的 include/node；请用 Node 24 构建，或传入 nodeHeaders。')
  mkdirSync(destination, { recursive: true })
  execFileSync(
    '/usr/bin/xcrun',
    [
      'clang',
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fvisibility=hidden',
      '-DNAPI_VERSION=8',
      '-mmacosx-version-min=12.0',
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-I',
      headers,
      '-I',
      here,
      join(here, 'addon.c'),
      querySource,
      '-framework',
      'Security',
      '-framework',
      'CoreFoundation',
      '-o',
      join(destination, 'keychain.node'),
    ],
    { stdio: 'inherit' },
  )
  cpSync(join(here, 'keychain-helper.mjs'), join(destination, 'keychain-helper.mjs'))
  return destination
}
