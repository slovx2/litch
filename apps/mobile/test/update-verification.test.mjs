// 走实际下载状态机：换源不会省略 APK 校验。原生检查结果由替身给出，不能代替系统安装验收。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { natives } from './stubs/expo-modules-core.mjs'

const moduleURL = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const files = new URL('./stubs/expo-file-system.mjs', import.meta.url).href
const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react-native')
      return {
        shortCircuit: true,
        url: moduleURL(`export const Platform = { OS: 'android' }; export const AppState = {};`),
      }
    if (specifier === 'expo-file-system')
      return {
        shortCircuit: true,
        url: moduleURL(`
        export { Paths } from ${JSON.stringify(files)};
        import { File as StoredFile } from ${JSON.stringify(files)};
        export class Directory { exists = false; create() {} }
        export class File extends StoredFile {
          static async downloadFileAsync(url, target) {
            globalThis.updateDownloads.push(url);
            return { size: globalThis.updateSize, uri: 'file:///test.apk', exists: true, delete() {} };
          }
        }
      `),
      }
    if (specifier.endsWith('/app.json'))
      return {
        shortCircuit: true,
        url: moduleURL(`export default ${JSON.stringify(app)}`),
      }
    return next(specifier, context)
  },
})
const store = await import('../src/update/store.ts')
const { handleDevLink } = await import('../src/shell/dev-links.ts')
hooks.deregister()

test('E2E 换源后仍依次检查大小、摘要、包名、版本和签名，检查清单不自动下载', async () => {
  const fetchBefore = globalThis.fetch
  const hash = 'a'.repeat(64)
  let inspected = 0
  let installed = 0
  let info
  let checksum
  const fetched = []
  globalThis.fetch = async (url) => {
    fetched.push(url)
    return {
      ok: true,
      json: async () => ({
        version: '99.0.0',
        assets: {
          'android-arm64': { url: 'http://fixture.invalid/app.apk', sha256: hash, size: 1 },
        },
      }),
    }
  }
  natives.LitchUpdate = {
    sha256: async () => checksum,
    inspect: async () => {
      inspected++
      return info
    },
    canInstall: () => true,
    install: () => {
      installed++
    },
  }
  try {
    for (const failure of [
      'size',
      'checksum',
      'package',
      'version',
      'signature',
      'unknown',
      null,
    ]) {
      globalThis.updateDownloads = []
      globalThis.updateSize = failure === 'size' ? 2 : 1
      checksum = failure === 'checksum' ? 'b'.repeat(64) : hash
      inspected = 0
      installed = 0
      info = {
        packageName: failure === 'package' ? 'unrelated.app' : app.expo.android.package,
        versionCode: failure === 'version' ? 1 : 2,
        installedVersionCode: 1,
        sameSigner: failure === 'signature' ? false : failure === 'unknown' ? null : true,
      }
      handleDevLink('litch://update?feed=http://fixture.invalid/feed', null)
      await store.checkForUpdate()
      assert.equal(fetched.at(-1), 'http://fixture.invalid/feed')
      assert.equal(store.getUpdate().state.phase, 'available')
      assert.deepEqual(globalThis.updateDownloads, [])
      await store.downloadUpdate()
      assert.equal(inspected, ['size', 'checksum'].includes(failure) ? 0 : 1)
      if (failure && failure !== 'unknown') {
        assert.equal(store.getUpdate().state.reason, failure === 'version' ? 'package' : failure)
        assert.equal(installed, 0)
        assert.equal(store.getUpdate().apk, null)
      } else {
        // 现有行为：旧 Android/签名不可读时交给系统安装器；不是绕过 Android 的签名校验。
        assert.equal(store.getUpdate().state.phase, 'ready')
        assert.equal(installed, 1)
      }
    }
  } finally {
    globalThis.fetch = fetchBefore
    delete natives.LitchUpdate
    delete globalThis.updateDownloads
    delete globalThis.updateSize
  }
})
