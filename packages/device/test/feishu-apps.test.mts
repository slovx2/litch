// F1：应用接入与长连接。真实 SDK 连回环上的假飞书，经协议配置，核对库、凭据文件、通知和连接状态。
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { FEISHU_METHOD as M } from '../../protocol/src/feishu.mjs'
import { FEISHU_EVENTS, FEISHU_SCOPES } from '../src/feishu/permissions.mjs'
import { creationUrl } from '../src/feishu/registration.mjs'
import { FakeFeishu } from './feishu-fake.mjs'
import { rig, TestClient } from './helpers.mjs'

const APP = 'cli_0123456789abcdef'
const OTHER = 'cli_fedcba9876543210'

async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function setup(t: TestContext, extra: { watchdog?: Record<string, number> } = {}) {
  const fake = new FakeFeishu()
  await fake.start()
  const env = rig(
    {},
    {},
    {
      feishu: {
        fixture: {
          origin: fake.origin,
          registrationIntervalMs: 10,
          ...(extra.watchdog ? { watchdog: extra.watchdog } : {}),
        },
      },
    },
  )
  const admin = new TestClient((wire) => env.device.attach(wire, true))
  await admin.initialize(['harness', 'litchFeishu'])
  t.after(async () => {
    admin.close()
    await env.close()
    await fake.close()
  })
  return { fake, env, admin }
}

test('手动填写：校验凭据、读机器人信息、起长连接；秘密只在私有文件里', async (t) => {
  const { fake, env, admin } = await setup(t)
  fake.addApp({ appId: APP, botName: '示例机器人' })
  const { app } = await admin.call(M.appConfigure, {
    operationId: 'op-1',
    appId: APP,
    appSecret: `secret-${APP}`,
  })
  assert.equal(app.name, '示例机器人')
  assert.equal(app.botOpenId, `ou_bot_${APP.slice(-6)}`)
  assert.equal(app.managerId, null)
  assert.equal(JSON.stringify(app).includes('secret-'), false)
  await until(() => fake.connected(APP) === 1)
  const listed = await until(async () => {
    const { apps } = await admin.call(M.appList, {})
    return apps[0]?.connection.state === 'connected' ? apps : undefined
  })
  assert.equal(listed.length, 1)
  await admin.waitFor((frame) => frame.method === 'litch/feishu/appsChanged')
  // 同一个操作 ID 重发，返回原结果，不再建一次
  const again = await admin.call(M.appConfigure, {
    operationId: 'op-1',
    appId: APP,
    appSecret: 'whatever',
  })
  assert.equal(again.app.appId, APP)
  const dir = join(env.stateDir, 'feishu-credentials')
  const files = readdirSync(dir)
  assert.deepEqual(files, [`${APP}-1`])
  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, files[0] as string)).mode & 0o777, 0o600)
  }
  assert.equal(readFileSync(join(dir, files[0] as string), 'utf8').includes(`secret-${APP}`), true)
  const db = readFileSync(join(env.stateDir, 'manager.sqlite'))
  assert.equal(db.includes(Buffer.from(`secret-${APP}`)), false)
})

test('凭据错、重复添加、非管理员写入都被拒', async (t) => {
  const { fake, env, admin } = await setup(t)
  fake.addApp({ appId: APP })
  const wrong = await admin.fails(M.appConfigure, {
    operationId: 'a',
    appId: APP,
    appSecret: 'nope',
  })
  assert.equal(wrong.message, 'feishu_credential_rejected')
  await admin.call(M.appConfigure, { operationId: 'b', appId: APP, appSecret: `secret-${APP}` })
  const dup = await admin.fails(M.appConfigure, {
    operationId: 'c',
    appId: APP,
    appSecret: `secret-${APP}`,
  })
  assert.equal(dup.message, 'feishu_app_exists')
  const plain = env.connect()
  await plain.initialize(['harness', 'litchFeishu'])
  const { apps } = await plain.call(M.appList, {})
  assert.equal(apps.length, 1)
  const denied = await plain.fails(M.appRemove, { appId: APP, expectedRevision: 1 })
  assert.equal((denied.data as { litch?: string }).litch, 'deviceAdminRequired')
  const undeclared = env.connect()
  await undeclared.initialize(['harness'])
  const required = await undeclared.fails(M.appList, {})
  assert.equal((required.data as { litch?: string }).litch, 'extensionRequired')
  plain.close()
  undeclared.close()
})

