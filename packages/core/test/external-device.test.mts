import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXTERNAL_NOTIFICATION,
  type ExternalAccess,
  type ExternalInboxEvent,
  EXTERNAL_METHOD as RPC,
} from '../../protocol/src/external-sources.mjs'
import { ChannelError } from '../src/channel/protocol.mjs'
import type { RpcRequestOptions } from '../src/connection/rpc.mjs'
import { createExternalDevice } from '../src/device/external.mjs'
import { createExternalOwner } from '../src/device/external-owner.mjs'
import type { ConfigMainResult } from '../src/model-config.mjs'
import type {
  ExternalInboxView,
  ExternalWireRequests,
  GlobalExternalOwner,
} from '../src/projection/external.mjs'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('收件箱保留离线快照，重连读取新游标并替换已加载的页', async () => {
  let online = true
  let head = 60
  let access: ExternalAccess | null = { triageInbox: true }
  let delivery: ExternalInboxEvent['delivery'] = { state: 'queued' }
  const calls: (number | undefined)[] = []
  const snapshot: ExternalInboxView[] = []
  const device = createExternalDevice({
    online: () => online,
    sourcesSupported: () => true,
    autostartSupported: () => false,
    now: () => 42,
    fail: (cause) => new ChannelError('remote', String(cause)),
    async request<M extends keyof ExternalWireRequests>(
      method: M,
      args: ExternalWireRequests[M]['params'],
    ): Promise<ExternalWireRequests[M]['result']> {
      if (method === RPC.accessGet) {
        if (!access) throw new ChannelError('unsupported', '设备未返回操作权限')
        return access as ExternalWireRequests[M]['result']
      }
      assert.equal(method, RPC.inboxList)
      const {
        beforeSeq,
        limit = 30,
        managerId,
      } = args as ExternalWireRequests[typeof RPC.inboxList]['params']
      assert.equal(managerId, 'm1')
      calls.push(beforeSeq)
      const last = beforeSeq ? beforeSeq - 1 : head
      const entries = Array.from(
        { length: Math.min(last, limit) },
        (_, i) =>
          ({
            seq: last - i,
            ...(i === 0 && !beforeSeq ? { status: 'pending_triage', delivery } : {}),
          }) as ExternalInboxEvent,
      )
      return {
        entries,
        nextBeforeSeq: last > limit ? last - limit + 1 : null,
      } as ExternalWireRequests[M]['result']
    },
  })
  const filter = { managerId: 'm1' }
  const stop = device.open(
    { kind: 'externalInbox', deviceId: 'remote', filter },
    {
      snapshot: (value) => snapshot.push(value as ExternalInboxView),
      error: (error) => assert.fail(error.message),
      delta: () => assert.fail('快照不使用增量'),
    },
  )
  await flush()
  assert.equal(snapshot.at(-1)?.access?.triageInbox, true)
  assert.equal(snapshot.at(-1)?.access?.reassignInbox, false)
  assert.equal(snapshot.at(-1)?.value?.entries[0]?.delivery?.state, 'queued')
  await device.inboxMore(filter)
  assert.equal(snapshot.at(-1)?.value?.entries.length, 60)
  device.notification(EXTERNAL_NOTIFICATION.inboxChanged, { managerId: 'other' })
  await flush()
  assert.equal(calls.length, 3)
  online = false
  device.connectionChanged()
  assert.equal(snapshot.at(-1)?.online, false)
  assert.equal(snapshot.at(-1)?.access, undefined)
  assert.equal(snapshot.at(-1)?.fetchedAt, 42)
  assert.equal(snapshot.at(-1)?.value?.entries[0]?.seq, 60)
  head = 62
  access = null
  delivery = { state: 'confirmed' }
  online = true
  device.connectionChanged()
  assert.equal(snapshot.at(-1)?.access, undefined)
  await flush()
  assert.deepEqual(calls, [undefined, undefined, 31, undefined, 33])
  assert.equal(snapshot.at(-1)?.value?.entries[0]?.seq, 62)
  assert.equal(snapshot.at(-1)?.value?.entries.at(-1)?.seq, 3)
  assert.equal(snapshot.at(-1)?.value?.nextBeforeSeq, 3)
  assert.equal(snapshot.at(-1)?.access, undefined)
  assert.equal(snapshot.at(-1)?.value?.entries[0]?.status, 'pending_triage')
  assert.equal(snapshot.at(-1)?.value?.entries[0]?.delivery?.state, 'confirmed')
  access = { reassignInbox: true }
  assert.equal(device.notification(EXTERNAL_NOTIFICATION.accessChanged, {}), true)
  await flush()
  assert.equal(snapshot.at(-1)?.access?.reassignInbox, true)
  assert.equal(snapshot.at(-1)?.access?.triageInbox, false)
  access = {}
  device.notification(EXTERNAL_NOTIFICATION.accessChanged, {})
  assert.equal(snapshot.at(-1)?.access, undefined)
  await flush()
  assert.equal(snapshot.at(-1)?.access?.reassignInbox, false)
  stop()
})

