import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FEISHU_NOTIFICATION,
  type FeishuApp,
  type FeishuRequests,
} from '../../protocol/src/feishu.mjs'
import { REVIEWS_NOTIFICATION, type ReviewsRequests } from '../../protocol/src/reviews.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import type { HostSink } from '../src/channel/server.mjs'
import { RpcError } from '../src/connection/rpc.mjs'
import { channelFailure } from '../src/device/faults.mjs'
import { createFeishuDevice } from '../src/device/feishu.mjs'
import type { FeishuDeviceView } from '../src/projection/feishu.mjs'

// 桩的请求签名要覆盖飞书和通用审批两组方法（与 createFeishuDevice 的 host.request 一致）
type Requests = FeishuRequests & ReviewsRequests

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const APP_ID = 'cli_0123456789abcdef'

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
    reviewsSupported: () => false,
    now: () => 42,
    fail: (error) => channelFailure(error),
    async request<M extends keyof Requests>(method: M): Promise<Requests[M]['result']> {
      calls.push(method)
      return { apps: [app(revision)] } as Requests[M]['result']
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
    reviewsSupported: () => false,
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
      reviewsSupported: () => false,
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

test('群列表按应用订阅：带管理员标记；chatsChanged 和写命令后重读，读命令不重读', async () => {
  const calls: { method: string; params: unknown }[] = []
  let revision = 1
  const device = createFeishuDevice({
    online: () => true,
    supported: () => true,
    reviewsSupported: () => false,
    now: () => 42,
    fail: (error) => channelFailure(error),
    async request<M extends keyof Requests>(
      method: M,
      params: Requests[M]['params'],
    ): Promise<Requests[M]['result']> {
      calls.push({ method, params })
      if (method === 'litch/feishu/app/list')
        return { apps: [app(1)], admin: false } as Requests[M]['result']
      if (method === 'litch/feishu/chat/list')
        return { chats: [], syncedAt: revision } as Requests[M]['result']
      return { members: [], fetchedAt: 1 } as Requests[M]['result']
    },
  })
  const views: FeishuDeviceView[] = []
  device.open({ kind: 'feishuDevice', deviceId: 'd' }, sink(views))
  await flush()
  assert.equal(views.at(-1)?.admin, false)
  const seen: { value?: { syncedAt: number | null } | null }[] = []
  const close = device.open(
    { kind: 'feishuChats', deviceId: 'd', appId: 'cli_0123456789abcdef' },
    sink(seen),
  )
  await flush()
  assert.equal(seen.at(-1)?.value?.syncedAt, 1)
  revision = 2
  assert.equal(
    device.notification(FEISHU_NOTIFICATION.chatsChanged, { appId: 'cli_0123456789abcdef' }),
    true,
  )
  await flush()
  assert.equal(seen.at(-1)?.value?.syncedAt, 2)
  const before = calls.filter((call) => call.method === 'litch/feishu/chat/list').length
  await device.command('feishu.chat.members', {
    appId: 'cli_0123456789abcdef',
    chatId: 'oc_example',
  })
  await flush()
  assert.equal(calls.filter((call) => call.method === 'litch/feishu/chat/list').length, before)
  close()
})

test('收件箱按经理订阅：inboxChanged 只重读那位经理的；读命令不触发重读', async () => {
  const calls: { method: string; params: unknown }[] = []
  const device = createFeishuDevice({
    online: () => true,
    supported: () => true,
    reviewsSupported: () => false,
    now: () => 42,
    fail: (error) => channelFailure(error),
    async request<M extends keyof Requests>(
      method: M,
      params: Requests[M]['params'],
    ): Promise<Requests[M]['result']> {
      calls.push({ method, params })
      return { entries: [], messages: {} } as unknown as Requests[M]['result']
    },
  })
  const seen: unknown[] = []
  device.open({ kind: 'feishuInbox', deviceId: 'd', managerId: 'm1' }, sink(seen))
  await flush()
  assert.deepEqual(calls, [
    { method: 'litch/feishu/inbox/list', params: { managerId: 'm1', limit: 100 } },
  ])
  assert.equal(device.notification(FEISHU_NOTIFICATION.inboxChanged, { managerId: 'm2' }), true)
  await flush()
  assert.equal(calls.length, 1, '别的经理变了不重读')
  device.notification(FEISHU_NOTIFICATION.inboxChanged, { managerId: 'm1', appId: 'cli_x' })
  await flush()
  assert.equal(calls.length, 2)
  await device.command('feishu.inbox.get', { inboxId: 'FI-1' })
  await flush()
  assert.equal(calls.length, 3)
  assert.equal(calls.at(-1)?.method, 'litch/feishu/inbox/get')
})

test('发件按应用订阅、审批按经理订阅：各自的通知只重读受影响的；决定后重读审批，撤下后重读发件', async () => {
  const calls: { method: string; params: unknown }[] = []
  let reviews = true
  const device = createFeishuDevice({
    online: () => true,
    supported: () => true,
    reviewsSupported: () => reviews,
    now: () => 42,
    fail: (error: unknown) => channelFailure(error),
    async request(method: string, params: unknown): Promise<never> {
      calls.push({ method, params })
      if (method === 'litch/reviews/list')
        return {
          reviews:
            (params as { states?: string[] }).states?.[0] === 'pending'
              ? [{ reviewId: 'A-2', state: 'pending' }]
              : [
                  { reviewId: 'A-2', state: 'pending' },
                  { reviewId: 'A-1', state: 'approved' },
                ],
        } as never
      return { entries: [] } as never
    },
  } as never)
  const outbox: unknown[] = []
  device.open({ kind: 'feishuOutbox', deviceId: 'd', appId: 'cli_0123456789abcdef' }, sink(outbox))
  const seen: { value: { reviews: { reviewId: string }[]; pending: number } | null }[] = []
  device.open({ kind: 'reviews', deviceId: 'd', managerId: 'm1' }, sink(seen))
  await flush()
  await flush()
  assert.deepEqual(
    calls.map((call) => call.method),
    ['litch/feishu/outbox/list', 'litch/reviews/list', 'litch/reviews/list'],
  )
  const last = seen.at(-1)?.value
  assert.deepEqual(
    last?.reviews.map((review) => review.reviewId),
    ['A-2', 'A-1'],
    '待批的在前、不重复',
  )
  assert.equal(last?.pending, 1)

  calls.length = 0
  device.notification(FEISHU_NOTIFICATION.outboxChanged, {
    appId: 'cli_other',
    operationId: 'op-1',
  })
  device.notification(REVIEWS_NOTIFICATION.changed, {
    reviewId: 'A-9',
    revision: 2,
    managerId: 'm2',
  })
  await flush()
  assert.equal(calls.length, 0, '别的应用、别的经理不重读')
  device.notification(FEISHU_NOTIFICATION.outboxChanged, {
    appId: 'cli_0123456789abcdef',
    operationId: 'op-1',
  })
  device.notification(REVIEWS_NOTIFICATION.changed, {
    reviewId: 'A-2',
    revision: 2,
    managerId: 'm1',
  })
  await flush()
  assert.equal(calls.length, 3)

  calls.length = 0
  await device.reviewsCommand('reviews.decide', {
    reviewId: 'A-2',
    decision: 'approve',
    expectedRevision: 1,
  })
  await flush()
  assert.equal(calls[0]?.method, 'litch/reviews/decide')
  assert.equal(calls.filter((call) => call.method === 'litch/reviews/list').length, 2)
  calls.length = 0
  await device.command('feishu.outbox.cancel', {
    appId: 'cli_0123456789abcdef',
    operationId: 'op-sample-1',
  })
  await flush()
  assert.deepEqual(
    calls.map((call) => call.method),
    ['litch/feishu/outbox/cancel', 'litch/feishu/outbox/list'],
  )

  reviews = false
  await assert.rejects(
    device.reviewsCommand('reviews.get', { reviewId: 'A-1' }),
    (error: unknown) => error instanceof ChannelError && error.code === 'unsupported',
  )
})

test('私聊绑定按应用订阅（连同用户身份授权）：bindingsChanged、grantsChanged 重读；确认、撤销、修改后重读并刷新应用（待批配对数），查码不重读', async () => {
  const calls: { method: string; params: unknown }[] = []
  const device = createFeishuDevice({
    online: () => true,
    supported: () => true,
    reviewsSupported: () => false,
    now: () => 42,
    fail: (error) => channelFailure(error),
    async request<M extends keyof Requests>(
      method: M,
      params: Requests[M]['params'],
    ): Promise<Requests[M]['result']> {
      calls.push({ method, params })
      if (method === 'litch/feishu/app/list') return { apps: [] } as never
      if (method === 'litch/feishu/binding/lookup')
        return { pairing: { appId: APP_ID, openId: 'ou_x', createdAt: 1, expiresAt: 2 } } as never
      if (method === 'litch/feishu/grant/list') return { grants: [] } as never
      return { bindings: [] } as unknown as Requests[M]['result']
    },
  })
  const seen: unknown[] = []
  device.open({ kind: 'feishuBindings', deviceId: 'd', appId: APP_ID }, sink(seen))
  await flush()
  assert.deepEqual(calls, [
    { method: 'litch/feishu/binding/list', params: { appId: APP_ID } },
    { method: 'litch/feishu/grant/list', params: { appId: APP_ID } },
  ])
  assert.deepEqual((seen.at(-1) as { value?: unknown }).value, { bindings: [], grants: [] })
  // 有人看应用列表时，绑定变了才刷新应用（待批配对数）
  device.open({ kind: 'feishuDevice', deviceId: 'd' }, sink([]))
  await flush()
  calls.splice(0, calls.length, ...calls.filter((call) => call.method !== 'litch/feishu/app/list'))
  device.notification(FEISHU_NOTIFICATION.bindingsChanged, { appId: 'cli_ffffffffffffffff' })
  await flush()
  assert.equal(calls.length, 2, '别的应用变了不重读')
  device.notification(FEISHU_NOTIFICATION.bindingsChanged, { appId: APP_ID })
  await flush()
  assert.equal(calls.length, 4)
  device.notification(FEISHU_NOTIFICATION.grantsChanged, { appId: APP_ID, openId: 'ou_x' })
  await flush()
  assert.equal(calls.length, 6, '授权变了也重读')
  await device.command('feishu.binding.lookup', { appId: APP_ID, code: 'ABCD-EFGH' })
  await flush()
  assert.equal(calls.length, 7, '查码不重读')
  await device.command('feishu.binding.approve', { appId: APP_ID, code: 'ABCD-EFGH' })
  await flush()
  assert.deepEqual(
    calls
      .slice(7)
      .map((call) => call.method)
      .sort(),
    [
      'litch/feishu/app/list',
      'litch/feishu/binding/approve',
      'litch/feishu/binding/list',
      'litch/feishu/grant/list',
    ],
  )
})