test('分配经理：一个经理只绑一个应用；不存在的经理拒绝', async (t) => {
  const { fake, env, admin } = await setup(t)
  fake.addApp({ appId: APP })
  fake.addApp({ appId: OTHER })
  await admin.call(M.appConfigure, { operationId: 'a', appId: APP, appSecret: `secret-${APP}` })
  await admin.call(M.appConfigure, { operationId: 'b', appId: OTHER, appSecret: `secret-${OTHER}` })
  const missing = await admin.fails(M.appUpdate, {
    appId: APP,
    expectedRevision: 1,
    managerId: 'nobody',
  })
  assert.equal(missing.message, 'feishu_manager_not_found')
  const store = env.device.managers.store
  store.saveManager({ id: 'm1', threadId: 't1' } as never)
  const current = (await admin.call(M.appGet, { appId: APP })).app
  const { app } = await admin.call(M.appUpdate, {
    appId: APP,
    expectedRevision: current.revision,
    managerId: 'm1',
  })
  assert.equal(app.managerId, 'm1')
  const other = (await admin.call(M.appGet, { appId: OTHER })).app
  const taken = await admin.fails(M.appUpdate, {
    appId: OTHER,
    expectedRevision: other.revision,
    managerId: 'm1',
  })
  assert.equal(taken.message, 'feishu_manager_taken')
  const stale = await admin.fails(M.appUpdate, {
    appId: APP,
    expectedRevision: current.revision,
    enabled: false,
  })
  assert.equal(stale.message, 'feishu_revision_conflict')
})

test('停用断开连接，启用重连；换 Secret 后用新一代重连并删掉旧文件', async (t) => {
  const { fake, env, admin } = await setup(t)
  const app = fake.addApp({ appId: APP })
  await admin.call(M.appConfigure, { operationId: 'a', appId: APP, appSecret: app.secret })
  await until(() => fake.connected(APP) === 1)
  let current = (await admin.call(M.appGet, { appId: APP })).app
  current = (
    await admin.call(M.appUpdate, {
      appId: APP,
      expectedRevision: current.revision,
      enabled: false,
    })
  ).app
  await until(() => fake.connected(APP) === 0)
  assert.equal(current.connection.state, 'stopped')
  current = (
    await admin.call(M.appUpdate, { appId: APP, expectedRevision: current.revision, enabled: true })
  ).app
  await until(() => fake.connected(APP) === 1)
  app.secret = 'rotated-secret'
  const rotated = await admin.call(M.appRotate, {
    operationId: 'r',
    appId: APP,
    appSecret: 'rotated-secret',
    expectedGeneration: 1,
  })
  assert.equal(rotated.app.credential.generation, 2)
  assert.deepEqual(readdirSync(join(env.stateDir, 'feishu-credentials')), [`${APP}-2`])
  await until(() => fake.connected(APP) === 1)
  const removed = (await admin.call(M.appGet, { appId: APP })).app
  await admin.call(M.appRemove, { appId: APP, expectedRevision: removed.revision })
  await until(() => fake.connected(APP) === 0)
  assert.deepEqual(readdirSync(join(env.stateDir, 'feishu-credentials')), [])
  assert.deepEqual((await admin.call(M.appList, {})).apps, [])
})

