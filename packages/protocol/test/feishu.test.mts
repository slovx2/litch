import assert from 'node:assert/strict'
import test from 'node:test'
import { Ajv2019 } from 'ajv/dist/2019.js'
import feishu from '../../../protocol/extensions/feishu.json' with { type: 'json' }
import {
  FEISHU_EXTENSION,
  FEISHU_METHOD,
  FEISHU_NOTIFICATION,
  type FeishuApp,
  type FeishuBinding,
  type FeishuChat,
  type FeishuInboxEntry,
  type FeishuInboxMessage,
  type FeishuNotifications,
  type FeishuOutboxEntry,
  type FeishuRegistration,
  type FeishuRequests,
} from '../src/feishu.mjs'
import { isFeishuMethod, isFeishuMethodParams } from '../src/feishu-validation.mjs'

const ajv = new Ajv2019({ strict: false })
ajv.addSchema(feishu, feishu.extension)

function wire(name: string, field: 'params' | 'result', value: unknown): boolean {
  const i = feishu.parts.findIndex((part) => part.name === name)
  assert.notEqual(i, -1, name)
  const validate = ajv.compile({ $ref: `${feishu.extension}#/parts/${i}/${field}` })
  return validate(value) as boolean
}

const appId = 'cli_0123456789abcdef'
const app = {
  appId,
  revision: 2,
  name: '示例机器人',
  botOpenId: 'ou_example',
  managerId: 'manager-1',
  enabled: true,
  credential: { generation: 1, updatedAt: 10 },
  connection: { state: 'connected', since: 11, lastConnectedAt: 11, reconnects: 0 },
  capability: {
    checkedAt: 12,
    state: 'missing',
    missingScopes: ['im:resource'],
    missingEvents: [],
    missingCallbacks: ['card.action.trigger'],
    missingUserScopes: ['im:chat:read'],
    refreshTokenDisabled: true,
  },
  createdAt: 9,
} satisfies FeishuApp
const registration = {
  registrationId: 'reg-1',
  revision: 1,
  state: 'waiting',
  name: '示例机器人',
  url: 'https://open.feishu.cn/page/launcher?user_code=X',
  expiresAt: 600,
} satisfies FeishuRegistration

const chatId = 'oc_example1'
const chat = {
  appId,
  chatId,
  revision: 3,
  name: '示例项目群',
  external: true,
  status: 'normal',
  botPresent: true,
  access: {
    speech: 'approval',
    wakeBound: true,
    wakers: [{ openId: 'ou_alice', name: '示例成员甲' }],
    retentionDays: 90,
    reviewTtlHours: 24,
    accessAt: 20,
  },
  updatedAt: 21,
} satisfies FeishuChat
const access = {
  appId,
  chatId,
  expectedRevision: 2,
  speech: 'approval',
  confirmExternal: true,
  wakeBound: true,
  wakers: ['ou_alice'],
  retentionDays: 90,
  reviewTtlHours: 24,
} as const

const inboxEntry = {
  inboxId: 'FI-1',
  status: 'notified',
  appId,
  managerId: 'm-1',
  chatId,
  chatKind: 'group',
  messageId: 'om_1',
  senderOpenId: 'ou_alice',
  senderName: '示例成员甲',
  senderIdentity: 'member',
  trigger: 'mention',
  createdAt: 40,
  receivedAt: 41,
  deliveryId: 'd-1',
  notifiedAt: 60,
  note: 'rate_limited',
} satisfies FeishuInboxEntry
const inboxMessage = {
  chatName: '示例项目群',
  text: '@机器人 看一下',
  msgType: 'text',
  state: 'normal',
  purged: false,
} satisfies FeishuInboxMessage

const binding = {
  appId,
  openId: 'ou_alice',
  revision: 2,
  name: '示例成员甲',
  unionId: 'on_alice',
  state: 'bound',
  approver: true,
  retentionDays: 90,
  boundAt: 90,
} satisfies FeishuBinding

