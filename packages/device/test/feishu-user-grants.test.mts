// F7：用户身份授权。只有已绑定的人能授权，设备码流程拿链接和用户码，本人点同意后设备先查是谁，对不上就作废；
// token 只在设备里：lark-cli 用 LITCH_FEISHU_AS_USER 指定用户，代理换上这个人的 token；快过期先刷新，刷新被拒就失效，不改用机器人；
// 以用户身份在审批发言的群发言照样转审批（标明身份），批了用这个人的 token 发；撤销绑定一并撤销授权。
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { FEISHU_METHOD as M } from '../../protocol/src/feishu.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../../protocol/src/manager.mjs'
import { REVIEWS_METHOD as R } from '../../protocol/src/reviews.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { FeishuFakeHarness } from './feishu-harness.mjs'
import { until } from './tree-kit.mjs'

const APP = 'cli_0123456789abcdef'
const GATED = 'oc_gated'
const CAROL = 'ou_carol'
const DAVE = 'ou_dave'
const p2p = (openId: string) => `oc_p2p_${openId}`
const codeIn = (text: string) => /([A-Z2-9]{4})-([A-Z2-9]{4})/.exec(text)

async function setup(t: TestContext) {
  let clock = Math.floor(Date.now() / 1000)
  const pi = new FakeEngine('pi')
  const h = await FeishuFakeHarness.start(t, {
    upstreams: { pi },
    now: () => clock,
    outboxTickMs: 10,
    grantPollMs: 10,
    extensions: ['litchReviews'],
    cliBinary: '/usr/bin/true',
  })
  h.fake.addApp({ appId: APP })
  h.fake.users.set(CAROL, { name: '示例用户丙' })
  h.fake.users.set(DAVE, { name: '示例用户丁' })
  h.fake.addChat({
    chatId: GATED,
    name: '示例审批群',
    bots: new Set([APP]),
    members: [
      { openId: CAROL, name: '示例用户丙' },
      { openId: DAVE, name: '示例用户丁' },
    ],
  })
  await h.configure(APP)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 1)
  const client = h.env.connect()
  await client.initialize(['harness', 'litchManager'])
  t.after(() => client.close())
  const { manager, threadId } = await client.call(MANAGER_METHOD.create, {
    cwd: h.env.stateDir,
    harness: 'pi',
    model: null,
    effort: null,
    name: '经理',
    scope: '测试',
    template: 'blank',
    dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
    contact: { ...MANAGER_DEFAULT_CONTACT },
    rules: '',
    firstTask: '',
  })
  await until(() => pi.running(threadId), '经理第一个回合')
  const current = (await h.admin.call(M.appGet, { appId: APP })).app
  await h.admin.call(M.appUpdate, {
    appId: APP,
    expectedRevision: current.revision,
    managerId: manager.id,
  })
  const chat = (await h.admin.call(M.chatGet, { appId: APP, chatId: GATED })).chat
  await h.admin.call(M.chatAccess, {
    appId: APP,
    chatId: GATED,
    expectedRevision: chat.revision,
    speech: 'approval',
    wakeBound: false,
    wakers: [],
    retentionDays: 90,
    reviewTtlHours: 2,
  })
  const feishu = h.env.device.feishu
  assert.ok(feishu)
  await feishu.records.idle()
  const bind = async (openId: string) => {
    const message = h.fake.postMessage({
      chatId: p2p(openId),
      sender: openId,
      text: '你好',
      chatType: 'p2p',
    })
    await h.fake.push(APP, 'im.message.receive_v1', h.fake.receiveEvent(message))
    await feishu.bindings.idle()
    const said = h.fake.messages.filter(
      (one) => one.chat_id === p2p(openId) && one.sender.sender_type === 'app',
    )
    const code = codeIn(JSON.parse(said.at(-1)?.content ?? '{}').text as string)
    assert.ok(code, '回了配对码')
    return (await h.admin.call(M.bindingApprove, { appId: APP, code: `${code[1]}${code[2]}` }))
      .binding
  }
  await bind(CAROL)
  await bind(DAVE)
  feishu.cli.current = () => true
  const actor = { kind: 'manager' as const, managerId: manager.id, threadId }
  /** 发起授权，返回用户码 */
  const invite = async (openId: string, operationId: string) => {
    const { grant } = await h.admin.call(M.grantInvite, { appId: APP, openId, operationId })
    assert.ok(grant.pending?.userCode)
    return grant.pending.userCode as string
  }
  const settled = async (openId: string) => {
    await h.until(() => !feishu.grants.polling(APP, openId))
    return feishu.grants.get(APP, openId)
  }
  /** 照 lark-cli 的做法签名并发出 */
  const send = async (
    env: Record<string, string>,
    method: string,
    pathAndQuery: string,
    body?: unknown,
    identity = 'bot',
  ) => {
    const bytes = Buffer.from(body === undefined ? '' : JSON.stringify(body))
    const sha = createHash('sha256').update(bytes).digest('hex')
    const timestamp = String(clock)
    const canonical = [
      'v1',
      method,
      'open.feishu.cn',
      pathAndQuery,
      sha,
      timestamp,
      identity,
      'Authorization',
    ].join('\n')
    const signature = createHmac('sha256', env.LARKSUITE_CLI_PROXY_KEY ?? '')
      .update(canonical)
      .digest('hex')
    const response = await fetch(`${env.LARKSUITE_CLI_AUTH_PROXY}${pathAndQuery}`, {
      method,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-lark-proxy-version': 'v1',
        'x-lark-proxy-target': 'https://open.feishu.cn',
        'x-lark-proxy-identity': identity,
        'x-lark-proxy-auth-header': 'Authorization',
        'x-lark-body-sha256': sha,
        'x-lark-proxy-timestamp': timestamp,
        'x-lark-proxy-signature': signature,
      },
      ...(bytes.length ? { body: bytes } : {}),
    })
    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }
  return {
    h,
    feishu,
    actor,
    invite,
    settled,
    send,
    advance: (seconds: number) => {
      clock += seconds
    },
  }
}

