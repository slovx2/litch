// 会话中途换供应商的提示：型号 ID 前缀变了才算，名字取选单显示名开头的 [名字]。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { providerOf, switchedProvider } = await import('../src/composer/provider-switch.ts')

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
