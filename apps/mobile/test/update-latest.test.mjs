// 真状态机、内存 APK 与原生校验替身；断言安装入口指向的文件，而不只看版本文案。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { natives } from './stubs/expo-modules-core.mjs'

const moduleURL = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react-native')
      return {
        shortCircuit: true,
        url: moduleURL(`
      export const Platform = { OS: 'android' };
      export const AppState = { currentState: 'active', addEventListener(_, handler) {
        globalThis.updateLatest.foreground = handler; return { remove() {} };
      } };`),
      }
    if (specifier === 'expo-file-system')
      return {
        shortCircuit: true,
        url: moduleURL(`
      export const Paths = { cache: 'file:///cache', document: 'file:///documents' };
      export class Directory {
        constructor(path, name) { this.uri = path + '/' + name }
        get exists() { return true }
        create() {}
        delete() { globalThis.updateLatest.files.clear() }
      }
      export class File {
        constructor(dir, name) { this.uri = name ? (typeof dir === 'string' ? dir : dir.uri) + '/' + name : dir }
        get exists() { return globalThis.updateLatest.files.has(this.uri) }
        get size() { return globalThis.updateLatest.files.get(this.uri)?.length ?? 0 }
        delete() { globalThis.updateLatest.files.delete(this.uri) }
        static async downloadFileAsync(url, target, options) {
          const f = globalThis.updateLatest; f.downloads.push(url);
          if (f.pause) await f.pause;
          if (f.failure === 'network') throw Error('断网');
          const version = url.split('/').at(-1);
          f.files.set(target.uri, f.failure === 'size' ? 'x' : version);
          options.onProgress({ bytesWritten: version.length, totalBytes: version.length });
          return target;
        }
      }`),
      }
    if (specifier.endsWith('/app.json'))
      return { shortCircuit: true, url: moduleURL(`export default ${JSON.stringify(app)}`) }
    return next(specifier, context)
  },
})
const { UPDATE_CHECK_INTERVAL_MS } = await import('@litch/core')
let count = 0
const hash = (text) => createHash('sha256').update(text).digest('hex')

async function setup() {
  const f = {
    version: '99.0.1',
    files: new Map(),
    downloads: [],
    installed: [],
    failure: '',
    pause: null,
    feeds: 0,
  }
  globalThis.updateLatest = f
  const store = await import(`../src/update/store.ts?fixture=${count++}`)
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    f.feeds++
    if (f.failure === 'feed') throw Error('清单断网')
    return Response.json({
      version: f.version,
      assets: {
        'android-arm64': {
          url: `https://fixture.invalid/${f.version}`,
          size: f.version.length,
          sha256: hash(f.version),
          versionCode: 100,
        },
      },
    })
  }
  natives.LitchUpdate = {
    sha256: async (uri) => (f.failure === 'checksum' ? '0'.repeat(64) : hash(f.files.get(uri))),
    inspect: async (uri) => ({
      packageName: app.expo.android.package,
      versionName: f.failure === 'version' ? '88.0.0' : f.files.get(uri),
      versionCode: 100,
      installedVersionCode: 1,
      sameSigner: f.failure !== 'signature',
    }),
    canInstall: () => true,
    install: (uri) => {
      assert.ok(f.files.has(uri))
      f.installed.push(f.files.get(uri))
    },
  }
  return {
    f,
    store,
    close() {
      globalThis.fetch = original
      delete natives.LitchUpdate
    },
  }
}

test('Android：首次等用户下载，待安装时后台替换最新版，下载中旧包可安装', async () => {
  const { f, store, close } = await setup()
  try {
    await store.checkForUpdate()
    assert.equal(f.downloads.length, 0)
    await store.downloadUpdate()
    assert.deepEqual(f.installed, ['99.0.1'])
    const old = store.getUpdate().apk
    f.version = '99.0.2'
    let release
    f.pause = new Promise((resolve) => {
      release = resolve
    })
    const check = store.checkForUpdate()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.downloads.length, 2)
    assert.equal(store.getUpdate().state.version, '99.0.1')
    store.installUpdate()
    assert.equal(f.installed.at(-1), '99.0.1')
    await store.checkForUpdate() // 在下时不能再开第二份下载
    release()
    await check
    assert.equal(store.getUpdate().state.version, '99.0.2')
    assert.equal(store.getUpdate().offer.version, '99.0.2')
    assert.equal(f.files.has(old), false)
    assert.equal(f.installed.length, 2) // 后台更新不擅自弹系统安装器
    store.installUpdate()
    assert.equal(f.installed.at(-1), '99.0.2')
    for (const version of ['99.0.2', '99.0.1', '0.0.0']) {
      f.version = version
      await store.checkForUpdate()
    }
    assert.equal(f.downloads.length, 2)
    assert.equal(store.getUpdate().state.version, '99.0.2')
  } finally {
    close()
  }
})

test('Android：新包下载/校验失败和清单失败后旧包仍可安装，后续新版能成功', async () => {
  const { f, store, close } = await setup()
  try {
    await store.checkForUpdate()
    await store.downloadUpdate()
    let next = 2
    for (const failure of [
      'network',
      'network',
      'size',
      'checksum',
      'signature',
      'version',
      'feed',
    ]) {
      f.version = `99.0.${next++}`
      f.failure = failure
      await store.checkForUpdate()
      assert.equal(store.getUpdate().state.phase, 'ready')
      assert.equal(store.getUpdate().state.version, '99.0.1')
      store.installUpdate()
      assert.equal(f.installed.at(-1), '99.0.1')
    }
    f.version = '99.1.0'
    f.failure = ''
    await store.checkForUpdate()
    store.installUpdate()
    assert.equal(f.installed.at(-1), '99.1.0')
  } finally {
    close()
  }
})

test('Android：前台定时检查待安装更新，关闭自动检查仍可手动检查', async (context) => {
  const { f, store, close } = await setup()
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  let enabled = true
  let stop
  try {
    await store.checkForUpdate()
    await store.downloadUpdate()
    stop = store.startUpdateSchedule(() => enabled)
    context.mock.timers.tick(30_000)
    await store.checkForUpdate()
    assert.equal(f.feeds, 2)
    f.version = '99.0.2'
    context.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS)
    await store.checkForUpdate()
    assert.equal(store.getUpdate().state.version, '99.0.2')
    enabled = false
    const previous = f.feeds
    context.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS)
    assert.equal(f.feeds, previous)
    f.version = '99.0.3'
    await store.checkForUpdate()
    assert.equal(store.getUpdate().state.version, '99.0.3')
  } finally {
    stop?.()
    close()
    context.mock.timers.reset()
  }
})

process.on('exit', () => hooks.deregister())
