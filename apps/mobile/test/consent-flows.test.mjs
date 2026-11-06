import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
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

const negativeFlow = `appId: dev.litch.app
---
- extendedWaitUntil:
    notVisible:
      id: post-question:D-17
      text: Temporary keyboard question
    timeout: 10000
`

test('反向等待处理稍晚出现的同意卡，保留复合选择器与最终断言', () => {
  const steps = parseAllDocuments(withConsentSteps(negativeFlow, 'discussion.yaml'))[1].toJS()
  const state = { output: {}, Date }
  let frames = 0
  let consent = false
  let draft = true
  let allowed = 0
  const visible = (selector) => (selector.id === 'ai-consent:title' ? consent : draft)
  const evaluate = (script) => runInNewContext(script.slice(2, -1), state)
  const run = (commands) => {
    for (const step of commands) {
      if (step.evalScript) evaluate(step.evalScript)
      else if (step.repeat) {
        for (let index = 0; index < step.repeat.times && evaluate(step.repeat.while.true); index++)
          run(step.repeat.commands)
      } else if (step.waitForAnimationToEnd) {
        if (++frames === 2) consent = true
      } else if (step.runFlow) {
        const { when, commands } = step.runFlow
        if (when.visible ? visible(when.visible) : !visible(when.notVisible)) run(commands)
      } else if (step.scrollUntilVisible) assert.equal(consent, true)
      else if (step.tapOn) {
        assert.equal(step.tapOn.id, 'ai-consent:allow')
        assert.equal(consent, true)
        allowed++
        consent = false
        draft = false
      } else if (step.extendedWaitUntil) assert.equal(draft, false)
      else assert.fail(`未处理的步骤 ${JSON.stringify(step)}`)
    }
  }
  run(steps)
  assert.equal(allowed, 1)
  assert.equal(frames, 2)
  const original = parseAllDocuments(negativeFlow)[1].toJS()[0]
  assert.deepEqual(steps.at(-1), original)
  assert.deepEqual(
    steps[1].repeat.commands[2].runFlow.when.notVisible,
    original.extendedWaitUntil.notVisible,
  )
})

test('立即的反向断言和嵌套等待也处理同意，但隐私专项仍不改写', () => {
  const source =
    'appId: dev.litch.app\n---\n- runFlow:\n    commands:\n      - assertNotVisible: old draft\n'
  const steps = parseAllDocuments(withConsentSteps(source, 'nested.yaml'))[1].toJS()
  const nested = steps[0].runFlow.commands
  assert.equal(nested.at(-1).assertNotVisible, 'old draft')
  assert.equal(nested[1].repeat.commands[1].runFlow.commands[1].tapOn.id, 'ai-consent:allow')
  const privacy = negativeFlow.replace('appId:', 'tags: [privacy]\nappId:')
  assert.equal(withConsentSteps(privacy, 'privacy.yaml'), privacy)
})

test('讨论首次发送显式要求同意框，在批准后才断言草稿清空', () => {
  const source = readFileSync(
    new URL('../e2e/flows/mock/25-discussion-keyboard.yaml', import.meta.url),
    'utf8',
  )
  const steps = parseAllDocuments(withConsentSteps(source, '25-discussion-keyboard.yaml'))[1].toJS()
  const send = steps.findIndex((step) => step.tapOn?.id === 'post-question-submit:D-17')
  const title = steps.findIndex(
    (step, index) => index > send && step.extendedWaitUntil?.visible?.id === 'ai-consent:title',
  )
  const allow = steps.findIndex(
    (step, index) => index > title && step.tapOn?.id === 'ai-consent:allow',
  )
  const clear = steps.findIndex(
    (step, index) =>
      index > send && step.extendedWaitUntil?.notVisible?.id === 'post-question:D-17',
  )
  assert.ok(send >= 0 && title > send && allow > title && clear > allow)
  assert.equal(steps.filter((step) => step.tapOn?.id === 'post-question-submit:D-17').length, 1)
})
