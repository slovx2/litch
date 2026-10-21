// 持续目标在界面上的几条规矩（goal/logic.ts）：/goal 怎么认、暂停与继续的按钮、换目标前问不问、用量怎么写；
// 还有单子上的 /goal 只在 harness 会持续目标时出。不起浏览器。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  asksBeforeReplace,
  compactTokens,
  goalElapsedMs,
  goalTime,
  parseGoalCommand,
  toggleTarget,
  usageKind,
} = await import('../src/goal/logic.ts')
const { builtinCommands } = await import('../src/composer/commands.ts')

test('GOAL-UI-001 /goal 的认法：打头、后面跟空白或什么都没有；/goals 这类不算', () => {
  assert.deepEqual(parseGoalCommand('/goal 把测试全跑通'), { objective: '把测试全跑通' })
  assert.deepEqual(parseGoalCommand('  /goal\n第一行\n第二行  '), { objective: '第一行\n第二行' })
  assert.deepEqual(parseGoalCommand('/goal'), { objective: '' })
  assert.equal(parseGoalCommand('/goals 啥'), null)
  assert.equal(parseGoalCommand('先 /goal 一下'), null)
  assert.equal(parseGoalCommand('目标是这个'), null)
})

test('GOAL-UI-002 暂停与继续：在做的能暂停，停下的（暂停、受阻、用量到顶）能继续，预算用完和做完的没有按钮', () => {
  assert.equal(toggleTarget('active'), 'paused')
  assert.equal(toggleTarget('paused'), 'active')
  assert.equal(toggleTarget('blocked'), 'active')
  assert.equal(toggleTarget('usageLimited'), 'active')
  assert.equal(toggleTarget('budgetLimited'), null)
  assert.equal(toggleTarget('complete'), null)
})

test('GOAL-UI-003 换目标前问不问：没目标、做完了、话一样的不问', () => {
  assert.equal(asksBeforeReplace(null, '新的'), false)
  assert.equal(asksBeforeReplace({ objective: '旧的', status: 'complete' }, '新的'), false)
  assert.equal(asksBeforeReplace({ objective: '旧的', status: 'paused' }, ' 旧的 '), false)
  assert.equal(asksBeforeReplace({ objective: '旧的', status: 'active' }, '新的'), true)
  assert.equal(asksBeforeReplace({ objective: '旧的', status: 'budgetLimited' }, '新的'), true)
})

test('GOAL-UI-004 用量：设了预算且在做或刚用完预算的写词元，别的写用时；在做的用时接着走', () => {
  assert.equal(usageKind({ status: 'active', tokenBudget: 5000 }), 'tokens')
  assert.equal(usageKind({ status: 'budgetLimited', tokenBudget: 5000 }), 'tokens')
  assert.equal(usageKind({ status: 'paused', tokenBudget: 5000 }), 'time')
  assert.equal(usageKind({ status: 'active', tokenBudget: null }), 'time')
  assert.equal(compactTokens(950), '950')
  assert.equal(compactTokens(12_340), '12.3K')
  assert.equal(compactTokens(120_000), '120K')
  assert.equal(compactTokens(4_500_000), '4.5M')
  const goal = { status: 'active', timeUsedSeconds: 60, updatedAt: 1_000_000 }
  assert.equal(goalElapsedMs(goal, 1_030_000), 90_000)
  assert.equal(goalElapsedMs({ ...goal, status: 'paused' }, 1_030_000), 60_000)
  const say = (key, vars) => `${key}:${JSON.stringify(vars)}`
  assert.equal(goalTime(40_000, say), 'goal.time.s:{"n":40}')
  assert.equal(goalTime(12 * 60_000, say), 'goal.time.m:{"m":12}')
  assert.equal(goalTime(185 * 60_000, say), 'goal.time.h:{"h":3,"m":"05"}')
  assert.equal(goalTime(52 * 3_600_000, say), 'goal.time.d:{"d":2,"h":4}')
})

test('GOAL-UI-005 单子上的 /goal：harness 会持续目标才有，排在 /plan 后面；新建对话页上也有', () => {
  const facts = (more) => ({
    inSession: true,
    canCompact: true,
    plan: true,
    pickers: [],
    alone: true,
    ...more,
  })
  assert.deepEqual(builtinCommands(facts({ goal: true })).slice(0, 4), [
    'new',
    'compact',
    'plan',
    'goal',
  ])
  assert.equal(builtinCommands(facts({ goal: false })).includes('goal'), false)
  assert.equal(builtinCommands(facts({})).includes('goal'), false)
  assert.equal(builtinCommands(facts({ inSession: false, goal: true })).includes('goal'), true)
  assert.equal(builtinCommands(facts({ goal: true, alone: false })).includes('goal'), false)
})
