// <proposed_plan> 的流式解析（src/proposed-plan.mts）。用例照上游 codex rust-v0.163.0
// codex-rs/utils/stream-parser/src/proposed_plan.rs 里的几条，外加中文与标签前后的空白。
import assert from 'node:assert/strict'
import test from 'node:test'
import { ProposedPlanParser, type ProposedPlanSegment } from '../src/proposed-plan.mjs'

// 分几次喂进去、最后 finish；相邻的同类文字并起来，和一次喂完看到的一样
function collect(chunks: string[]): ProposedPlanSegment[] {
  const parser = new ProposedPlanParser()
  const all: ProposedPlanSegment[] = []
  for (const segment of [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.finish()]) {
    const last = all.at(-1)
    if (
      last &&
      (segment.type === 'text' || segment.type === 'planDelta') &&
      last.type === segment.type
    )
      last.text += segment.text
    else all.push({ ...segment })
  }
  return all
}

test('PLAN-PARSE-001：块里的是计划、块外的是回答，标签被拆在两次增量里也认得出', () => {
  assert.deepEqual(
    collect(['Intro text\n<prop', 'osed_plan>\n- step 1\n', '</proposed_plan>\nOutro']),
    [
      { type: 'text', text: 'Intro text\n' },
      { type: 'planStart' },
      { type: 'planDelta', text: '- step 1\n' },
      { type: 'planEnd' },
      { type: 'text', text: 'Outro' },
    ],
  )
})

test('PLAN-PARSE-002：标签不独占一行就是普通的字', () => {
  assert.deepEqual(collect(['  <proposed_plan> extra\n']), [
    { type: 'text', text: '  <proposed_plan> extra\n' },
  ])
  assert.deepEqual(collect(['见 <proposed_plan> 一节']), [
    { type: 'text', text: '见 <proposed_plan> 一节' },
  ])
})

test('PLAN-PARSE-003：没合上的计划块在说完时合上；标签前后的空白不影响', () => {
  assert.deepEqual(collect(['<proposed_plan>\n- step 1\n']), [
    { type: 'planStart' },
    { type: 'planDelta', text: '- step 1\n' },
    { type: 'planEnd' },
  ])
  assert.deepEqual(collect(['前言\n  <proposed_plan>  \n第一步\n</proposed_plan>']), [
    { type: 'text', text: '前言\n' },
    { type: 'planStart' },
    { type: 'planDelta', text: '第一步\n' },
    { type: 'planEnd' },
  ])
})

test('PLAN-PARSE-004：没有计划块时字原样放出，不以 < 开头的行不等', () => {
  const parser = new ProposedPlanParser()
  assert.deepEqual(parser.push('已收到回答'), [{ type: 'text', text: '已收到回答' }])
  assert.deepEqual(parser.push('并继续执行。'), [{ type: 'text', text: '并继续执行。' }])
  // 一行的开头还可能是标签时先攒着，看清楚不是了再放出去
  assert.deepEqual(parser.push('\n<pro'), [{ type: 'text', text: '\n' }])
  assert.deepEqual(parser.push('se 体'), [{ type: 'text', text: '<prose 体' }])
  assert.deepEqual(parser.finish(), [])
})

test('PLAN-PARSE-005：流出来的回答作废（模型请求重试）时 reset，攒着的半行和计划块都不要了', () => {
  const parser = new ProposedPlanParser()
  parser.push('<proposed_plan>\n- 第一步\n<pro')
  parser.reset()
  assert.deepEqual(parser.push('重新回答\n'), [{ type: 'text', text: '重新回答\n' }])
  assert.deepEqual(parser.finish(), [])
})
