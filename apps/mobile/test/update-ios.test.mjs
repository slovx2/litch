import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const moduleURL = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const files = new URL('./stubs/expo-file-system.mjs', import.meta.url).href
const app = new URL('../app.json', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react-native') {
      return {
        shortCircuit: true,
        url: moduleURL(`export const Platform = { OS: 'ios' };
          export const AppState = { addEventListener() { throw Error('iOS 不应注册 APK 更新恢复'); } };`),
      }
    }
    if (specifier === 'expo-file-system') {
      return {
        shortCircuit: true,
        url: moduleURL(`export { File, Paths } from ${JSON.stringify(files)};
          export class Directory { constructor() { throw Error('iOS 不应创建 APK 目录'); } }`),
      }
    }
    if (specifier.endsWith('/app.json')) {
      return { shortCircuit: true, url: moduleURL(`export default ${readFileSync(app, 'utf8')}`) }
    }
    return next(specifier, context)
  },
})
const store = await import('../src/update/store.ts')
const { setFeedOverride } = await import('../src/update/override.ts')
hooks.deregister()

test('iOS：检查、下载、安装、后台调度和更新深链均不进入 APK 流程', async () => {
  const fetchBefore = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('iOS 不应请求 Android 更新源')
  }
  try {
    await store.checkForUpdate()
    await store.downloadUpdate()
    store.installUpdate()
    store.startUpdateSchedule(() => true)()
    setFeedOverride('http://127.0.0.1:9876/feed.json')
    assert.equal(store.getUpdate().state.phase, 'idle')
    assert.equal(store.getUpdate().needsPermission, false)
    assert.equal(store.getUpdate().offer, null)
  } finally {
    globalThis.fetch = fetchBefore
  }
})
