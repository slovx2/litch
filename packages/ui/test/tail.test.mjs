// 回合最下方收尾区里的那个问题：取哪一个、还能不能答、用户回的是哪个按钮。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { actionText, askOpen, askReplied, tailAsk } = await import('../src/tree/tail.ts')
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

test('收尾区的问题取回合里最后一个带问题的收尾；没有问题是 null', () => {
  const first = wrap('w1', { suggestions: [], ask: '先问的', actions: [{ label: '好' }] })
  const last = wrap('w2', {
    suggestions: [suggestion('补测试')],
    ask: '接着修吗？',
    actions: [{ label: '修吧', message: '好，在这里修' }, { label: '先不' }],
  })
  assert.deepEqual(tailAsk([first, undefined, last]), {
    itemId: 'w2',
    ask: '接着修吗？',
    actions: [{ label: '修吧', message: '好，在这里修' }, { label: '先不' }],
  })
  assert.equal(tailAsk([wrap('w3', { suggestions: [suggestion('x')] })]), null)
  // 没带按钮的问题：只有问题，用户在输入框里答
  assert.deepEqual(tailAsk([wrap('w4', { suggestions: [], ask: '要哪种？' })])?.actions, [])
})

test('按钮发的话：有 message 发它，没有发按钮上的字；认回的是哪个按钮', () => {
  const actions = [{ label: '修吧', message: '好，在这里修' }, { label: '先不' }]
  assert.equal(actionText(actions[0]), '好，在这里修')
  assert.equal(actionText(actions[1]), '先不')
  assert.equal(askReplied(actions, ' 好，在这里修 '), '修吧')
  assert.equal(askReplied(actions, '先不'), '先不')
  assert.equal(askReplied(actions, '换个做法'), null)
  assert.equal(askReplied(actions, null), null)
})

test('问题在下一条用户消息之后失效：回合不是最后一个、或者回合里它后面有用户插话', () => {
  const kinds = { u: 'userMessage', w: 'toolCall', a: 'agentMessage', s: 'userMessage' }
  const kindOf = (id) => kinds[id]
  assert.equal(askOpen(['u', 'w', 'a'], 'w', true, kindOf), true)
  assert.equal(askOpen(['u', 'w', 'a'], 'w', false, kindOf), false)
  assert.equal(askOpen(['u', 'w', 'a', 's'], 'w', true, kindOf), false)
  // 问题前面的用户消息不算
  assert.equal(askOpen(['u', 's', 'w'], 'w', true, kindOf), true)
  assert.equal(askOpen(['u'], 'w', true, kindOf), false)
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
