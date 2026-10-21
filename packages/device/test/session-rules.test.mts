// 建议任务的规则和 litch_sessions 的说明（packages/protocol/src/client-tools-sessions.mts）：照 Claude 桌面端现行提示的
// 结构和条件写，三份（收尾开着、收尾关着、任务卡关着）各自该有、不该有的话；给原生 codex 的几条硬约束。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_TOOL_LIMITS,
  SESSION_TOOLS,
  sessionProposalRules,
  sessionTools,
} from '../../protocol/src/client-tools-sessions.mjs'

const FULL = sessionProposalRules(true)
const UNWRAPPED = sessionProposalRules(false)
const PLAIN = sessionProposalRules(true, false)

const wrapUpTool = (spec = SESSION_TOOLS): any => spec.tools.find((tool) => tool.name === 'wrap_up')

test('RULES-001：收尾开着的那份：什么配单开、第一件任务、接着发现做的留在这里用 ask 问、没做完的还是这个任务、大多数回合没有后续、简报大半在复述就留下', () => {
  for (const phrase of [
    /What a separate session is for: a task of its own/,
    /A piece of the task at hand is never one, however large or parallel/,
    /The first task: until a task has been finished in this session/,
    /stays here while this session has nothing else in flight/,
    /ask about it with wrap_up's ask and a reply button that has you do it here/,
    /A piece you left or could not verify is still this task, not a follow-up/,
    /Most turns leave no card/,
    /also after a turn that only investigated or answered a question/,
    /mostly retells what you found here, it stays here/,
  ])
    assert.match(FULL, phrase)
  // 原来收尾里把“请求隐含的下一步”“没做完、没验到的”当成该出卡的理由，去掉了
  const wrapUp = wrapUpTool()
  for (const text of [FULL, wrapUp.description])
    assert.doesNotMatch(text, /the next step (it|the request) implies|the part that can run while/)
  assert.match(wrapUp.description, /most turns leave none/)
  assert.match(wrapUp.inputSchema.properties.ask.description, /never two joined by "and"/)
  assert.match(wrapUp.inputSchema.properties.actions.description, /realistic alternative/)
})

test('RULES-002：收尾关着的那份不提 wrap_up，要用户定的写在回答最后一行；任务卡关着的那份不提建议、offer、收尾，start 只收 user_asked', () => {
  const unwrapped = sessionTools(false)
  assert.equal(unwrapped.instructions, UNWRAPPED)
  assert.doesNotMatch(`${UNWRAPPED}\n${unwrapped.description}`, /wrap_up/)
  assert.match(UNWRAPPED, /last line of your answer/)
  assert.equal(wrapUpTool(unwrapped), undefined)
  const plain = sessionTools(true, false)
  assert.equal(plain.instructions, PLAIN)
  assert.equal(sessionProposalRules(false, false), PLAIN, '任务卡关着时收尾开关不起作用')
  assert.doesNotMatch(`${PLAIN}\n${plain.description}`, /wrap_up|offer|propose|suggest/i)
  assert.equal(wrapUpTool(plain), undefined)
  const start: any = plain.tools.find((tool) => tool.name === 'start')
  assert.deepEqual(start.inputSchema.properties.initiation.enum, ['user_asked'])
  assert.deepEqual(start.inputSchema.required, ['title', 'initiation'])
  assert.match(PLAIN, /initiation "user_asked"/)
  assert.match(PLAIN, /hand_off/)
})

test('RULES-003：给原生 codex 的约束：命名空间说明不超过 1024 字；头一句（check:native-codex-instructions 认规则的记号）各份不同、只出现一次、不带引号和换行', () => {
  for (const [wrapUp, cards] of [
    [true, true],
    [false, true],
    [true, false],
  ] as const) {
    const spec = sessionTools(wrapUp, cards)
    assert.ok(spec.description.length <= 1024, `说明 ${spec.description.length} 字`)
    const rules = spec.instructions as string
    const head = rules.split('. ')[0] as string
    assert.equal(rules.split(head).length - 1, 1, `${head} 只出现一次`)
    assert.doesNotMatch(head, /["\n\\]/)
    // 起子会话的缺省参数写进说明，和行为对上
    const startTool: any = spec.tools.find((tool) => tool.name === 'start')
    assert.match(startTool.description, /default to this session's current ones/)
    assert.match(startTool.inputSchema.properties.effort.description, /current effort/)
  }
  assert.notEqual(FULL.split('. ')[0], PLAIN.split('. ')[0])
  assert.equal(SESSION_TOOL_LIMITS.proactivePerTurn, 3)
})
