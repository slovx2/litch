// 飞书 CLI 代理的放行规则：路径规范化、鉴权接口一律拒绝、发言类认出目标、其余放行。
import assert from 'node:assert/strict'
import test from 'node:test'
import { auditPath, normalizePath, routeCliRequest } from '../src/feishu/cli-policy.mjs'

test('路径规范化：可疑写法一律不认', () => {
  assert.equal(normalizePath('/open-apis/im/v1/chats/'), '/open-apis/im/v1/chats')
  for (const bad of [
    'open-apis/im/v1/chats',
    '/open-apis/im/v1/../auth/v3/x',
    '/open-apis/im//v1/messages',
    '/open-apis/im/v1%2fmessages',
    '/open-apis/im/v1/messages;x=1',
    '/open-apis/im/%2e%2e/auth',
    '/open-apis/im/v1/./messages',
    '/open-apis/im\\v1',
    '/open-apis/%zz',
  ])
    assert.equal(normalizePath(bad), null, bad)
})

test('鉴权、令牌、长连接接口拒绝；方法不认识的拒绝', () => {
  for (const path of [
    '/open-apis/auth/v3/tenant_access_token/internal',
    '/open-apis/AUTH/v3/app_access_token',
    '/open-apis/authen/v1/oidc/access_token',
    '/open-apis/authen/v2/oauth/token',
    '/oauth/v1/device_authorization',
    '/callback/ws/endpoint',
  ])
    assert.deepEqual(routeCliRequest('POST', path), { kind: 'reject', reason: 'auth' }, path)
  assert.deepEqual(routeCliRequest('TRACE', '/open-apis/im/v1/chats'), {
    kind: 'reject',
    reason: 'method',
  })
  assert.deepEqual(routeCliRequest('GET', '/other/v1/x'), { kind: 'reject', reason: 'path' })
  // 读用户信息不是令牌接口：CLI 启动时会探一次，放行与否由身份决定
  assert.equal(routeCliRequest('GET', '/open-apis/authen/v1/user_info').kind, 'pass')
})

test('发言类：发、回复、编辑、更新、转发、加急、群公告认出目标，其余发言接口按最严', () => {
  assert.deepEqual(routeCliRequest('POST', '/open-apis/im/v1/messages'), {
    kind: 'speech',
    speech: { type: 'send' },
  })
  const message = (method: string, path: string) => {
    const route = routeCliRequest(method, path)
    assert.equal(route.kind, 'speech', path)
    return route.kind === 'speech' ? route.speech : null
  }
  assert.deepEqual(message('POST', '/open-apis/im/v1/messages/om_abc/reply'), {
    type: 'message',
    messageId: 'om_abc',
    action: 'reply',
  })
  assert.equal(
    (message('PUT', '/open-apis/im/v1/messages/om_abc') as { action: string }).action,
    'edit',
  )
  assert.equal(
    (message('PATCH', '/open-apis/im/v1/messages/om_abc') as { action: string }).action,
    'update',
  )
  assert.equal(
    (message('PATCH', '/open-apis/im/v1/messages/om_abc/urgent_phone') as { action: string })
      .action,
    'urgent',
  )
  assert.deepEqual(message('PATCH', '/open-apis/im/v1/chats/oc_x/announcement'), {
    type: 'chat',
    chatId: 'oc_x',
    action: 'announcement',
  })
  assert.equal(message('POST', '/open-apis/im/v1/messages/merge_forward')?.type, 'opaque')
  assert.equal(message('POST', '/open-apis/message/v4/batch_send/')?.type, 'opaque')
  assert.equal(message('PUT', '/open-apis/cardkit/v1/cards/7355/elements/e1')?.type, 'opaque')
  // 读和不说话的写操作放行
  for (const [method, path] of [
    ['GET', '/open-apis/im/v1/messages'],
    ['GET', '/open-apis/im/v1/messages/om_abc'],
    ['DELETE', '/open-apis/im/v1/messages/om_abc'],
    ['POST', '/open-apis/im/v1/messages/om_abc/reactions'],
    ['POST', '/open-apis/im/v1/pins'],
    ['POST', '/open-apis/cardkit/v1/cards'],
    ['GET', '/open-apis/docx/v1/chats/oc_x/announcement'],
    ['POST', '/open-apis/docx/v1/documents'],
    ['POST', '/open-apis/calendar/v4/calendars/c1/events'],
  ] as const)
    assert.equal(routeCliRequest(method, path).kind, 'pass', `${method} ${path}`)
})

test('审计路径把 ID 段打码', () => {
  assert.equal(
    auditPath('/open-apis/im/v1/messages/om_x100b7f6d1644bcac/reply'),
    '/open-apis/im/v1/messages/:id/reply',
  )
  assert.equal(auditPath('/open-apis/im/v1/chats'), '/open-apis/im/v1/chats')
})

test('发言名单不分大小写：改了大小写的发言路径照样认成发言，ID 保留原样', () => {
  assert.deepEqual(routeCliRequest('post', '/open-apis/IM/v1/Messages'), {
    kind: 'speech',
    speech: { type: 'send' },
  })
  assert.deepEqual(routeCliRequest('POST', '/open-apis/im/V1/messages/om_AbC123/Reply'), {
    kind: 'speech',
    speech: { type: 'message', messageId: 'om_AbC123', action: 'reply' },
  })
})
