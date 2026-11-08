import assert from 'node:assert/strict'
import test from 'node:test'
import { browserToolsSpec } from '../src/litch/client-tools-browser.mjs'
import { computerToolsSpec } from '../src/litch/client-tools-computer.mjs'
import { observationSlice } from '../src/observation.mjs'
import { automationRecovery } from '../src/recovery.mjs'

test('错误恢复按用户闸门、租约、文档和输入回执分流', () => {
  for (const code of ['signingIn', 'userStopped', 'originNotApproved', 'permission', 'declined']) {
    const result = automationRecovery(code)
    assert.equal(result.status, 'waiting_for_user')
    assert.equal(result.retryable, false)
    assert.equal(result.needs_approval, true)
    assert.equal(result.next_action, 'wait_for_user')
  }
  assert.equal(automationRecovery('staleLease').needs_claim, true)
  assert.equal(automationRecovery('staleRef').needs_snapshot, true)
  assert.equal(automationRecovery('failed', 'unknown ref e1').needs_snapshot, true)
  assert.equal(automationRecovery('notDispatched').may_have_executed, false)
  assert.equal(automationRecovery('notDispatched', '', true).may_have_executed, true)
  assert.equal(automationRecovery('failed').retryable, false)
  assert.equal(automationRecovery('failed').may_have_executed, true)
  assert.equal(automationRecovery('invalid', 'user declined the site').next_action, 'wait_for_user')
})

test('40K 状态夹具紧凑分页明显缩小且逐页无遗漏', () => {
  const lines = Array.from(
    { length: 600 },
    (_, i) =>
      `[${i + 1}] button "Fixture row ${String(i).padStart(3, '0')} — Settings and permissions in the workspace"`,
  )
  const before = lines.join('\n').length
  const compact = observationSlice(lines)
  assert.ok(compact.text.length < before / 3)
  assert.equal(compact.truncated, true)
  const all: string[] = []
  let offset = 0
  for (;;) {
    const page = observationSlice(lines, { offset })
    all.push(...page.text.split('\n'))
    if (!page.truncated) break
    assert.ok(page.next_offset! > offset)
    offset = page.next_offset!
  }
  assert.deepEqual(all, lines)
  assert.equal(observationSlice(lines, { full: true }).text, lines.join('\n'))
  console.log(
    JSON.stringify({
      fixture: 'large-state',
      before,
      after: compact.text.length,
      reduction: 1 - compact.text.length / before,
      pages: Math.ceil(lines.length / compact.next_offset!),
    }),
  )
})

test('工具引导连续动作并要求显式业务确认，新增字段保持可选', () => {
  const browser = browserToolsSpec(true)
  assert.match(browser.instructions!, /End.*wait.*business result/)
  assert.match(browser.tools.find((t) => t.name === 'run_actions')!.description, /last step.*wait/)
  assert.ok(browser.tools.some((t) => t.name === 'ensure_claimed'))
  const snapshot = browser.tools.find((t) => t.name === 'snapshot')!.inputSchema
  assert.ok((snapshot.properties as Record<string, unknown>)?.detail)
  assert.ok((snapshot.properties as Record<string, unknown>)?.offset)
  assert.ok(!(snapshot.required as string[] | undefined)?.includes('detail'))
  const cu = computerToolsSpec('darwin', true).tools.find((t) => t.name === 'get_app_state')!
  assert.match(cu.description, /expected business result/)
  assert.ok((cu.inputSchema.properties as Record<string, unknown>)?.detail)
})