test('授权：本人点了同意才生效，按名字指定用户以他的身份调接口；token 不进租约', async (t) => {
  const { h, feishu, actor, invite, settled, send } = await setup(t)
  const code = await invite(CAROL, 'grant-carol-1')
  const request = [...h.fake.grantRequests.values()].at(-1)
  assert.match(request?.scope ?? '', /offline_access/)
  assert.match(request?.scope ?? '', /im:message\.send_as_user/)
  h.fake.approveGrant(code, CAROL)
  const grant = await settled(CAROL)
  assert.equal(grant?.state, 'active')
  assert.equal(grant?.pending, undefined)
  const lease = await feishu.cli.lease(actor, '示例用户丙')
  assert.ok(lease && 'lease' in lease, JSON.stringify(lease))
  assert.equal(lease.env.LARKSUITE_CLI_DEFAULT_AS, 'user')
  for (const token of h.fake.userTokens.keys())
    assert.ok(!JSON.stringify(lease).includes(token), '租约里没有用户 token')
  const read = await send(lease.env, 'GET', '/open-apis/im/v1/chats', undefined, 'user')
  assert.equal(read.status, 200)
  assert.equal(h.fake.calls.at(-1)?.userOpenId, CAROL)
  // 机器人身份照样能用
  await send(lease.env, 'GET', '/open-apis/im/v1/chats')
  assert.equal(h.fake.calls.at(-1)?.userOpenId, undefined)
  // 没授权的人、没指定用户时用户身份都拒绝
  assert.match(
    String(
      (await feishu.cli.lease(actor, DAVE)) && JSON.stringify(await feishu.cli.lease(actor, DAVE)),
    ),
    /has not granted/,
  )
  const plain = await feishu.cli.lease(actor)
  assert.ok(plain && 'lease' in plain)
  assert.equal(
    (await send(plain.env, 'GET', '/open-apis/im/v1/chats', undefined, 'user')).status,
    401,
  )
})

