// 配置助手往输入框里放的那一句、和原来草稿的拼法；首启引导出不出、出哪一步。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { assistPrefill, manualSkillIn, MANUAL_SKILL } = await import('../src/assist/prefill.ts')
const { leadDraft } = await import('../src/composer/drafts.ts')
const { onboardingStep } = await import('../src/onboarding/state.ts')

test('有手册的技能：带技能片，正文是那一句（中英各一）', () => {
  const skill = { name: 'litch-manual', path: '/home/me/.agents/skills/litch-manual/SKILL.md' }
  assert.deepEqual(assistPrefill('zh-CN', skill, null), {
    lead: '使用 Litch 产品手册帮我配置：',
    extras: [{ kind: 'skill', name: 'litch-manual', path: skill.path }],
  })
  assert.equal(assistPrefill('en', skill, '/x').lead, 'Use the Litch manual to help me configure: ')
})

test('没有手册的技能：正文写上手册的位置；位置也不知道就只说那一句', () => {
  assert.deepEqual(assistPrefill('zh-CN', null, '/home/me/.agents/skills/litch-manual/'), {
    lead: '使用 Litch 产品手册（/home/me/.agents/skills/litch-manual/SKILL.md）帮我配置：',
    extras: [],
  })
  assert.equal(
    assistPrefill('en', null, 'C:\\Users\\me\\.agents\\skills\\litch-manual').lead,
    'Use the Litch manual (C:\\Users\\me\\.agents\\skills\\litch-manual/SKILL.md) to help me configure: ',
  )
  assert.deepEqual(assistPrefill('zh-CN', null, null), {
    lead: '使用 Litch 产品手册帮我配置：',
    extras: [],
  })
})

test('技能单子里认出手册', () => {
  const skills = [
    { name: 'pdf', title: 'pdf', note: '', path: '/a', scope: 'system' },
    { name: MANUAL_SKILL, title: MANUAL_SKILL, note: '', path: '/b', scope: 'user' },
  ]
  assert.equal(manualSkillIn(skills)?.path, '/b')
  assert.equal(manualSkillIn(skills.slice(0, 1)), null)
})

test('原来的草稿不丢：那一句在前、原来的字接在后面；再点一次不重复', () => {
  const lead = '使用 Litch 产品手册帮我配置：'
  assert.equal(leadDraft(lead, ''), lead)
  assert.equal(leadDraft(lead, '  加一台远程设备'), `${lead}加一台远程设备`)
  assert.equal(leadDraft(lead, `${lead}加一台远程设备`), `${lead}加一台远程设备`)
})

test('首启引导：没走过、本机连上且清单到了才出；没有可用的是第一步，有了是第二步；重新打开不管走没走过', () => {
  const fresh = { done: false, reopened: false }
  const local = (ready, extra = {}) => ({ online: true, listed: true, ready, ...extra })
  assert.equal(onboardingStep(fresh, null), null)
  assert.equal(onboardingStep(fresh, local(0, { online: false })), null)
  assert.equal(onboardingStep(fresh, local(0, { listed: false })), null)
  assert.equal(onboardingStep(fresh, local(0)), 'install')
  assert.equal(onboardingStep(fresh, local(1)), 'assist')
  assert.equal(onboardingStep({ done: true, reopened: false }, local(0)), null)
  assert.equal(onboardingStep({ done: true, reopened: true }, local(2)), 'assist')
})
