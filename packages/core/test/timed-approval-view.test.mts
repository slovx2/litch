// 卡片能按哪一类限时授权放行（timedCategoryOf）、剩余时长的取整（timedRemaining）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalRequest, ClientAskRequest } from '../src/index.mjs'
import { timedCategoryOf, timedRemaining } from '../src/index.mjs'

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

test('原生审批按主题归类；MCP 工具与没有允许项的不归类', () => {
  assert.equal(timedCategoryOf(approval('command')), 'command')
  assert.equal(timedCategoryOf(approval('fileChange')), 'fileChange')
  assert.equal(timedCategoryOf(approval('permissions')), 'permissions')
  assert.equal(timedCategoryOf(approval('tool')), null)
  assert.equal(timedCategoryOf(approval('command', ['decline', 'cancel'])), null)
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