test('事件处理完才回 ACK；断线后 SDK 重连并调连上后的钩子', async (t) => {
  const { fake, env, admin } = await setup(t)
  const app = fake.addApp({ appId: APP })
  const feishu = env.device.feishu
  assert.ok(feishu)
  const seen: string[] = []
  let connects = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  feishu.on('im.message.receive_v1', async (appId, data) => {
    await gate
    seen.push(`${appId}:${String((data.message as { message_id?: string }).message_id)}`)
  })
  feishu.onConnected(() => {
    connects++
  })
  await admin.call(M.appConfigure, { operationId: 'a', appId: APP, appSecret: app.secret })
  await until(() => fake.connected(APP) === 1 && connects === 1)
  fake.addChat({ chatId: 'oc_1', name: '群', bots: new Set([APP]) })
  const message = fake.postMessage({ chatId: 'oc_1', sender: 'ou_a', text: 'hi' })
  let acked = false
  const ack = fake.push(APP, 'im.message.receive_v1', fake.receiveEvent(message)).then((value) => {
    acked = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(acked, false, '处理函数还没返回，不该回 ACK')
  release()
  assert.equal((await ack).code, 200)
  assert.deepEqual(seen, [`${APP}:${message.message_id}`])
  fake.drop(APP)
  await until(() => fake.connected(APP) === 1 && connects === 2)
  const listed = (await admin.call(M.appGet, { appId: APP })).app
  assert.equal(listed.connection.state, 'connected')
  assert.ok(listed.connection.reconnects >= 1)
})

test('凭据在飞书侧失效：连接标凭据被拒，不再重试', async (t) => {
  const { fake, admin } = await setup(t, {
    watchdog: { checkMs: 20, staleMs: 50, minBackoffMs: 10, maxBackoffMs: 20 },
  })
  const app = fake.addApp({ appId: APP })
  await admin.call(M.appConfigure, { operationId: 'a', appId: APP, appSecret: app.secret })
  await until(() => fake.connected(APP) === 1)
  app.secret = 'changed-elsewhere'
  fake.drop(APP)
  const failed = await until(async () => {
    const { app: current } = await admin.call(M.appGet, { appId: APP })
    return current.connection.state === 'failed' ? current : undefined
  })
  assert.equal(failed.connection.error.code, 'credential_rejected')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(fake.connected(APP), 0)
})

test('创建向导：轮询拿到凭据后自动添加；Lark 租户被拒；可取消', async (t) => {
  const { fake, admin } = await setup(t)
  fake.addApp({ appId: APP, botName: '向导机器人' })
  fake.registration = {
    deviceCode: '',
    polls: 0,
    completeAfter: 2,
    result: {
      client_id: APP,
      client_secret: `secret-${APP}`,
      user_info: { open_id: 'ou_creator', tenant_brand: 'feishu' },
    },
  }
  const { registration } = await admin.call(M.appRegisterBegin, {
    operationId: 'w',
    name: '向导机器人',
  })
  assert.equal(registration.state, 'waiting')
  const url = new URL(registration.url)
  assert.equal(url.hostname, 'open.feishu.cn')
  assert.equal(url.searchParams.get('name'), '向导机器人')
  assert.ok(url.searchParams.get('addons'))
  await admin.waitFor((frame) => frame.method === 'litch/feishu/registrationChanged', 5000)
  const done = (await admin.call(M.appRegisterGet, { registrationId: registration.registrationId }))
    .registration
  assert.equal(done.state, 'succeeded')
  assert.equal(done.appId, APP)
  assert.equal(done.url, undefined)
  const { app } = await admin.call(M.appGet, { appId: APP })
  assert.equal(app.creatorOpenId, 'ou_creator')

  fake.registration = {
    deviceCode: '',
    polls: 0,
    completeAfter: 1,
    result: { client_id: OTHER, client_secret: 'x', user_info: { tenant_brand: 'lark' } },
  }
  const lark = (await admin.call(M.appRegisterBegin, { operationId: 'w2', name: 'x' })).registration
  const failed = await until(async () => {
    const { registration: current } = await admin.call(M.appRegisterGet, {
      registrationId: lark.registrationId,
    })
    return current.state !== 'waiting' ? current : undefined
  })
  assert.equal(failed.state, 'error')
  assert.equal(failed.error, 'lark_tenant')

  fake.registration = { deviceCode: '', polls: 0, completeAfter: 0 }
  const waiting = (await admin.call(M.appRegisterBegin, { operationId: 'w3', name: 'y' }))
    .registration
  const canceled = (
    await admin.call(M.appRegisterCancel, { registrationId: waiting.registrationId })
  ).registration
  assert.equal(canceled.state, 'canceled')
})

test('能力自检列出缺项；补申请只追加清单里的并提交发布', async (t) => {
  const { fake, admin } = await setup(t)
  const app = fake.addApp({ appId: APP })
  await admin.call(M.appConfigure, { operationId: 'a', appId: APP, appSecret: app.secret })
  await until(() => fake.connected(APP) === 1)
  // 没开自管理权限
  let checked = (await admin.call(M.appCheck, { appId: APP })).app
  assert.equal(checked.capability.state, 'needs_self_manage')
  for (const scope of FEISHU_SCOPES) if (scope !== 'im:resource') app.scopes.add(scope)
  for (const event of FEISHU_EVENTS) app.events.add(event)
  checked = (await admin.call(M.appCheck, { appId: APP })).app
  assert.equal(checked.capability.state, 'missing')
  assert.deepEqual(checked.capability.missingScopes, ['im:resource'])
  assert.deepEqual(checked.capability.missingCallbacks, ['card.action.trigger'])
  const upgraded = (await admin.call(M.appUpgrade, { appId: APP, operationId: 'u' })).app
  assert.equal(upgraded.capability.publish.state, 'pending_review')
  assert.equal(fake.patches.length, 1)
  assert.deepEqual(fake.patches[0]?.body, {
    scope: { add_scopes: [{ scope_name: 'im:resource', token_type: 'tenant' }] },
    callback: { add_callbacks: ['card.action.trigger'] },
  })
  assert.equal(fake.publishes.length, 1)
  // 发布带上应用当前的两端默认能力，缺了平台回 210304
  assert.equal(fake.publishes[0]?.body.mobile_default_ability, 'bot')
  assert.equal(fake.publishes[0]?.body.pc_default_ability, 'bot')
  // 重发同一操作不再提交
  await admin.call(M.appUpgrade, { appId: APP, operationId: 'u' })
  assert.equal(fake.publishes.length, 1)
})

test('创建页地址只接受飞书主机', () => {
  assert.equal(creationUrl('https://example.com/x', 'a'), null)
  assert.equal(creationUrl('http://open.feishu.cn/x', 'a'), null)
  assert.ok(
    creationUrl('https://accounts.feishu.cn/x?user_code=1', 'a')?.includes('createOnly=true'),
  )
})

test('设备重启后按库里的配置重连', async (t) => {
  const fake = new FakeFeishu()
  await fake.start()
  const app = fake.addApp({ appId: APP })
  const first = rig({}, {}, { feishu: { fixture: { origin: fake.origin } } })
  const admin = new TestClient((wire) => first.device.attach(wire, true))
  await admin.initialize(['harness', 'litchFeishu'])
  await admin.call(M.appConfigure, { operationId: 'a', appId: APP, appSecret: app.secret })
  await until(() => fake.connected(APP) === 1)
  admin.close()
  await first.device.close()
  await until(() => fake.connected(APP) === 0)
  const second = rig(
    {},
    {},
    { stateDir: first.stateDir, feishu: { fixture: { origin: fake.origin } } },
  )
  t.after(async () => {
    await second.close()
    await fake.close()
  })
  await until(() => fake.connected(APP) === 1)
  assert.ok(existsSync(join(first.stateDir, 'feishu-credentials', `${APP}-1`)))
})
