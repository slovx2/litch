// harness 详情设置（harnessConfig 扩展）在聚合面上的路由和通知：
// 适配器的引擎原样转（harness 参数也带着），原生 codex 由设备进程翻译；通知只给声明过的连接；
// 没声明的连接（只认 harness 扩展的客户端）照旧能用，线上看不到这项扩展的任何通知。
// 原生 codex 的各项翻译在 codex-harness-config.test.mts，统一模式在 instructions.test.mts。
import assert from 'node:assert/strict'
import test from 'node:test'
import { codexRig, sentTo } from './codex-kit.mjs'
import { installConfig } from './fake-codex-config.mjs'
import { AUTH_UPDATED, assertHcError, assertHcNotification, CHANGED } from './hc-kit.mjs'
import { assertRuntimeInfo, settle } from './helpers.mjs'

const DECLARED = ['harness', 'deviceSettings', 'harnessConfig']
const PLAIN = ['harness', 'deviceSettings']

test('runtime/info：设备的扩展里有 harnessConfig；原生 codex 的声明里也有（设备进程替它翻译）', async () => {
  const env = codexRig()
  try {
    const client = env.connect()
    await client.initialize(DECLARED)
    const info = await client.call('runtime/info')
    assertRuntimeInfo(info)
    assert.ok(info.device.extensions.includes('harnessConfig'))
    const codex = info.harnesses.find((item: any) => item.id === 'codex')
    assert.ok(codex.extensions.includes('harnessConfig'))
    // 适配器的引擎自己报，这个假的没报
    const pi = info.harnesses.find((item: any) => item.id === 'pi')
    assert.ok(!(pi.extensions ?? []).includes('harnessConfig'))
  } finally {
    await env.close()
  }
})

test('适配器的引擎：litch/harness/* 原样转过去，harness 参数和别的参数都带着，应答原样回来', async () => {
  const env = codexRig()
  env.pi.handlers['litch/harness/config/write'] = (params) => ({
    version: 'v2',
    overriddenKeys: [],
    restartRequired: params.edits.length > 1,
  })
  try {
    const client = env.connect()
    await client.initialize(DECLARED)
    const params = {
      harness: 'pi',
      edits: [
        { key: 'defaultModel', value: 'x' },
        { key: 'retry.enabled', value: null },
      ],
      expectedVersion: 'v1',
    }
    const result = await client.call('litch/harness/config/write', params)
    assert.deepEqual(result, { version: 'v2', overriddenKeys: [], restartRequired: true })
    assert.deepEqual(sentTo(env.pi, 'litch/harness/config/write'), [params])
    // 引擎没实现的，引擎回什么就是什么（适配器的运行时回“方法不存在”）
    const missing = await client.fails('litch/harness/mcp/read', { harness: 'pi' })
    assert.equal(missing.code, -32601)
    // codex 的不转给它：设备进程自己答，codex 只收到它自己的方法
    await client.call('litch/harness/instructions/read', { harness: 'codex' }).catch(() => null)
    assert.equal(sentTo(env.codex, 'litch/harness/instructions/read').length, 0)
  } finally {
    await env.close()
  }
})

test('通知：引擎发的 config/changed、auth/updated 只给声明了 harnessConfig 的连接，别的通知照旧', async () => {
  const env = codexRig()
  try {
    const declared = env.connect()
    await declared.initialize(DECLARED)
    const plain = env.connect()
    await plain.initialize(PLAIN)
    await settle()
    const changed = { harness: 'pi', part: 'config' }
    const updated = {
      harness: 'pi',
      attemptId: 'a1',
      providerId: 'anthropic',
      step: { kind: 'failed', message: { 'zh-CN': '取消了', en: 'cancelled' } },
    }
    assertHcNotification(CHANGED, changed)
    assertHcNotification(AUTH_UPDATED, updated)
    env.pi.notify(CHANGED, changed)
    env.pi.notify(AUTH_UPDATED, updated)
    env.pi.notify('account/updated', { authMode: null })
    await declared.waitFor((frame) => frame.method === 'account/updated')
    await plain.waitFor((frame) => frame.method === 'account/updated')
    assert.deepEqual(
      declared.notifications
        .filter(
          (frame) =>
            frame.method?.startsWith('litch/harness/config') || frame.method === AUTH_UPDATED,
        )
        .map((frame) => [frame.method, frame.params]),
      [
        [CHANGED, changed],
        [AUTH_UPDATED, updated],
      ],
    )
    assert.ok(
      !plain.raw.some((text) => text.includes(CHANGED) || text.includes(AUTH_UPDATED)),
      '没声明的连接上不该出现这项扩展的通知',
    )
  } finally {
    await env.close()
  }
})

test('退订了的也不发：声明了 harnessConfig、又在 optOutNotificationMethods 里列了 config/changed', async () => {
  const env = codexRig()
  installConfig(env.codex)
  try {
    const client = env.connect()
    await client.initialize(DECLARED, { optOutNotificationMethods: [CHANGED] })
    const read = await client.call('litch/harness/config/read', { harness: 'codex' })
    await client.call('litch/harness/config/write', {
      harness: 'codex',
      edits: [{ key: 'model', value: 'gpt-a' }],
      expectedVersion: read.version,
    })
    env.pi.notify(CHANGED, { harness: 'pi', part: 'mcp' })
    await settle(50)
    assert.ok(!client.raw.some((text) => text.includes(CHANGED)))
  } finally {
    await env.close()
  }
})

test('没声明 harnessConfig 的连接方法照样能调，经翻译改了配置也收不到通知；声明了的两条连接都收到', async () => {
  const env = codexRig()
  installConfig(env.codex)
  try {
    const plain = env.connect()
    await plain.initialize(PLAIN)
    const first = env.connect()
    await first.initialize(DECLARED)
    const second = env.connect()
    await second.initialize(DECLARED)
    const read = await plain.call('litch/harness/config/read', { harness: 'codex' })
    await plain.call('litch/harness/config/write', {
      harness: 'codex',
      edits: [{ key: 'model_reasoning_effort', value: 'high' }],
      expectedVersion: read.version,
    })
    for (const client of [first, second]) {
      const frame = await client.waitFor((item) => item.method === CHANGED)
      assert.deepEqual(frame.params, { harness: 'codex', part: 'config' })
    }
    await settle(50)
    assert.ok(!plain.raw.some((text) => text.includes(CHANGED)))
    // 握手时带给 codex 的参数里没有我们的扩展键（它不认识）
    for (const greeting of env.codex.greetings)
      assert.ok(!('litchExtensions' in greeting.capabilities))
  } finally {
    await env.close()
  }
})

test('harness 不可用、不认识：不可用回 unavailable（不转），不认识回 unknownHarness', async () => {
  const env = codexRig({ codex: 'disabled' })
  try {
    const client = env.connect()
    await client.initialize(DECLARED)
    const down = await client.fails('litch/harness/config/read', { harness: 'codex' })
    assert.equal(down.code, -32000)
    assert.equal(down.data.litch, 'unavailable')
    assert.equal(down.data.harness, 'codex')
    assertHcError(down.data)
    const unknown = await client.fails('litch/harness/config/read', { harness: 'nope' })
    assert.equal(unknown.data.litch, 'unknownHarness')
    const missing = await client.fails('litch/harness/config/read', {})
    assert.equal(missing.data.litch, 'unsupported')
  } finally {
    await env.close()
  }
})
