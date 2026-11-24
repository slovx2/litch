// F7：lark-cli 的设备代理。按 sidecar 协议 v1 签名的请求发到代理，代理验签、按放行规则分类、换上应用令牌转发到假飞书：
// 读和不说话的写放行；鉴权接口、别的主机、用户身份、签名不对、时间差太大、租约收回都拒绝；
// 发言按发言权限管理器：自由发言的群直接发并记进消息库，审批发言的群冻结原始请求转审批（批了原样发），未接入的群拒绝。
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
const FREE = 'oc_free'
const GATED = 'oc_gated'
const OTHER = 'oc_other'

async function setup(t: TestContext) {
  const pi = new FakeEngine('pi')
  const h = await FeishuFakeHarness.start(t, {
    upstreams: { pi },
    outboxTickMs: 10,
    extensions: ['litchReviews'],
    cliBinary: '/usr/bin/true',
  })
  h.fake.addApp({ appId: APP })
  for (const [chatId, name] of [
    [FREE, '示例自由群'],
    [GATED, '示例审批群'],
    [OTHER, '示例未接入群'],
  ] as const)
    h.fake.addChat({
      chatId,
      name,
      bots: new Set([APP]),
      members: [{ openId: 'ou_amy', name: '示例用户甲' }],
    })
  await h.configure(APP)
  await h.until(async () => (await h.admin.call(M.chatList, { appId: APP })).chats.length === 3)
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
  for (const [chatId, speech] of [
    [FREE, 'free'],
    [GATED, 'approval'],
  ] as const) {
    const chat = (await h.admin.call(M.chatGet, { appId: APP, chatId })).chat
    await h.admin.call(M.chatAccess, {
      appId: APP,
      chatId,
      expectedRevision: chat.revision,
      speech,
      wakeBound: false,
      wakers: [],
      retentionDays: 90,
      reviewTtlHours: 2,
    })
  }
  const feishu = h.env.device.feishu
  assert.ok(feishu)
  await feishu.records.idle()
  // 测试里没有命令入口：会话是否仍是这位经理的，由用例自己定
  let valid = true
  feishu.cli.current = () => valid
  const actor = { kind: 'manager' as const, managerId: manager.id, threadId }
  const granted = await feishu.cli.lease(actor)
  assert.ok(granted && 'lease' in granted, JSON.stringify(granted))
  const { env } = granted
  /** 照 lark-cli 的做法签名并发出 */
  const send = async (
    method: string,
    pathAndQuery: string,
    body?: unknown,
    over: { identity?: string; target?: string; key?: string; at?: number; auth?: string } = {},
  ) => {
    const bytes = Buffer.from(body === undefined ? '' : JSON.stringify(body))
    const sha = createHash('sha256').update(bytes).digest('hex')
    const timestamp = String(over.at ?? Math.floor(Date.now() / 1000))
    const target = over.target ?? 'https://open.feishu.cn'
    const identity = over.identity ?? 'bot'
    const auth = over.auth ?? 'Authorization'
    const canonical = [
      'v1',
      method,
      new URL(target).host,
      pathAndQuery,
      sha,
      timestamp,
      identity,
      auth,
    ].join('\n')
    const signature = createHmac('sha256', over.key ?? env.LARKSUITE_CLI_PROXY_KEY ?? '')
      .update(canonical)
      .digest('hex')
    const response = await fetch(`${env.LARKSUITE_CLI_AUTH_PROXY}${pathAndQuery}`, {
      method,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-lark-proxy-version': 'v1',
        'x-lark-proxy-target': target,
        'x-lark-proxy-identity': identity,
        'x-lark-proxy-auth-header': auth,
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
    manager,
    threadId,
    env,
    send,
    lease: granted.lease,
    invalidate: () => {
      valid = false
    },
  }
}

test('租约：应用、占位与隔离目录；没绑应用的经理交回宿主', async (t) => {
  const { feishu, env, threadId } = await setup(t)
  assert.match(env.LARKSUITE_CLI_AUTH_PROXY ?? '', /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(env.LARKSUITE_CLI_APP_ID, APP)
  assert.equal(env.LARKSUITE_CLI_STRICT_MODE, 'bot')
  assert.match(env.LARKSUITE_CLI_PROXY_KEY ?? '', /^[0-9a-f]{64}$/)
  assert.ok(env.LARKSUITE_CLI_CONFIG_DIR?.includes('feishu-cli'))
  assert.equal(await feishu.cli.lease({ kind: 'manager', managerId: 'm_nobody', threadId }), null)
})

test('放行读接口；拒绝签名不对、时间差、别的主机、用户身份、鉴权接口、MCP', async (t) => {
  const { h, send } = await setup(t)
  const before = h.fake.calls.length
  const ok = await send('GET', '/open-apis/im/v1/chats?page_size=20')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.code, 0)
  assert.ok(h.fake.calls.slice(before).some((one) => one.path === '/open-apis/im/v1/chats'))
  const refusals: [Promise<{ status: number }>, number][] = [
    [send('GET', '/open-apis/im/v1/chats', undefined, { key: 'f'.repeat(64) }), 401],
    [send('GET', '/open-apis/im/v1/chats', undefined, { at: 1_000 }), 401],
    [send('GET', '/open-apis/im/v1/chats', undefined, { target: 'https://evil.example' }), 403],
    [send('GET', '/open-apis/im/v1/chats', undefined, { identity: 'user' }), 401],
    [send('POST', '/open-apis/auth/v3/tenant_access_token/internal', {}), 403],
    // fetch 会把点段规范掉，换成编码过的斜杠
    [send('GET', '/open-apis/im/v1%2fchats'), 403],
    [send('GET', '/open-apis/im/v1/chats', undefined, { auth: 'X-Lark-MCP-TAT' }), 403],
  ]
  const calls = h.fake.calls.length
  for (const [pending, status] of refusals) assert.equal((await pending).status, status)
  assert.equal(h.fake.calls.length, calls, '拒绝的请求一条都没转到飞书')
})

test('自由发言的群直接发并记进消息库；未接入的群拒绝', async (t) => {
  const { h, feishu, send } = await setup(t)
  const sent = await send('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: FREE,
    msg_type: 'text',
    content: JSON.stringify({ text: '测试：经 CLI 发到自由群' }),
  })
  assert.equal(sent.status, 200)
  const messageId = sent.body.data.message_id as string
  assert.equal(feishu.messages.get(APP, messageId)?.chatId, FREE)
  const refused = await send('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: OTHER,
    msg_type: 'text',
    content: JSON.stringify({ text: '测试：不该发出' }),
  })
  assert.equal(refused.status, 403)
  assert.match(refused.body.msg, /not accessed/)
  assert.ok(!h.fake.messages.some((one) => one.chat_id === OTHER))
})

