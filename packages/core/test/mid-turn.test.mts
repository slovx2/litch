// 插话按协议回合内的顺序识别，分段不改变回合边界。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blockInput,
  bucketItems,
  processDuration,
  processSegments,
  processSettled,
  projectTurn,
  turnAddition,
} from '../src/index.mjs'
import { agentText, turn, userText } from './fixtures.mjs'

for (const count of [0, 1, 2]) {
  test(`普通回合 ${count} 次补充：开头不标注，各段计数不串段`, () => {
    const input = [userText('u', '开头'), agentText('n0', '说明', 'commentary')]
    for (let i = 1; i <= count; i++)
      input.push(userText(`u${i}`, '补充'), agentText(`n${i}`, '说明', 'commentary'))
    input.push(agentText('a', '回答', 'final_answer'))
    const view = projectTurn(turn('t', input))
    assert.equal(turnAddition(view.turn, 't:u'), false)
    for (let i = 1; i <= count; i++) assert.equal(turnAddition(view.turn, `t:u${i}`), true)
    const blocks = bucketItems(view.items.map((item) => blockInput(item.id, item)))
    const segments = [...new Set(processSegments(blocks).values())]
    assert.deepEqual(
      segments.map((s) => s.itemIds),
      Array.from({ length: count + 1 }, (_, i) => [`t:n${i}`]),
    )
  })
}

test('后台自发回合的第一条用户消息也是补充，只有一个真实回合', () => {
  for (const before of [[], [agentText('n', '后台检查', 'commentary')]]) {
    const view = projectTurn({
      ...turn('t', [
        ...before,
        userText('u', '为什么又倒了'),
        agentText('a', '有防御', 'final_answer'),
      ]),
      litchOrigin: 'backgroundTask',
    } as never)
    assert.equal(view.turn.origin, 'backgroundTask')
    assert.equal(turnAddition(view.turn, 't:u'), true)
  }
})

test('补充后没有最终回答：保持回合和条目顺序，结束后不自动收起', () => {
  const view = projectTurn(
    turn('t', [
      userText('u', '开头'),
      agentText('n', '说明', 'commentary'),
      userText('added', '补充'),
      agentText('last', '检查尚未完成', 'commentary'),
    ]),
  )
  assert.deepEqual(view.turn.itemIds, ['t:u', 't:n', 't:added', 't:last'])
  assert.equal(turnAddition(view.turn, 't:added'), true)
  const blocks = bucketItems(view.items.map((item) => blockInput(item.id, item)))
  assert.equal(
    blocks.some((block) => block.type === 'answer'),
    false,
  )
  assert.equal(processSettled(view.turn.status, []), false)
  assert.equal(new Set(processSegments(blocks).values()).size, 2)
})

test('目标续跑只隐藏开头的代发输入，真实补充保留', () => {
  const view = projectTurn({
    ...turn('t', [
      userText('start', '继续目标'),
      userText('u', '补充约束'),
      agentText('a', '回答'),
    ]),
    litchOrigin: 'goal',
  } as never)
  assert.deepEqual(view.turn.itemIds, ['t:u', 't:a'])
  assert.equal(view.turn.hiddenInputId, 'start')
  assert.equal(turnAddition(view.turn, 't:u'), true)
})

test('待办等外露块不拆摘要；只有用户条目划分各段', () => {
  const blocks = bucketItems([
    { id: 'a', kind: 'reasoning' },
    { id: 'todo', kind: 'todo' },
    { id: 'b', kind: 'command' },
    { id: 'u', kind: 'userMessage' },
    { id: 'c', kind: 'command' },
  ])
  const segments = processSegments(blocks)
  assert.equal(segments.get('a'), segments.get('b'))
  assert.deepEqual(segments.get('a')?.itemIds, ['a', 'b'])
  assert.deepEqual(segments.get('c')?.itemIds, ['c'])
})

test('分段耗时要求该段所有条目的完整时间，历史缺时间不编造；无补充仍用总时长', () => {
  const view = projectTurn(turn('t', [agentText('n', '说明', 'commentary')]))
  view.turn.durationMs = 196000
  assert.equal(processDuration(view.turn, view.items, false), 196000)
  assert.equal(processDuration(view.turn, view.items, true), null)
  view.items[0]!.span = { from: 1000, to: 6000 }
  assert.equal(processDuration(view.turn, view.items, true), 5000)
  view.items[0]!.span.to = null
  assert.equal(processDuration(view.turn, view.items, true), null)
})
