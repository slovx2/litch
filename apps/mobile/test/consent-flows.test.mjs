import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAllDocuments } from 'yaml'
import { withConsentSteps } from '../scripts/consent-flows.mjs'

test('普通 Maestro 等待先允许真实同意卡，原产品断言仍保留', () => {
  const input =
    'appId: dev.litch.app\n---\n- extendedWaitUntil:\n    visible:\n      id: detail\n    timeout: 20000\n'
  const output = withConsentSteps(input, 'chat.yaml')
  const steps = parseAllDocuments(output)[1].toJS()
  assert.equal(steps.length, 3)
  assert.equal(steps[1].runFlow.commands[1].tapOn.id, 'ai-consent:allow')
  assert.deepEqual(steps[2], parseAllDocuments(input)[1].toJS()[0])
  assert.doesNotMatch(output, /optional: true|retry|consent-seed/)
})

test('隐私专项不得自动同意；辅助脚本不改写', () => {
  const input =
    'appId: dev.litch.app\ntags: [privacy]\n---\n- assertVisible:\n    id: ai-consent:title\n'
  assert.equal(withConsentSteps(input, 'privacy.yaml'), input)
  assert.equal(withConsentSteps('const value = 1', 'helper.js'), 'const value = 1')
})