test('审批发言的群：原始请求冻结转审批，批了原样发出', async (t) => {
  const { h, feishu, send } = await setup(t)
  const queued = await send('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: GATED,
    msg_type: 'text',
    content: JSON.stringify({ text: '测试：经 CLI 发到审批群' }),
    uuid: 'cli-test-0001',
  })
  assert.equal(queued.status, 403)
  const reviewId = queued.body.data.litch_review_id as string
  assert.match(reviewId, /^A-\d+$/)
  assert.match(queued.body.msg, /不要重试/)
  assert.ok(
    !h.fake.messages.some((one) => one.chat_id === GATED && one.sender.sender_type === 'app'),
  )
  const review = (await h.admin.call(R.get, { reviewId })).review
  assert.equal(review.preview.cli?.action, 'send')
  assert.equal(review.preview.parts[0]?.text, '测试：经 CLI 发到审批群')
  await h.admin.call(R.decide, {
    reviewId,
    decision: 'approve',
    expectedRevision: review.revision,
  })
  await feishu.outbox.idle()
  const delivered = h.fake.messages.find(
    (one) => one.chat_id === GATED && one.sender.sender_type === 'app',
  )
  assert.match(delivered?.content ?? '', /经 CLI 发到审批群/)
  const entry = feishu.outbox.list(APP, undefined, 5).find((one) => one.reviewId === reviewId)
  assert.equal(entry?.state, 'sent')
  assert.equal(entry?.cli?.method, 'POST')
})

test('租约归还或会话不再是这位经理的，请求一律拒绝', async (t) => {
  const { feishu, send, lease, invalidate } = await setup(t)
  invalidate()
  assert.equal((await send('GET', '/open-apis/im/v1/chats')).status, 401)
  feishu.cli.release(lease)
  feishu.cli.current = () => true
  assert.equal((await send('GET', '/open-apis/im/v1/chats')).status, 401)
})
