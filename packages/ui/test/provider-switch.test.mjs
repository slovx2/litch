// 会话中途换供应商的提示：型号 ID 前缀变了才算，名字取选单显示名开头的 [名字]。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  providerOf,
  switchedProvider,
  needsProviderConfirmation: needsConfirmation,
} = await import('../src/composer/provider-switch.ts')

const needsProviderConfirmation = (harness, before, after) =>
  needsConfirmation(harness, before, after, { usedTokens: 51, windowTokens: 100 })

test('Claude 跨供应商选择先确认，账号也算供应商；同供应商和其他引擎不确认', () => {
  // 单入口在核心里用 claude，设备聚合面使用引擎标识 claude-code。
  assert.equal(needsProviderConfirmation('claude', 'anthropic/opus', 'konstants/opus'), true)
  assert.equal(needsProviderConfirmation('claude-code', 'anthropic/opus', 'konstants/opus'), true)
  assert.equal(needsProviderConfirmation('claude-code', 'konstants/opus', 'anthropic/opus'), true)
  assert.equal(needsProviderConfirmation('claude-code', 'opus', 'konstants/opus'), true)
  assert.equal(needsProviderConfirmation('claude-code', 'native/opus', 'anthropic/opus'), true)
  assert.equal(
    needsProviderConfirmation('claude-code', 'anthropic/opus', 'anthropic/sonnet'),
    false,
  )
  assert.equal(needsProviderConfirmation('claude-code', 'opus', 'sonnet'), false)
  assert.equal(needsProviderConfirmation('claude-code', null, 'konstants/opus'), false)
  assert.equal(needsProviderConfirmation('codex', 'anthropic/opus', 'konstants/opus'), false)
})

test('换了供应商才提示，名字取选单里的 [名字]', () => {
  const models = [
    { id: 'anthropic/opus', title: '[Account] Opus 5.5' },
    { id: 'deepseek/deepseek-v4', title: '[DeepSeek] DeepSeek V4' },
    { id: 'corp/x', title: 'x' },
  ]
  assert.equal(providerOf('anthropic/opus'), 'anthropic')
  assert.equal(providerOf('opus'), null)
  assert.equal(providerOf(null), null)
  assert.equal(switchedProvider('anthropic/opus', 'deepseek/deepseek-v4', models), 'DeepSeek')
  assert.equal(switchedProvider('anthropic/opus', 'corp/x', models), 'corp')
  assert.equal(switchedProvider('anthropic/opus', 'anthropic/sonnet', models), null)
  // 只有一家时型号不带前缀：不提示
  assert.equal(switchedProvider('opus', 'sonnet', models), null)
  assert.equal(switchedProvider(null, 'deepseek/deepseek-v4', models), null)
})

test('仅超过 50% 才提醒，边界和未知窗口直接切换', () => {
  const ask = (usage) => needsConfirmation('claude-code', 'anthropic/opus', 'gateway/opus', usage)
  for (const usage of [
    null,
    undefined,
    { usedTokens: 50, windowTokens: 100 },
    { usedTokens: 49, windowTokens: 100 },
    { usedTokens: 100, windowTokens: null },
    { usedTokens: 100, windowTokens: 0 },
  ])
    assert.equal(ask(usage), false)
  assert.equal(ask({ usedTokens: 50001, windowTokens: 100000 }), true)
})