const outboxEntry = {
  operationId: 'op-sample-1',
  appId,
  managerId: 'm-1',
  target: { kind: 'chat', id: chatId, name: '示例项目群' },
  replyTo: 'om_parent',
  format: 'post',
  summary: '示例发言',
  parts: 1,
  messageIds: [],
  mentions: [{ openId: 'ou_alice', name: '示例成员甲' }],
  state: 'awaiting_approval',
  reviewId: 'A-1',
  attempts: 0,
  createdAt: 80,
  updatedAt: 80,
} satisfies FeishuOutboxEntry

const samples: {
  [M in keyof FeishuRequests]: [FeishuRequests[M]['params'], FeishuRequests[M]['result']]
} = {
  [FEISHU_METHOD.appList]: [{}, { apps: [app], admin: true }],
  [FEISHU_METHOD.appGet]: [{ appId }, { app }],
  [FEISHU_METHOD.appRegisterBegin]: [{ operationId: 'op', name: '示例机器人' }, { registration }],
  [FEISHU_METHOD.appRegisterGet]: [{ registrationId: 'reg-1' }, { registration }],
  [FEISHU_METHOD.appRegisterCancel]: [
    { registrationId: 'reg-1' },
    { registration: { ...registration, state: 'canceled' } },
  ],
  [FEISHU_METHOD.appConfigure]: [{ operationId: 'op', appId, appSecret: 'fixture-only' }, { app }],
  [FEISHU_METHOD.appRotate]: [
    { operationId: 'op', appId, appSecret: 'fixture-only', expectedGeneration: 1 },
    { app },
  ],
  [FEISHU_METHOD.appUpdate]: [
    { appId, expectedRevision: 2, managerId: null, enabled: false },
    { app },
  ],
  [FEISHU_METHOD.appRemove]: [{ appId, expectedRevision: 2 }, {}],
  [FEISHU_METHOD.appCheck]: [{ appId }, { app }],
  [FEISHU_METHOD.appUpgrade]: [{ appId, operationId: 'op' }, { app }],
  [FEISHU_METHOD.chatList]: [
    { appId, refresh: true },
    { chats: [chat, { ...chat, chatId: 'oc_other', access: null }], syncedAt: null },
  ],
  [FEISHU_METHOD.chatGet]: [{ appId, chatId }, { chat }],
  [FEISHU_METHOD.chatMembers]: [
    { appId, chatId },
    { members: [{ openId: 'ou_alice', name: '示例成员甲' }], fetchedAt: 30 },
  ],
  [FEISHU_METHOD.chatAccess]: [access, { chat }],
  [FEISHU_METHOD.chatUpdate]: [
    { appId, chatId, expectedRevision: 3, speech: 'free', reviewTtlHours: 48 },
    { chat },
  ],
  [FEISHU_METHOD.chatUnaccess]: [
    { appId, chatId, expectedRevision: 3, deleteRecords: false },
    { chat: { ...chat, access: null, records: { messages: 12, oldestAt: 5 } } },
  ],
  [FEISHU_METHOD.chatBackfill]: [
    { appId, chatId, start: 100, end: 200 },
    {
      chat: {
        ...chat,
        records: {
          messages: 12,
          oldestAt: 5,
          backfill: {
            kind: 'manual',
            state: 'running',
            start: 100,
            end: 200,
            fetched: 0,
            truncated: false,
            startedAt: 300,
          },
          gap: { at: 290, start: 280, end: 290, fetched: 3, complete: true },
        },
      },
    },
  ],
  [FEISHU_METHOD.inboxList]: [
    { managerId: 'm-1', statuses: ['queued', 'notified'], before: 'FI-9', limit: 20 },
    { entries: [inboxEntry], messages: { 'FI-1': inboxMessage }, next: 'FI-1' },
  ],
  [FEISHU_METHOD.inboxGet]: [
    { inboxId: 'FI-1' },
    { entry: { ...inboxEntry, status: 'processed', processedAt: 70 }, message: null },
  ],
  [FEISHU_METHOD.outboxList]: [
    { appId, states: ['awaiting_approval', 'unknown'], before: 'op-sample-9', limit: 20 },
    {
      entries: [
        outboxEntry,
        {
          ...outboxEntry,
          operationId: 'op-sample-2',
          state: 'sent',
          messageIds: ['om_sent'],
          attempts: 1,
          sentAt: 90,
        },
        {
          ...outboxEntry,
          operationId: 'op-sample-3',
          cli: { method: 'POST', path: '/open-apis/im/v1/messages', action: 'send' },
        },
      ],
      next: 'op-sample-2',
    },
  ],
  [FEISHU_METHOD.outboxCancel]: [
    { appId, operationId: 'op-sample-1' },
    { entry: { ...outboxEntry, state: 'canceled', error: 'canceled_by_admin' } },
  ],
  [FEISHU_METHOD.grantList]: [
    { appId },
    {
      grants: [
        {
          appId,
          openId: 'ou_alice',
          revision: 3,
          name: '示例成员甲',
          state: 'active',
          scopes: ['docx:document:readonly', 'offline_access'],
          grantedAt: 10,
          lastUsedAt: 20,
          refreshedAt: 15,
          pending: {
            verificationUrl:
              'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH',
            userCode: 'ABCD-EFGH',
            expiresAt: 300,
          },
        },
        {
          appId,
          openId: 'ou_bob',
          revision: 2,
          name: '示例成员乙',
          state: 'failed',
          scopes: [],
          error: 'identity_mismatch',
        },
      ],
    },
  ],
  [FEISHU_METHOD.grantInvite]: [
    { appId, openId: 'ou_bob', operationId: 'grant-op-1' },
    {
      grant: {
        appId,
        openId: 'ou_bob',
        revision: 3,
        name: '示例成员乙',
        state: 'pending',
        scopes: [],
        pending: {
          verificationUrl: 'https://accounts.feishu.cn/x',
          userCode: 'WXYZ-1234',
          expiresAt: 240,
        },
      },
    },
  ],
  [FEISHU_METHOD.grantRevoke]: [
    { appId, openId: 'ou_alice' },
    {
      grant: {
        appId,
        openId: 'ou_alice',
        revision: 4,
        name: '示例成员甲',
        state: 'revoked',
        scopes: [],
        revokedAt: 30,
        error: 'revoked_by_admin',
      },
    },
  ],
  [FEISHU_METHOD.bindingList]: [
    { appId },
    {
      bindings: [
        binding,
        {
          ...binding,
          openId: 'ou_bob',
          revision: 3,
          state: 'revoked',
          approver: false,
          revokedAt: 95,
        },
      ],
    },
  ],
  [FEISHU_METHOD.bindingLookup]: [
    { appId, code: 'abcd-efgh' },
    {
      pairing: {
        appId,
        openId: 'ou_carol',
        name: '示例用户丙',
        unionId: 'on_carol',
        createdAt: 90,
        expiresAt: 3690,
      },
    },
  ],
  [FEISHU_METHOD.bindingApprove]: [{ appId, code: 'ABCDEFGH' }, { binding }],
  [FEISHU_METHOD.bindingRevoke]: [
    { appId, openId: 'ou_alice', expectedRevision: 2 },
    { binding: { ...binding, state: 'revoked', revokedAt: 99 } },
  ],
  [FEISHU_METHOD.bindingUpdate]: [
    { appId, openId: 'ou_alice', expectedRevision: 2, approver: false, retentionDays: 30 },
    { binding: { ...binding, approver: false, retentionDays: 30 } },
  ],
}

