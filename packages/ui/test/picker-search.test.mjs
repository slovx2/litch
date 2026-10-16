// 选择器顶上的筛选框：留下哪些选项。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { matchOptions, SEARCH_FROM } = await import('../src/composer/picker-search.ts')

const option = (id, title, note) => ({ id, title, ...(note ? { note } : {}) })
const MODELS = [
  option('claude-opus-5-5', 'Opus 5.5', '最强'),
  option('claude-sonnet-5-5', 'Sonnet 5.5'),
  option('deepseek/deepseek-v4', 'DeepSeek V4', 'OpenRouter'),
  option('gpt-5.6-sol', 'GPT-5.6 Sol'),
]
const ids = (list) => list.map((entry) => entry.id)

test('筛选框：什么都没写全留；不分大小写，标题、标识、说明里有就算', () => {
  assert.ok(SEARCH_FROM > 1)
  assert.deepEqual(ids(matchOptions(MODELS, '')), ids(MODELS))
  assert.deepEqual(ids(matchOptions(MODELS, '   ')), ids(MODELS))
  assert.deepEqual(ids(matchOptions(MODELS, 'SONNET')), ['claude-sonnet-5-5'])
  // 只在标识里
  assert.deepEqual(ids(matchOptions(MODELS, 'claude')), ['claude-opus-5-5', 'claude-sonnet-5-5'])
  // 只在说明里
  assert.deepEqual(ids(matchOptions(MODELS, 'openrouter')), ['deepseek/deepseek-v4'])
  assert.deepEqual(ids(matchOptions(MODELS, '最强')), ['claude-opus-5-5'])
  assert.deepEqual(ids(matchOptions(MODELS, 'gemini')), [])
})

test('筛选框：按空白拆成几段，每段都要对得上，先后不变；“添加…”那种一直留着', () => {
  assert.deepEqual(ids(matchOptions(MODELS, '5.5 claude')), [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ])
  assert.deepEqual(ids(matchOptions(MODELS, 'opus sonnet')), [])
  const withAction = [...MODELS, { id: ':add', title: '添加…', action: true }]
  assert.deepEqual(ids(matchOptions(withAction, 'gpt')), ['gpt-5.6-sol', ':add'])
})
