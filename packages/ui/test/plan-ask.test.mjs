// “计划写好了，要不要执行”这一问什么时候出。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { markPlanAsked, planAskedIn, planToConfirm, settledPlan, settlePlan } = await import(
  '../src/composer/plan-ask.ts'
)

const kinds = { u: 'userMessage', p1: 'plan', p2: 'plan', a: 'agentMessage' }
const facts = (extra = {}) => ({
  mode: 'plan',
  live: true,
  turn: { id: 't1', status: 'completed', itemIds: ['u', 'p1', 'a'] },
  kindOf: (id) => kinds[id],
  asked: false,
  settled: undefined,
  ...extra,
})

test('要问的情形：计划模式里，最后一个回合正常结束，里面出过计划', () => {
  assert.equal(planToConfirm(facts()), 'p1')
  // 一个回合里改过几稿：问的是最后那一份
  const twice = { id: 't1', status: 'completed', itemIds: ['u', 'p1', 'a', 'p2'] }
  assert.equal(planToConfirm(facts({ turn: twice })), 'p2')
})

test('不问的情形：不在计划模式、回合没正常结束、没出计划、只读的会话', () => {
  assert.equal(planToConfirm(facts({ mode: 'default' })), null)
  assert.equal(planToConfirm(facts({ mode: null })), null)
  for (const status of ['running', 'interrupted', 'failed']) {
    assert.equal(planToConfirm(facts({ turn: { id: 't1', status, itemIds: ['u', 'p1'] } })), null)
  }
  const plain = { id: 't1', status: 'completed', itemIds: ['u', 'a'] }
  assert.equal(planToConfirm(facts({ turn: plain })), null)
  assert.equal(planToConfirm(facts({ turn: undefined })), null)
  assert.equal(planToConfirm(facts({ live: false })), null)
})

test('引擎自己问过的不再问；人表过态的那一份不再问，出了新的一份照样问', () => {
  assert.equal(planToConfirm(facts({ asked: true })), null)
  assert.equal(planToConfirm(facts({ settled: 'p1' })), null)
  const next = { id: 't2', status: 'completed', itemIds: ['u', 'p2'] }
  assert.equal(planToConfirm(facts({ settled: 'p1', turn: next })), 'p2')
})

test('问过、表过态记在这次运行里：各会话各记各的', () => {
  markPlanAsked('local:a', 't1')
  settlePlan('local:a', 'p1')
  assert.equal(planAskedIn('local:a'), 't1')
  assert.equal(settledPlan('local:a'), 'p1')
  assert.equal(planAskedIn('local:b'), undefined)
  assert.equal(settledPlan('local:b'), undefined)
})
