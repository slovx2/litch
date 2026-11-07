import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type BlockInput,
  blockInput,
  bucketItems,
  processSegments,
  projectItem,
  projectThread,
  visibleProcessParts,
} from '../src/index.mjs'
import { agentText, thread, turn } from './fixtures.mjs'

const text = (id: string, phase?: BlockInput['phase']): BlockInput => ({
  id,
  kind: 'agentMessage',
  ...(phase ? { phase } : {}),
})
const tool = (id: string): BlockInput => ({ id, kind: 'toolCall' })

function visible(items: BlockInput[], folded = true): string[] {
  const blocks = bucketItems(items)
  const segments = processSegments(blocks)
  return blocks.flatMap((block) => {
    if (block.type === 'answer') return [block.itemId]
    if (block.type !== 'process') return []
    const segment = segments.get(block.key)
    assert.ok(segment)
    return visibleProcessParts(block.parts, folded, segment.keepSteps).flatMap((part) =>
      part.type === 'steps' ? [`tools:${part.itemIds.join(',')}`] : [part.itemId],
    )
  })
}

test('Claude 式未知阶段：文字、工具、重要结论、工具、短收尾，结束后仍按原序可见', () => {
  const items = [text('start', 'unknown'), tool('one'), text('finding'), tool('two'), text('end')]
  assert.deepEqual(visible(items), ['start', 'tools:one', 'finding', 'tools:two', 'end'])
  assert.deepEqual(visible(items, false), visible(items))
})

test('Codex 式原生阶段：只隐藏 commentary 与工具，明确 final 仍显示', () => {
  const items = [text('note', 'commentary'), tool('one'), text('answer', 'final')]
  assert.deepEqual(visible(items), ['answer'])
  assert.deepEqual(visible(items, false), ['note', 'tools:one', 'answer'])
})

test('混合阶段：原生 commentary 隐藏，unknown 与 final 保留，工具摘要留在原位', () => {
  const items = [
    text('note', 'commentary'),
    tool('one'),
    text('finding', 'unknown'),
    tool('two'),
    text('note2', 'commentary'),
    text('answer', 'final'),
  ]
  assert.deepEqual(visible(items), ['tools:one', 'finding', 'tools:two', 'answer'])
  assert.deepEqual(visible(items, false), [
    'note',
    'tools:one',
    'finding',
    'tools:two',
    'note2',
    'answer',
  ])
})

test('插话切段：未知阶段正文不改变其他段的原生 commentary 折叠', () => {
  assert.deepEqual(
    visible([
      text('finding', 'unknown'),
      tool('one'),
      { id: 'user', kind: 'userMessage' },
      text('note', 'commentary'),
      tool('two'),
      text('answer', 'final'),
    ]),
    ['finding', 'tools:one', 'answer'],
  )
})

for (const harness of [
  'codex',
  'claude',
  'pi',
  'opencode',
  'dsh',
  'acp',
  'gemini',
  'antigravity',
]) {
  test(`${harness} 载入：仅 harness 原生 commentary 可用于折叠，协议数据不改`, () => {
    const message = agentText('m', '中间的重要结论', 'commentary')
    const final = agentText('f', '已完成', 'final_answer')
    const view = projectThread(thread({ id: 's', turns: [turn('t', [message, final])] }), {
      deviceId: 'local',
      harness,
    })
    const projected = view.items['t:m']
    assert.ok(projected)
    assert.equal(
      projected.kind === 'agentMessage' && projected.phase,
      harness === 'codex' ? 'commentary' : 'unknown',
    )
    assert.equal(view.items['t:f']?.kind === 'agentMessage' && view.items['t:f'].phase, 'final')
    assert.equal(message.type === 'agentMessage' && message.phase, 'commentary')
    // 条目增量与历史投影采用相同的来源判断。
    assert.deepEqual(projectItem(message, false, harness === 'codex'), { ...projected, id: 'm' })
    assert.equal(
      bucketItems([blockInput(projected.id, projected)])[0]?.type,
      harness === 'codex' ? 'process' : 'answer',
    )
  })
}
