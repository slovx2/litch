// Node-API 8 不依赖 Electron 的模块 ABI；只用构建机 Node 自带的头文件，不下载依赖。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const NATIVE_DIRECTORY = 'browser-import-native'

export function buildKeychain({ out, querySource = join(here, 'keychain.c') } = {}) {
  if (process.platform !== 'darwin') return undefined
  const destination = out ?? resolve(here, '../../../../dist', NATIVE_DIRECTORY)
  const candidates = [
    process.env.LITCH_NODE_HEADERS,
    resolve(dirname(realpathSync(process.execPath)), '../include/node'),
  ].filter(Boolean)
  const headers = candidates.find((path) => existsSync(join(path, 'node_api.h')))
  if (!headers)
    throw new Error('找不到 Node 的 include/node；请用 Node 24 构建，或设置 LITCH_NODE_HEADERS。')
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildKeychain()
