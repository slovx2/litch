// 与上游协议的兼容性（设计文档 03 第 15.4 节）：设备进程的聚合面。
// 聚合面不对只说标准协议的客户端开放：握手时没声明 harness 扩展就拒绝（session.mts 的 initialize），
// 所以这里没有回放和常用流程可走，只校验“拒绝”本身：回来的是上游的错误形状，被拒绝的连接上没有别的内容，
// 也没有去连任何引擎。只说标准协议的客户端该连各引擎自己的入口，那边的校验在各包的 upstream-compat.test.mts。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertBaseline } from '../../shared/test/compat-baseline.mjs'
import { replayFixturePath } from '../../shared/test/desktop-replay.mjs'
import { StandardClient } from '../../shared/test/standard-client.mjs'
import type { WireHandlers } from '../src/wire.mjs'
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
