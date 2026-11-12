import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

test('新会话切页前准备自己的选择器：第一帧保留计划模式，缓存不混用会话、设置或能力', async () => {
  const values = new Map()
  const calls = []
  const pending = []
  const services = {
    replica: { store: { get: (key) => values.get(key) } },
    channel: {
      command: (name, params, { signal }) => {
        calls.push({ name, params })
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          pending.push({ resolve, reject })
        })
      },
    },
  }
  globalThis.__composeOptionsFixture = { services, values }
  const out = await build({
    stdin: {
      contents:
        "export { prepareSessionComposeOptions, useComposeOptions } from './SettingsBar.tsx'",
      resolveDir: new URL('../src/composer/', import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    format: 'esm',
    plugins: [
      {
        name: 'compose-options-hooks',
        setup(api) {
          const sources = {
            react: 'export const useState=x=>[x,()=>{}]; export const useEffect=()=>{};',
            '@litch/core': `export const keys={
              device:d=>'device:'+d,
              session:(d,s)=>'session:'+d+':'+s,
              settings:(d,s)=>'settings:'+d+':'+s
            }; export const STANDARD_SPEED='standard'; export const shownEffort=()=>{}; export const shownSpeed=()=>{};`,
            '../app/services.tsx': `export const useServices=()=>globalThis.__composeOptionsFixture.services;
              export const useKey=k=>globalThis.__composeOptionsFixture.values.get(k);`,
            '../app/appearance.ts': 'export const useT=()=>{};',
            '../app/device.ts': 'export const downHarness=()=>null;',
            './Picker.tsx': 'export const Picker=()=>{};',
            './project-permission.ts': 'export const useProjectPermission=()=>{};',
          }
          api.onResolve({ filter: /.*/ }, ({ path }) =>
            path in sources ? { path, namespace: 'fixture' } : undefined,
          )
          api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents: sources[path],
          }))
        },
      },
    ],
  })
  try {
    const { prepareSessionComposeOptions, useComposeOptions } = await import(
      `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`
    )
    const settings = { model: 'one', effort: null, speed: null, permission: null, mode: 'plan' }
    const meta = { harness: 'agy', can: { images: false } }
    values.set('device:local', { connection: 'online' })
    for (const id of ['new', 'sdk', 'failed', 'slow']) {
      values.set(`session:local:${id}`, meta)
      values.set(`settings:local:${id}`, settings)
    }
    const read = (id = 'new', device = 'local', harness = 'agy') =>
      // biome-ignore lint/correctness/useHookAtTopLevel: 测试首帧渲染，不运行 effect，不等待后续回包。
      useComposeOptions(device, harness, id)
    assert.equal(read(), null)
    const prepare = (id, signal = new AbortController().signal) =>
      prepareSessionComposeOptions(services, 'local', id, signal)
    const prepared = prepare('new')
    assert.deepEqual(calls, [
      {
        name: 'device.composeOptions',
        params: { deviceId: 'local', harness: 'agy', sessionId: 'new' },
      },
    ])
    assert.equal(read(), null, '尚未取得新会话的能力，不借用 harness 的清单')
    const options = { models: [], permissions: [], plan: true }
    pending.shift().resolve(options)
    await prepared
    assert.equal(read(), options, '第一帧不依赖 effect 再问一次，计划开关即可呈现')
    assert.equal(values.get('settings:local:new').mode, 'plan')
    assert.equal(read('sdk'), null)
    assert.equal(read('new', 'other'), null)
    assert.equal(read('new', 'local', 'other'), null)

    const sdk = prepare('sdk')
    pending.shift().resolve({ ...options, plan: false })
    await sdk
    assert.equal(read('sdk').plan, false, '同一 harness 的另一会话明确不支持计划模式')
    assert.equal(read().plan, true)
    values.set('settings:local:new', { ...settings, mode: 'default' })
    assert.equal(read(), null, '设置更新后不使用旧版本的选择器')
    values.set('settings:local:new', settings)
    values.set('session:local:new', { ...meta, can: { images: true } })
    assert.equal(read(), null, '能力更新后不使用旧版本的选择器')
    values.set('device:local', { connection: 'offline' })
    assert.equal(read(), options, '断线后改本地设置仍可用最后取得的选择器')
    assert.equal(read('new', 'other'), null, '离线缓存不跨设备')
    assert.equal(read('new', 'local', 'other'), null, '离线缓存不跨引擎')
    values.set('device:local', { connection: 'online' })

    const failed = prepare('failed')
    pending.shift().reject(new Error('设备断开'))
    await assert.doesNotReject(failed, '选择器加载失败不能把已创建的会话报成新建失败')
    assert.equal(read('failed'), null)
    await prepare('missing')
    assert.equal(calls.length, 3, '会话快照没到时留待进入会话后再问')
    const controller = new AbortController()
    const slow = prepare('slow', controller.signal)
    controller.abort(new Error('切页等待已到期'))
    await assert.doesNotReject(slow, '选择器未及时返回也能进入已建成的会话')
    pending.shift().resolve(options)
    assert.equal(read('slow'), null, '取消后的迟到回包不写入缓存')
  } finally {
    delete globalThis.__composeOptionsFixture
  }
})
