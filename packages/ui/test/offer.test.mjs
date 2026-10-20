// offer 卡（offer.ts）：对话里那次调用对上哪张提案，卡上写什么状态。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { findOffer, offerState } = await import('../src/tree/offer.ts')
const { zhCN } = await import('../src/i18n/zh-CN.ts')
const { en } = await import('../src/i18n/en.ts')

const proposal = (id, extra) => ({
  id,
  title: id,
  prompt: '',
  harness: null,
  model: null,
  cwd: null,
  kind: 'fresh',
  wakeParent: true,
  offer: true,
  status: 'offered',
  createdAt: 1,
  expiresAt: 10_000,
  settledAt: null,
  startedId: null,
  turnId: 't1',
  callId: `call-${id}`,
  widerSandbox: null,
  ...extra,
})

test('对上提案：结果回来了按提案号；调用还在等时按 callId，只认 offer 卡', () => {
  const list = [
    proposal('a', { offer: false, callId: 'call-x' }),
    proposal('b', { callId: 'call-x' }),
    proposal('c'),
  ]
  assert.equal(findOffer(list, 'call-x', null)?.id, 'b')
  assert.equal(findOffer(list, 'call-x', 'c')?.id, 'c')
  assert.equal(findOffer(list, 'call-none', null), undefined)
  assert.equal(findOffer(undefined, 'call-x', null), undefined)
})

test('卡上的状态：有提案照提案；没有的看子会话、调用里的选择、失没失败', () => {
  const base = { status: null, childId: '', choice: null, failed: false }
  assert.equal(offerState({ ...base, status: 'offered' }), 'offered')
  assert.equal(offerState({ ...base, status: 'here', childId: 'c1' }), 'here')
  assert.equal(offerState({ ...base, childId: 'c1', choice: 'session' }), 'started')
  assert.equal(offerState({ ...base, choice: 'session' }), 'chosen')
  assert.equal(offerState({ ...base, choice: 'here' }), 'here')
  assert.equal(offerState({ ...base, failed: true }), 'failed')
  assert.equal(offerState(base), null)
})

test('文案：offer 卡的三种状态、两个按钮、交接的卡，中英文都有', () => {
  const wanted = [
    'proposal.state.offered',
    'proposal.state.chosen',
    'proposal.state.here',
    'proposal.offer.ask',
    'proposal.offer.session',
    'proposal.offer.here',
    'tree.handedOff',
  ]
  for (const key of wanted) {
    assert.ok(zhCN[key], `中文缺 ${key}`)
    assert.ok(en[key], `英文缺 ${key}`)
  }
  assert.equal(zhCN['proposal.offer.session'], '新会话')
  assert.equal(zhCN['proposal.offer.here'], '在这里做')
})
