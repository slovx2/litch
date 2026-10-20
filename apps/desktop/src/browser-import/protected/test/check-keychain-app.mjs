// 打包一个只带假查询的隔离应用，验证资源布局、临时签名和 Litch 进程内的原生加载。
// 不打开真实 Litch，不读取任何浏览器或系统钥匙串。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walk } from '@electron/osx-sign'
import { packager } from '@electron/packager'
import { build } from 'esbuild'
import { signAdHoc } from '../../../../scripts/sign.mjs'
import { buildKeychain, NATIVE_DIRECTORY } from '../native/build.mjs'

if (process.platform !== 'darwin') throw new Error('本检查仅适用于 macOS。')
const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'litch-keychain-app-'))
try {
  const stage = join(temporary, 'stage')
  mkdirSync(join(stage, 'dist'), { recursive: true })
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify({
      name: 'litch-keychain-test',
      version: '1.0.0',
      main: 'dist/main.mjs',
      type: 'module',
    }),
  )
  const native = buildKeychain({
    out: join(temporary, NATIVE_DIRECTORY),
    querySource: here('fake-keychain.c'),
  })
  await build({
    stdin: {
      contents: `
        import assert from 'node:assert/strict'
        import { createRequire } from 'node:module'
        import { join } from 'node:path'
        import { app } from 'electron'
        import { readMacKeychain } from './mac-keychain.mts'
        app.setPath('userData', process.env.LITCH_KEYCHAIN_TEST_HOME)
        app.whenReady().then(async () => { try {
          const addon = createRequire(import.meta.url)(join(process.resourcesPath, 'browser-import-native', 'keychain.node'))
          assert.deepEqual(addon.identity(), { name: 'Litch Keychain Test', identifier: 'io.github.slovx2.litch.keychain-test' })
          const bytes = await readMacKeychain('chrome', new AbortController().signal)
          assert.deepEqual(bytes, Buffer.from([32, 107, 0, 121, 10]))
          bytes.fill(0)
          console.log('KEYCHAIN_APP_OK')
          app.exit(0)
        } catch { console.error('KEYCHAIN_APP_FAILED'); app.exit(1) } })
      `,
      resolveDir: here('..'),
      sourcefile: 'keychain-app-probe.mjs',
    },
    outfile: join(stage, 'dist', 'main.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['electron'],
  })
  const [packed] = await packager({
    dir: stage,
    out: join(temporary, 'out'),
    name: 'Litch Keychain Test',
    appBundleId: 'io.github.slovx2.litch.keychain-test',
    platform: 'darwin',
    arch: process.arch,
    electronVersion: createRequire(import.meta.url)('electron/package.json').version,
    asar: true,
    extraResource: [native],
    prune: false,
    quiet: true,
  })
  const appPath = join(packed, 'Litch Keychain Test.app')
  const resources = join(appPath, 'Contents', 'Resources')
  mkdirSync(join(resources, 'adapter'))
  const addon = join(resources, NATIVE_DIRECTORY, 'keychain.node')
  assert.ok(signAdHoc(appPath).includes(addon))
  // 正式签名使用 osx-sign 的遍历器；确认新资源也会纳入。
  assert.ok((await walk(join(appPath, 'Contents'))).includes(addon))
  const env = { ...process.env, LITCH_KEYCHAIN_TEST_HOME: join(temporary, 'profile') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const output = execFileSync(join(appPath, 'Contents', 'MacOS', 'Litch Keychain Test'), [], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.ok(output.includes('KEYCHAIN_APP_OK'))
  console.log('隔离打包应用：资源定位、签名、应用身份、原生密钥传输均通过。')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