test('每个方法的样本都通过定义和入站校验', () => {
  assert.equal(feishu.extension, FEISHU_EXTENSION)
  const methods = feishu.parts.filter((part) => part.kind === 'Method').map((part) => part.name)
  assert.deepEqual(methods.sort(), Object.values(FEISHU_METHOD).sort())
  for (const [method, [params, result]] of Object.entries(samples)) {
    assert.ok(isFeishuMethod(method))
    assert.ok(wire(method, 'params', params), `${method} params`)
    assert.ok(wire(method, 'result', result), `${method} result`)
    assert.ok(isFeishuMethodParams(method, params), `${method} 入站`)
  }
})

test('通知样本通过定义', () => {
  const notifications = feishu.parts
    .filter((part) => part.kind === 'Notification')
    .map((part) => part.name)
  assert.deepEqual(notifications.sort(), Object.values(FEISHU_NOTIFICATION).sort())
  const params: FeishuNotifications = {
    [FEISHU_NOTIFICATION.appsChanged]: { appId },
    [FEISHU_NOTIFICATION.registrationChanged]: { registrationId: 'reg-1', revision: 1 },
    [FEISHU_NOTIFICATION.chatsChanged]: { appId, chatId },
    [FEISHU_NOTIFICATION.inboxChanged]: { managerId: 'm-1', appId },
    [FEISHU_NOTIFICATION.outboxChanged]: { appId, operationId: 'op-sample-1' },
    [FEISHU_NOTIFICATION.bindingsChanged]: { appId, openId: 'ou_alice' },
    [FEISHU_NOTIFICATION.grantsChanged]: { appId, openId: 'ou_alice' },
  }
  for (const [name, value] of Object.entries(params)) assert.ok(wire(name, 'params', value), name)
})