test('链接被别人点了：作废 token、记失败；本人拒绝也记失败', async (t) => {
  const { h, invite, settled } = await setup(t)
  const code = await invite(DAVE, 'grant-dave-1')
  h.fake.approveGrant(code, CAROL)
  const grant = await settled(DAVE)
  assert.equal(grant?.state, 'failed')
  assert.equal(grant?.error, 'identity_mismatch')
  assert.ok(h.fake.revoked.length >= 1, '作废了拿到的 token')
  const again = await invite(DAVE, 'grant-dave-2')
  h.fake.denyGrant(again)
  assert.equal((await settled(DAVE))?.error, 'denied')
})

test('应用没开刷新：不收这次授权', async (t) => {
  const { h, invite, settled } = await setup(t)
  h.fake.omitRefreshToken = true
  h.fake.approveGrant(await invite(CAROL, 'grant-carol-nr'), CAROL)
  const grant = await settled(CAROL)
  assert.equal(grant?.state, 'failed')
  assert.equal(grant?.error, 'no_refresh_token')
})

test('快过期先刷新（换一代）；刷新被拒就失效，用户身份拒绝、不改用机器人', async (t) => {
  const { h, feishu, actor, invite, settled, send, advance } = await setup(t)
  h.fake.approveGrant(await invite(CAROL, 'grant-carol-2'), CAROL)
  await settled(CAROL)
  const lease = await feishu.cli.lease(actor, CAROL)
  assert.ok(lease && 'lease' in lease)
  const before = h.fake.userTokens.size
  advance(7200)
  const renewed = await send(lease.env, 'GET', '/open-apis/im/v1/chats', undefined, 'user')
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body))
  assert.equal(h.fake.calls.at(-1)?.userOpenId, CAROL)
  assert.ok(h.fake.userTokens.size > before, '刷新拿了新 token')
  h.fake.rejectRefresh = true
  advance(7200)
  const refused = await send(lease.env, 'GET', '/open-apis/im/v1/chats', undefined, 'user')
  assert.equal(refused.status, 401)
  assert.match(refused.body.msg, /no longer valid/)
  assert.equal(feishu.grants.get(APP, CAROL)?.state, 'expired')
})

test('以用户身份在审批群发言：转审批并标明身份，批了用他的 token 发；撤销绑定一并撤销授权', async (t) => {
  const { h, feishu, actor, invite, settled, send } = await setup(t)
  h.fake.approveGrant(await invite(CAROL, 'grant-carol-3'), CAROL)
  await settled(CAROL)
  const lease = await feishu.cli.lease(actor, CAROL)
  assert.ok(lease && 'lease' in lease)
  const queued = await send(
    lease.env,
    'POST',
    '/open-apis/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: GATED,
      msg_type: 'text',
      content: JSON.stringify({ text: '测试：以用户身份发' }),
    },
    'user',
  )
  assert.equal(queued.status, 403)
  const reviewId = queued.body.data.litch_review_id as string
  const review = (await h.admin.call(R.get, { reviewId })).review
  assert.deepEqual(review.preview.actingAs, { type: 'user', openId: CAROL, name: '示例用户丙' })
  await h.admin.call(R.decide, { reviewId, decision: 'approve', expectedRevision: review.revision })
  await feishu.outbox.idle()
  const post = h.fake.calls
    .filter((one) => one.method === 'POST' && one.path === '/open-apis/im/v1/messages')
    .at(-1)
  assert.equal(post?.userOpenId, CAROL, '批了以后用本人的 token 发')
  const binding = (await h.admin.call(M.bindingList, { appId: APP })).bindings.find(
    (one: { openId: string }) => one.openId === CAROL,
  )
  assert.ok(binding)
  await h.admin.call(M.bindingRevoke, {
    appId: APP,
    openId: CAROL,
    expectedRevision: binding.revision,
  })
  assert.equal(feishu.grants.get(APP, CAROL)?.state, 'revoked')
  await h.until(() => h.fake.revoked.length >= 2)
})
