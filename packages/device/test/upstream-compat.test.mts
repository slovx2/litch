// 与上游协议的兼容性：设备进程的聚合面。
// 聚合面不对只说标准协议的客户端开放：握手时没声明 harness 扩展就拒绝（session.mts 的 initialize），
// 所以这里没有回放和常用流程可走，只校验“拒绝”本身：回来的是上游的错误形状，被拒绝的连接上没有别的内容，
// 也没有去连任何引擎。只说标准协议的客户端该连各引擎自己的入口，那边的校验在各包的 upstream-compat.test.mts。
// 另一条看 harness 详情设置（harnessConfig）：没声明它的连接上线上内容和以前一样。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertBaseline } from '../../shared/test/compat-baseline.mjs'
import { replayFixturePath } from '../../shared/test/desktop-replay.mjs'
import { StandardClient } from '../../shared/test/standard-client.mjs'
import type { WireHandlers } from '../src/wire.mjs'
import { codexRig } from './codex-kit.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { errorCode, rig, settle } from './helpers.mjs'

test('聚合面：只说标准协议的客户端握手被拒绝，回的是上游的错误形状，连接上没有别的内容', async () => {
  const pi = new FakeUpstream('pi')
  const env = rig({ pi })
  try {
    const wire: { handlers?: WireHandlers } = {}
    const client = new StandardClient((message) => wire.handlers?.message(JSON.stringify(message)))
    wire.handlers = env.device.attach({
      send: (text) => queueMicrotask(() => client.accept(JSON.parse(text))),
      close: () => {},
    })

    // 握手用回放夹具里官方桌面端的那一份：上游的能力位都带着，我们的扩展一个都不声明
    const desktop = JSON.parse(readFileSync(replayFixturePath, 'utf8')).client
    assert.ok(!('litchExtensions' in desktop.capabilities))
    const refused = await client.request('initialize', desktop)
    assert.equal(refused.error?.code, errorCode('extensionRequired'))
    assert.match(refused.error?.message ?? '', /capabilities\.litchExtensions/)

    // 握手没成：标准的请求一律按“还没初始化”回错误，不挂住
    for (const [method, params] of [
      ['thread/list', { limit: 20 }],
      ['model/list', {}],
      ['thread/start', { cwd: env.stateDir }],
    ] as const) {
      const reply = await client.request(method, params)
      assert.equal(reply.error?.code, -32600, method)
      assert.equal(reply.error?.message, 'Not initialized', method)
    }

    await settle()
    assert.equal(pi.connections.length, 0, '被拒绝的连接不该去连引擎')
    assert.deepEqual(client.notificationMethods(), [])
    assert.deepEqual(client.serverRequestMethods(), [])
    assert.deepEqual(client.mistakes, [])
    assertBaseline('device', client.findings.values(), { complete: true, samples: client.samples })
  } finally {
    await env.close()
  }
})

test('harness 详情设置（harnessConfig）不改变没声明它的连接：官方桌面端的握手加上 harness 扩展照样连得上，线上看不到这项扩展的通知，原生 codex 收到的握手里没有扩展键', async () => {
  const env = codexRig()
  try {
    const desktop = JSON.parse(readFileSync(replayFixturePath, 'utf8')).client
    const client = env.connect()
    const greeted = await client.call('initialize', {
      ...desktop,
      capabilities: { ...desktop.capabilities, litchExtensions: ['harness'] },
    })
    assert.equal(typeof greeted.userAgent, 'string')
    const info = await client.call('runtime/info')
    assert.ok(info.harnesses.some((item: any) => item.id === 'codex' && item.available))
    // 引擎发的、设备进程替原生 codex 发的都不该到这条连接上
    env.pi.notify('litch/harness/config/changed', { harness: 'pi', part: 'config' })
    env.pi.notify('litch/harness/auth/updated', {
      harness: 'pi',
      attemptId: 'a',
      step: { kind: 'failed', message: { 'zh-CN': 'x', en: 'x' } },
    })
    env.pi.notify('account/updated', { authMode: null })
    await client.waitFor((frame) => frame.method === 'account/updated')
    await settle(30)
    assert.ok(
      !client.raw.some(
        (text) => text.includes('litch/harness/config/') || text.includes('litch/harness/auth/'),
      ),
    )
    for (const greeting of env.codex.greetings) {
      assert.ok(!('litchExtensions' in greeting.capabilities))
      assert.ok(!JSON.stringify(greeting).includes('harnessConfig'))
    }
  } finally {
    await env.close()
  }
})
