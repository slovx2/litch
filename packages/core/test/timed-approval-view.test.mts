// 卡片能按哪一类（哪个范围）限时授权放行（timedTargetOf）、剩余时长的取整（timedRemaining）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalRequest, ClientAskRequest, FormRequest } from '../src/index.mjs'
import { timedRemaining, timedTargetOf } from '../src/index.mjs'

/** 只看类别（不分范围的类别） */
const timedCategoryOf = (request: Parameters<typeof timedTargetOf>[0]) =>
  timedTargetOf(request)?.category ?? null

const approval = (
  subject: ApprovalRequest['subject'],
  roles: ApprovalRequest['options'][number]['role'][] = ['accept', 'decline'],
): ApprovalRequest => ({
  id: 'r',
  kind: 'approval',
  subject,
  itemId: null,
  command: null,
  cwd: null,
  reason: null,
  permissions: null,
  tool: null,
  options: roles.map((role) => ({ id: role, role })),
})

const ask = (value: ClientAskRequest['ask']): ClientAskRequest => ({
  id: 'a',
  kind: 'clientAsk',
  itemId: null,
  device: { name: 'x', kind: 'ssh', host: 'h' },
  tool: { namespace: 'litch_browser', name: 'navigate' },
  ask: value,
  options: [
    { id: 'once', role: 'accept' },
    { id: 'decline', role: 'decline' },
  ],
})

const machine = (more: Partial<Extract<ClientAskRequest['ask'], { kind: 'machine' }>> = {}) =>
  ask({
    kind: 'machine',
    action: 'exec',
    command: 'make',
    cwd: null,
    path: null,
    copy: null,
    flagged: [],
    ...more,
  } as ClientAskRequest['ask'])

test('原生审批按主题归类，不分范围；没有允许项的不归类', () => {
  assert.deepEqual(timedTargetOf(approval('command')), { category: 'command', scope: '' })
  assert.equal(timedCategoryOf(approval('fileChange')), 'fileChange')
  assert.equal(timedCategoryOf(approval('permissions')), 'permissions')
  assert.equal(timedCategoryOf(approval('command', ['decline', 'cancel'])), null)
})

const form = (more: Partial<FormRequest> = {}): FormRequest => ({
  id: 'f',
  kind: 'form',
  itemId: null,
  server: 'docs',
  message: '继续吗？',
  fields: [],
  link: null,
  ...more,
})

test('MCP：工具审批与一栏都没有的表按服务名归类；要填内容、去网页办事的不归类', () => {
  const tool = { server: 'docs', title: null, note: null, params: null }
  assert.deepEqual(timedTargetOf({ ...approval('tool'), tool }), { category: 'mcp', scope: 'docs' })
  assert.equal(timedTargetOf(approval('tool')), null, '不知道是哪个服务的不归类')
  assert.equal(timedTargetOf({ ...approval('tool', ['decline']), tool }), null)
  assert.deepEqual(timedTargetOf(form()), { category: 'mcp', scope: 'docs' })
  const field = {
    id: 'name',
    kind: 'text',
    label: 'name',
    note: '',
    required: true,
    format: null,
    options: [],
    initial: null,
    limits: { min: null, max: null, minLength: null, maxLength: null },
  } as FormRequest['fields'][number]
  assert.equal(timedTargetOf(form({ fields: [field] })), null)
  assert.equal(timedTargetOf(form({ link: { url: 'https://example.com', openable: true } })), null)
})

test('客户端工具：网站与下载归浏览器、Chrome 单独一类；Litch 自身、登录、开启确认、禁止位置不归类', () => {
  assert.equal(timedCategoryOf(ask({ kind: 'site', origin: 'o', url: 'u' })), 'browser')
  assert.equal(
    timedCategoryOf(ask({ kind: 'browserDownload', filename: 'f', origin: 'o', totalBytes: 1 })),
    'browser',
  )
  assert.equal(
    timedCategoryOf(ask({ kind: 'site', origin: 'o', url: 'u', browser: 'chrome' })),
    'chrome',
  )
  assert.equal(timedCategoryOf(ask({ kind: 'chromeTab', url: 'u', title: 't' })), 'chrome')
  assert.equal(
    timedCategoryOf(ask({ kind: 'computerSelf', id: 'i', nonce: 'n', desktopId: null })),
    null,
  )
  assert.equal(timedCategoryOf(ask({ kind: 'chromeSignIn', origin: 'o', reason: '' })), null)
  assert.equal(timedCategoryOf(machine()), 'machine')
  assert.equal(timedCategoryOf(machine({ flagged: ['~/.ssh'] })), null)
  assert.equal(timedCategoryOf(machine({ enable: { sessionId: 'a' } })), null)
  assert.equal(timedCategoryOf({ id: 'q', kind: 'question', itemId: null, questions: [] }), null)
})

test('剩余时长按整分钟四舍五入', () => {
  assert.deepEqual(timedRemaining(1000 + 3_600_000 + 61_000, 1000), { hours: 1, minutes: 1 })
  assert.deepEqual(timedRemaining(4 * 3_600_000 - 5, 0), { hours: 4, minutes: 0 })
  assert.deepEqual(timedRemaining(1000, 2000), { hours: 0, minutes: 0 })
})

test('核心的名单：MCP 授予带上服务名，判定按服务分；别的类别不带范围', async () => {
  const { createTimedApprovals } = await import('../src/device/timed-approvals.mjs')
  const sent: unknown[] = []
  const store = createTimedApprovals({
    deviceId: 'd',
    online: () => true,
    supported: () => true,
    now: () => 0,
    request: (async (_method: string, params: Record<string, unknown>) => {
      sent.push(params)
      return {
        id: `g${sent.length}`,
        threadId: params.threadId,
        category: params.category,
        scope: params.scope ?? '',
        grantedAt: 0,
        expiresAt: 3_600_000,
      }
    }) as never,
  })
  await store.grant('t', 'mcp', 1, 'docs')
  await store.grant('t', 'command', 1)
  assert.deepEqual(sent, [
    { threadId: 't', category: 'mcp', hours: 1, scope: 'docs' },
    { threadId: 't', category: 'command', hours: 1 },
  ])
  assert.ok(store.active('t', 'mcp', 'docs'))
  assert.equal(store.active('t', 'mcp', 'mail'), null)
  assert.equal(store.active('t', 'mcp'), null)
  assert.ok(store.active('t', 'command'))
  // 同会话另一个服务的授予不顶掉已有的那条
  await store.grant('t', 'mcp', 1, 'mail')
  assert.ok(store.active('t', 'mcp', 'docs'))
  assert.ok(store.active('t', 'mcp', 'mail'))
})
