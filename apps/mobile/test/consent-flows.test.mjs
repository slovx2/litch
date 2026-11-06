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
  assert.equal(steps.length, 4)
  assert.equal(steps[3].runFlow.commands[0].runFlow.commands[1].tapOn.id, 'ai-consent:allow')
  assert.deepEqual(steps[3].runFlow.commands[1], parseAllDocuments(input)[1].toJS()[0])
  assert.doesNotMatch(output, /optional: true|retry|consent-seed/)
})

test('成功提示确认后即使消失也不重等；同意分支仍验证完整选择器', () => {
  const input = `appId: dev.litch.app
---
- extendedWaitUntil:
    visible:
      id: hc:config:said
      text: Saved
    timeout: 10000
`
  const steps = parseAllDocuments(withConsentSteps(input, 'settings.yaml'))[1].toJS()
  for (const scenario of ['transient', 'consent', 'wrong-text']) {
    const state = { output: {} }
    let target = scenario === 'transient'
    let consent = !target
    let allows = 0
    let checks = 0
    const evaluate = (script) => runInNewContext(script.slice(2, -1), state)
    const visible = (selector) => {
      if (selector.id === 'ai-consent:title') return consent
      assert.deepEqual(selector, { id: 'hc:config:said', text: 'Saved' })
      return target && scenario !== 'wrong-text'
    }
    const run = (commands) => {
      for (const step of commands) {
        if (step.evalScript) {
          evaluate(step.evalScript)
          // 首次完整观察成功后让提示消失，模拟 CI 的五秒提示与慢查询。
          if (state.output.litchConsentTargetSeen) target = false
        } else if (step.runFlow) {
          const { when, commands } = step.runFlow
          if (when.true ? evaluate(when.true) : visible(when.visible)) run(commands)
        } else if (step.extendedWaitUntil) {
          const selector = step.extendedWaitUntil.visible
          if (selector.id.includes('(?:')) assert.ok(target || consent)
          else {
            checks++
            assert.ok(visible(selector), '完整目标必须出现')
          }
        } else if (step.scrollUntilVisible) assert.ok(consent)
        else if (step.tapOn) {
          assert.equal(step.tapOn.id, 'ai-consent:allow')
          allows++
          consent = false
          target = true
        } else assert.fail(JSON.stringify(step))
      }
    }
    if (scenario === 'wrong-text') assert.throws(() => run(steps), /完整目标必须出现/)
    else run(steps)
    assert.equal(allows, scenario === 'transient' ? 0 : 1)
    assert.equal(checks, scenario === 'transient' ? 0 : 1)
  }
})

test('提案首次 Pi 同意在滚动到子会话之前，隐私步骤不被自动批准', () => {
  for (const flow of ['08-proposals', '12-offer-held']) {
    const source = readFileSync(new URL(`../e2e/flows/mock/${flow}.yaml`, import.meta.url), 'utf8')
    const steps = parseAllDocuments(withConsentSteps(source, `${flow}.yaml`))[1].toJS()
    const consent = steps.findIndex((step) => step.runFlow === '../_shared/allow-pi-consent.yaml')
    const child = steps.findIndex((step) =>
      step.scrollUntilVisible?.element?.id?.endsWith(':child'),
    )
    assert.ok(consent > 0 && child > consent)
  }
  const source = readFileSync(
    new URL('../e2e/flows/_shared/allow-pi-consent.yaml', import.meta.url),
    'utf8',
  )
  assert.equal(withConsentSteps(source, 'allow-pi-consent.yaml'), source)
  const steps = parseAllDocuments(source)[1].toJS()
  assert.equal(steps.filter((step) => step.tapOn?.id === 'ai-consent:allow').length, 1)
  assert.ok(
    steps.findIndex((step) => step.assertNotVisible?.id === 'proposal:.*:child') <
      steps.findIndex((step) => step.tapOn?.id === 'ai-consent:allow'),
  )
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

test('共享正反向选择器不产生 Maestro 会误读为文字的 YAML 别名', () => {
  for (const source of [negativeFlow, negativeFlow.replace('notVisible:', 'visible:')]) {
    const converted = withConsentSteps(source, 'selectors.yaml')
    assert.doesNotMatch(converted, /(?:^|:\s*)[&*]a\d+\b/m)
    assert.ok((converted.match(/id: post-question:D-17/g) ?? []).length >= 2)
  }
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

test('收键盘辅助流程只在键盘存在时返回一次，不自动批准数据许可', () => {
  const source = readFileSync(
    new URL('../e2e/flows/_shared/dismiss-keyboard.yaml', import.meta.url),
    'utf8',
  )
  assert.equal(withConsentSteps(source, 'dismiss-keyboard.yaml'), source)
  const steps = parseAllDocuments(source)[1].toJS()
  const android = steps.find((step) => step.runFlow.when.platform === 'Android').runFlow.commands[0]
    .runFlow
  assert.match(android.when.visible.id, /keyboard_holder$/)
  assert.deepEqual(android.commands[0], { pressKey: 'BACK' })
  assert.equal(android.commands[1].extendedWaitUntil.notVisible.id, android.when.visible.id)
  assert.doesNotMatch(source, /^\s*- hideKeyboard/m)
  const ios = steps.find((step) => step.runFlow.when.platform === 'iOS').runFlow
  assert.equal(ios.when.visible.id, 'keyboard:done')
})

test('发送流程在收键盘前等待草稿清空，首次数据许可仍由转换器正常处理', () => {
  for (const flow of ['13-send-mode', '11-goal', '28-manager-chat-scroll', '33-mention-chip']) {
    const source = readFileSync(new URL(`../e2e/flows/mock/${flow}.yaml`, import.meta.url), 'utf8')
    const steps = parseAllDocuments(source)[1].toJS()
    const send = steps.findIndex((step) => step.tapOn?.id === 'composer-send')
    const clear = steps[send + 1].extendedWaitUntil
    assert.equal(clear.notVisible.id, 'composer-input')
    assert.ok(clear.notVisible.text)
    assert.ok(String(steps[send + 2].runFlow).endsWith('dismiss-keyboard.yaml'))
    const converted = withConsentSteps(source, `${flow}.yaml`)
    assert.match(converted, /id: ai-consent:allow/)
  }
})

test('Tailscale 每次连接都先明确确认服务说明，普通 AI 同意转换不能跳过它', () => {
  const source = readFileSync(
    new URL('../e2e/flows/fixture/26-tailscale.yaml', import.meta.url),
    'utf8',
  )
  const steps = parseAllDocuments(source)[1].toJS()
  const logins = steps.flatMap((step, i) => (step.tapOn?.id === 'tailscale:login' ? [i] : []))
  assert.equal(logins.length, 2)
  for (const i of logins)
    assert.equal(steps[i + 1].runFlow, '../_shared/allow-tailscale-consent.yaml')
  const allow = readFileSync(
    new URL('../e2e/flows/_shared/allow-tailscale-consent.yaml', import.meta.url),
    'utf8',
  )
  assert.equal(withConsentSteps(allow, 'allow-tailscale-consent.yaml'), allow)
  assert.equal(parseAllDocuments(allow)[1].toJS().at(-1).tapOn.id, 'tailscale:consent-allow')
})
