import assert from 'node:assert/strict'
import test from 'node:test'
import {
  managerLineRules,
  managerRoleRules,
  managerSessionRules,
} from '../src/client-tools-manager.mjs'
import { sessionProposalRules, sessionTools } from '../src/client-tools-sessions.mjs'
import { MANAGER_DEFAULT_DISPATCH } from '../src/manager.mjs'
import {
  CODEX_WAIT_RULE,
  NATIVE_BACKGROUND_RULES,
  NATIVE_BACKGROUND_TOOLS,
  supportsNativeBackground,
} from '../src/native-background-wake.mjs'

test('所有角色和任务卡/收尾开关组合，都要求先确认登记；无工具不得承诺自动唤醒', () => {
  // 设备恢复时用角色前缀定位并更新规则，新增提示不能遮掉它。
  assert.ok(managerSessionRules(4).startsWith('Manager sessions'))
  assert.ok(managerLineRules('manager', MANAGER_DEFAULT_DISPATCH).startsWith('You are a line'))
  const rules = [managerRoleRules('scope-token'), NATIVE_BACKGROUND_RULES]
  for (const cards of [false, true]) {
    rules.push(
      managerSessionRules(4, cards),
      managerLineRules('manager', MANAGER_DEFAULT_DISPATCH, cards),
    )
    for (const wrap of [false, true]) rules.push(sessionProposalRules(wrap, cards))
  }
  for (const text of rules) assert.ok(text.includes(CODEX_WAIT_RULE), text.slice(0, 80))
  assert.match(CODEX_WAIT_RULE, /only after litch_background.watch confirms registration/)
  assert.match(CODEX_WAIT_RULE, /Without litch_background, never promise a wake/)
  assert.match(CODEX_WAIT_RULE, /finish within the turn.*manager\/user.*check the result/)
  assert.ok(managerRoleRules('scope-token').length < 4000)
  const sessions = sessionTools(true)
  assert.ok(
    sessions.tools.find((tool) => tool.name === 'wrap_up')?.description.includes(CODEX_WAIT_RULE),
  )
  for (const spec of [sessions, NATIVE_BACKGROUND_TOOLS])
    assert.ok([...spec.description].length <= 1024)
})

test('最低版本仍为 0.163，不为旧会话开启兼容接续', () => {
  assert.equal(supportsNativeBackground('0.160.0'), false)
  assert.equal(supportsNativeBackground('0.162.0'), false)
  assert.equal(supportsNativeBackground('0.163.0'), true)
})
