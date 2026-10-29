// 回合最下方收尾区里的那个问题：取哪一个、还能不能答、用户回的是哪个按钮。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { suggestTitles, stepsSummary } = await import('../src/transcript/steps-text.ts')
const { translator } = await import('../src/i18n/index.ts')

const zh = translator('zh-CN')

const wrap = (id, wrapUp) => ({
  id,
  kind: 'toolCall',
  source: 'litch_sessions',
  tool: 'wrap_up',
  input: [],
  output: [],
  error: null,
  durationMs: null,
  status: 'completed',
  wrapUp,
})
const suggestion = (title) => ({
  title,
  prompt: 'p',
  background: '',
  harness: null,
  model: null,
  effort: null,
  cwd: null,
  kind: 'fresh',
  proposalId: 'pr',
  refused: null,
})

test('过程里收尾那一行：写建议的标题；只留了问题的写问题；汇总写建议了几个任务', () => {
  const both = wrap('w', { suggestions: [suggestion('补测试'), suggestion('对文案')] })
  assert.equal(suggestTitles(both), '补测试 · 对文案')
  assert.equal(suggestTitles(wrap('w', { suggestions: [], ask: '接着修吗？' })), '接着修吗？')
  const tally = {
    counts: [
      { kind: 'command', n: 1 },
      { kind: 'suggest', n: 2 },
    ],
    thoughts: 0,
    steps: 1,
    failed: 0,
    declined: 0,
    added: 0,
    removed: 0,
    durationMs: null,
    notice: null,
  }
  assert.equal(stepsSummary(tally, zh), '运行 1 条命令，建议 2 个任务')
})
