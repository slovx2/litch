// 选择器顶上的筛选框：留下哪些选项。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { matchOptions, matchProjects, SEARCH_FROM } = await import(
  '../src/composer/picker-search.ts'
)

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

test('项目搜索：名称优先，多根路径、大小写和混合词匹配，同类保持原顺序', () => {
  const projects = [
    { id: 'path', title: 'Orion', note: '/srv/nebula/tools' },
    { id: 'mixed', title: 'Nebula Lab', note: '/srv/shared/tools' },
    { id: 'name', title: 'Nebula Tools', note: '/srv/kit' },
    { id: 'other-name', title: 'Nebula Tools Demo', note: '/srv/demo' },
    { id: 'second-root', title: 'Atlas', searchText: '/srv/atlas\nD:\\Nebula\\Tools' },
    { id: 'nebula-tools-id-only', title: 'Lyra', note: '/srv/lyra' },
    { id: ':add', title: '添加项目', action: true },
  ]
  const before = structuredClone(projects)
  assert.deepEqual(ids(matchProjects(projects, 'NEBULA tools')), [
    'name',
    'other-name',
    'mixed',
    'path',
    'second-root',
    ':add',
  ])
  assert.deepEqual(ids(matchProjects(projects, '  ')), ids(projects))
  assert.deepEqual(ids(matchProjects(projects, 'D:\\nebula')), ['second-root', ':add'])
  assert.deepEqual(ids(matchProjects(projects, 'not-found')), [':add'])
  assert.deepEqual(projects, before, '过滤不改原始选项或选中项目的数据')
})

test('项目搜索：大量远程项目在本地线性过滤，保留名称命中和路径命中', (context) => {
  const projects = Array.from({ length: 20_000 }, (_, index) => ({
    id: `project-${index}`,
    title: `Orion ${index}`,
    searchText: `/srv/work/nebula-${index}`,
  }))
  projects.push({ id: 'named', title: 'Nebula 19999', searchText: '/srv/kit' })
  const start = performance.now()
  const shown = matchProjects(projects, 'NEBULA 19999')
  context.diagnostic(`20,001 个项目过滤耗时 ${(performance.now() - start).toFixed(2)}ms`)
  assert.deepEqual(ids(shown), ['named', 'project-19999'])
})
