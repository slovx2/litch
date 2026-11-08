import assert from 'node:assert/strict'
import test from 'node:test'
import { MANAGER_TOOLS, managerLineRules, managerRoleRules } from '../src/client-tools-manager.mjs'
import { MANAGER_DEFAULT_DISPATCH } from '../src/manager.mjs'
import { formatSessionEvent, parseSessionEvent } from '../src/session-tree.mjs'
import { proposalSummary, shortObjectId } from '../src/suggestion-summary.mjs'

test('建议审核事件可往返，不冒充用户指令或普通完成回报', () => {
  const event = {
    kind: 'manager-suggestions' as const,
    notes: [],
    manager: {
      managerId: 'm1',
      text: 'S-12345678 标题\n背景首句。\nSource: "线" (line)\n查重后 endorse 或 dismiss。',
    },
  }
  const text = formatSessionEvent(event)
  assert.match(text, /Worklines proposed/)
  assert.match(text, /not typed by the user/)
  assert.deepEqual(parseSessionEvent(text), { event, rest: '' })
  assert.throws(() =>
    formatSessionEvent({ ...event, manager: { ...event.manager, managerId: '' } }),
  )
})

test('通知摘要与卡片共用首句和短号规则，空背景取任务首句', () => {
  assert.equal(shortObjectId('S-12345678-abcd'), 'S-12345678')
  assert.equal(
    proposalSummary('## 背景\n**修复 v1.2 中的问题。**第二句。', '任务'),
    '修复 v1.2 中的问题。',
  )
  assert.equal(proposalSummary('', 'Fix src/main.ts. More details.'), 'Fix src/main.ts.')
})

test('提卡规则只告知平台自动通知，经理必须查重审核，命名空间说明不超限', () => {
  const manager = managerRoleRules('测试范围')
  assert.match(manager, /landed commits and items for duplicates/)
  assert.match(manager, /Review every workline card notification/)
  const line = managerLineRules('经理', MANAGER_DEFAULT_DISPATCH, true)
  assert.match(line, /Litch notifies the manager/)
  assert.match(line, /do not .*send a separate message/)
  assert.ok(MANAGER_TOOLS.description.length <= 1024)
})