test('凭据错误和误回显不会穿过核心通道', async () => {
  const token = 'fixture-plaintext-never-output'
  for (const behavior of ['throw', 'echo']) {
    let options: RpcRequestOptions | undefined
    const device = createExternalDevice({
      online: () => true,
      sourcesSupported: () => true,
      autostartSupported: () => false,
      now: () => 42,
      fail: (error) => new ChannelError('remote', String(error)),
      async request<M extends keyof ExternalWireRequests>(
        _method: M,
        _args: ExternalWireRequests[M]['params'],
        supplied?: RpcRequestOptions,
      ) {
        options = supplied
        if (behavior === 'throw') throw Error(`wrong credentials: ${token}`)
        return { identity: { login: token } } as ExternalWireRequests[M]['result']
      },
    })
    await assert.rejects(
      device.command('external.identity.paste', { token, operationId: 'op' }),
      (error: unknown) =>
        error instanceof ChannelError &&
        !error.message.includes(token) &&
        error.text?.key === 'external.secretFailed',
    )
    assert.equal(options?.sensitive, true)
  }
})

test('全局账号只同步确认过的设备版本，离线和并发变化均不覆盖', async () => {
  const owner = {
    provider: 'github',
    userId: '9007199254740993',
    loginCache: 'sample',
    profileUrl: 'https://github.com/sample',
    method: 'localGh',
  } as const
  let global: GlobalExternalOwner | null = null
  const applied: string[] = []
  const coordinator = createExternalOwner({
    devices: () => [
      { id: 'local', online: true },
      { id: 'conflicting', online: true },
      { id: 'offline', online: false },
    ],
    get: async (id) =>
      id === 'conflicting'
        ? { ...owner, userId: '2', configuredBy: 'elsewhere', revision: 2 }
        : null,
    set: async (id) => {
      applied.push(id)
      return { ...owner, configuredBy: 'desktop', revision: 1 }
    },
    main: async (request): Promise<ConfigMainResult> => {
      if (request.kind === 'external.owner.get') return { ok: true, data: global }
      if (request.kind === 'external.owner.save') {
        global = { owner: request.owner, revision: request.expectedRevision + 1 }
        return { ok: true, data: null }
      }
      return { ok: true, data: owner }
    },
  })
  const result = await coordinator.set({
    owner,
    expectedRevision: 0,
    operationId: 'op',
    devices: [
      { deviceId: 'local', expectedRevision: 0 },
      { deviceId: 'conflicting', expectedRevision: 1 },
    ],
  })
  assert.deepEqual(applied, ['local'])
  assert.deepEqual(
    result.devices.map(({ state }) => state),
    ['synced', 'different', 'offline'],
  )
  assert.deepEqual(await coordinator.get(), { owner, revision: 1 })
})

test('设备码状态用通知重读；导入 owner 先暂存，取消不保存，明确确认才提交', async () => {
  const { createMockCore } = await import('../src/mock/mock-core.mjs')
  const { fakeClock } = await import('./helpers.mjs')
  const { clock, advance } = fakeClock()
  const core = createMockCore({ clock })
  const signal = { aborted: false, addEventListener() {} }
  const deviceId = 'local'
  const result = (await core.command(
    'external.identity.add',
    {
      deviceId,
      operationId: 'oauth-login',
      scopes: ['repo', 'read:org', 'gist'],
    },
    signal,
  )) as import('../../protocol/src/external-sources.mjs').ExternalIdentityLogin
  assert.equal(result.state, 'waiting')
  const snapshots: import('../src/projection/external.mjs').ExternalIdentityLoginView[] = []
  const stop = core.subscribe(
    { kind: 'externalIdentityLogin', deviceId, loginId: result.loginId },
    {
      snapshot: (value) => snapshots.push(value as never),
      delta: () => assert.fail('设备码状态应重读快照'),
      error: (reason) => assert.fail(reason.message),
    },
  )
  await flush()
  assert.equal(snapshots.at(-1)?.value?.state, 'waiting')
  advance(500)
  await flush()
  const authorized = snapshots.at(-1)?.value
  assert.equal(authorized?.state, 'succeeded')
  assert.equal(
    authorized.state === 'succeeded' &&
      authorized.result.identity?.credentials.at(-1)?.credentialKind,
    'oauth',
  )
  stop()
  const imported = (await core.command(
    'external.identity.import',
    {
      deviceId,
      operationId: 'import-one',
    },
    signal,
  )) as import('../../protocol/src/external-sources.mjs').ExternalIdentityLogin
  assert.equal(imported.state, 'succeeded')
  assert.equal(imported.state === 'succeeded' && imported.needsConfirmation, true)
  assert.equal(imported.state === 'succeeded' && imported.result.identity, undefined)
  await core.command(
    'external.identity.login.cancel',
    { deviceId, loginId: imported.loginId, operationId: 'cancel' },
    signal,
  )
  await assert.rejects(
    core.command(
      'external.identity.login.confirm',
      {
        deviceId,
        loginId: imported.loginId,
        expectedRevision: imported.revision,
        operationId: 'rejected',
      },
      signal,
    ),
  )
  const candidate = (await core.command(
    'external.identity.import',
    {
      deviceId,
      operationId: 'import-two',
    },
    signal,
  )) as import('../../protocol/src/external-sources.mjs').ExternalIdentityLogin
  const final = (await core.command(
    'external.identity.login.confirm',
    {
      deviceId,
      loginId: candidate.loginId,
      expectedRevision: candidate.revision,
      operationId: 'confirmed',
    },
    signal,
  )) as import('../../protocol/src/external-sources.mjs').ExternalIdentityLogin
  assert.equal(final.state === 'succeeded' && final.needsConfirmation, false)
  assert.ok(final.state === 'succeeded' && final.result.isOwner && final.result.identity)
})
