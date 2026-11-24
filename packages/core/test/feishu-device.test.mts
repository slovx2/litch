import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FEISHU_NOTIFICATION,
  type FeishuApp,
  type FeishuRequests,
} from '../../protocol/src/feishu.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import type { HostSink } from '../src/channel/server.mjs'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { createFeishuDevice } from '../src/device/feishu.mjs'
import type { FeishuDeviceView } from '../src/projection/feishu.mjs'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const app = (revision: number): FeishuApp => ({
  appId: 'cli_0123456789abcdef',
  revision,
  name: '示例机器人',
  managerId: null,
  enabled: true,
  credential: { generation: 1, updatedAt: 1 },
  connection: { state: 'connected', since: 1, reconnects: 0 },
  capability: null,
  createdAt: 1,
})

function sink(into: unknown[]): HostSink {
  return {
    snapshot: (value: unknown) => into.push(value),
    delta: () => {},
    error: () => {},
  } as unknown as HostSink
}

test('有人看才读应用列表；收到 appsChanged 重读；离线和不支持时命令直接拒绝', async () => {
  let online = true
  let supported = true
  let revision = 1
  const calls: string[] = []
  const device = createFeishuDevice({
    online: () => online,
    supported: () => supported,
    now: () => 42,
    fail: (error) => channelFailure(error),
    async request<M extends keyof FeishuRequests>(method: M): Promise<FeishuRequests[M]['result']> {
      calls.push(method)
      return { apps: [app(revision)] } as FeishuRequests[M]['result']
    },
  })
  const seen: FeishuDeviceView[] = []
  const close = device.open({ kind: 'feishuDevice', deviceId: 'd' }, sink(seen))
  await flush()
  assert.deepEqual(calls, ['litch/feishu/app/list'])
  assert.equal(seen.at(-1)?.apps.value?.[0]?.revision, 1)
  revision = 2
  assert.equal(device.notification(FEISHU_NOTIFICATION.appsChanged, {}), true)
  await flush()
  assert.equal(seen.at(-1)?.apps.value?.[0]?.revision, 2)
  close()
  assert.equal(device.notification(FEISHU_NOTIFICATION.appsChanged, {}), true)
  await flush()
  assert.equal(calls.length, 2, '没人看时不重读')
  online = false
  await assert.rejects(
    device.command('feishu.app.get', { appId: 'cli_0123456789abcdef' }),
    (error) => {
      assert.ok(error instanceof ChannelError)
      assert.equal(error.code, 'offline')
      return true
    },
  )
  online = true
  supported = false
  await assert.rejects(
    device.command('feishu.app.get', { appId: 'cli_0123456789abcdef' }),
    /unavailable/,
  )
  assert.equal(device.notification('litch/other', {}), false)
})

test('带 App Secret 的请求：远端错误不带回原文，回显秘密的结果被拒', async () => {
  const marker = 'fixture-secret-value'
  let echo = false
  const device = createFeishuDevice({
    online: () => true,
    supported: () => true,
    now: () => 42,
    fail: (error) => channelFailure(error),
    async request() {
      if (echo) return { app: { ...app(1), name: marker } } as never
      throw new RpcError(-32602, `feishu_credential_rejected ${marker}`)
    },
  })
  const args = { operationId: 'op', appId: 'cli_0123456789abcdef', appSecret: marker }
  await assert.rejects(device.command('feishu.app.configure', args), (error) => {
    assert.ok(error instanceof ChannelError)
    assert.doesNotMatch(error.message, /fixture-secret/)
    return true
  })
  await assert.rejects(
    createFeishuDevice({
      online: () => true,
      supported: () => true,
      now: () => 42,
      fail: (error) => channelFailure(error),
      async request() {
        throw new RpcError(-32602, 'feishu_credential_rejected')
      },
    }).command('feishu.app.configure', args),
    /^ChannelError: feishu_credential_rejected$/,
  )
  echo = true
  await assert.rejects(device.command('feishu.app.configure', args), /Credential operation failed/)
  await assert.rejects(
    device.command('feishu.app.configure', { ...args, appId: 'bad' }),
    (error) => {
      assert.ok(error instanceof ChannelError)
      assert.equal(error.code, 'invalid')
      return true
    },
  )
})