test('入站校验拒绝畸形参数，结果不收秘密', () => {
  assert.equal(isFeishuMethodParams(FEISHU_METHOD.appGet, { appId: 'cli_short' }), false)
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.appRegisterBegin, { operationId: 'op', name: '  ' }),
    false,
  )
  assert.equal(isFeishuMethodParams(FEISHU_METHOD.appUpdate, { appId, expectedRevision: 0 }), false)
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.appConfigure, { operationId: 'op', appId }),
    false,
  )
  assert.equal(isFeishuMethod('litch/feishu/app/unknown'), false)
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.outboxCancel, { appId, operationId: 'short' }),
    false,
    '操作 ID 要放得进飞书 uuid',
  )
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.outboxList, { appId, states: ['sent', 'sent'] }),
    false,
  )
  assert.equal(isFeishuMethodParams(FEISHU_METHOD.bindingLookup, { appId, code: 'ABC' }), false)
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.bindingUpdate, {
      appId,
      openId: 'ou_alice',
      expectedRevision: 1,
    }),
    false,
    '改绑定至少带一项',
  )
  const { speech: _speech, ...noSpeech } = access
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.chatAccess, noSpeech),
    false,
    '接入必须选发言模式',
  )
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.chatAccess, { ...access, wakers: ['ou_a', 'ou_a'] }),
    false,
  )
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.chatAccess, { ...access, reviewTtlHours: 169 }),
    false,
  )
  assert.equal(wire(FEISHU_METHOD.chatAccess, 'params', { ...access, reviewTtlHours: 0 }), false)
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.chatUnaccess, { appId, chatId, expectedRevision: 3 }),
    false,
  )
  assert.equal(
    isFeishuMethodParams(FEISHU_METHOD.chatBackfill, { appId, chatId, start: 200, end: 200 }),
    false,
    '补历史的窗口不能为空',
  )
  assert.equal(wire(FEISHU_METHOD.appGet, 'result', { app: { ...app, appSecret: 'x' } }), false)
  assert.equal(
    wire(FEISHU_METHOD.appRegisterGet, 'result', {
      registration: { ...registration, url: 'https://example.com/x' },
    }),
    false,
  )
})
