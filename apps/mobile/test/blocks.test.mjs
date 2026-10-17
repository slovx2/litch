// 流式 Markdown 切块（src/core/blocks.ts）：封了口的块不再变、代码块不从中间切、定稿和流式拼出来的不一样时从头切。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkText, emptyChunks } from '../src/core/blocks.ts'
import { experiment } from '../src/experiment.ts'

const para = (n, size = 40) => `${String(n).repeat(size)}\n\n`

test('一点一点长：封了口的块对象和文字都不再变，拼回去等于原文', () => {
  experiment.seal = 100
  const full = Array.from({ length: 8 }, (_, i) => para(i)).join('')
  const state = emptyChunks()
  let previous = null
  let sealedSeen = []
  for (let at = 7; at <= full.length; at += 7) {
    const text = full.slice(0, at)
    const chunks = chunkText(state, text, previous, true)
    previous = text
    // 之前封口的那些原样还在前面
    assert.deepEqual(chunks.slice(0, sealedSeen.length), sealedSeen)
    sealedSeen = chunks.filter((chunk) => !chunk.open)
    assert.ok(chunks.every((chunk, index) => chunk.index === index))
    assert.ok(
      chunks.slice(0, -1).every((chunk) => !chunk.open),
      '只有最后一块在长',
    )
  }
  const done = chunkText(state, full, previous, false)
  assert.ok(done.every((chunk) => !chunk.open))
  assert.equal(done.map((chunk) => chunk.text).join('\n\n'), full.trimEnd())
  // 每组至少攒够 seal 个字才封口（最后一组除外）
  for (const chunk of done.slice(0, -1)) assert.ok(chunk.text.length >= 100 - 2)
})

test('代码块里的空行不切', () => {
  experiment.seal = 1
  const text = `前言\n\n\`\`\`js\nconst a = 1\n\nconst b = 2\n\`\`\`\n\n尾巴\n\n`
  const chunks = chunkText(emptyChunks(), text, null, false)
  assert.deepEqual(
    chunks.map((chunk) => chunk.text),
    ['前言', '```js\nconst a = 1\n\nconst b = 2\n```', '尾巴'],
  )
})

test('没写完的代码块整个留在正在长的那一块里', () => {
  experiment.seal = 1
  const text = '前言\n\n```\n第一行\n\n第二行'
  const chunks = chunkText(emptyChunks(), text, null, true)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].text, '前言')
  assert.deepEqual(chunks[1], { index: 1, text: '```\n第一行\n\n第二行', open: true })
})

test('定稿的文字不是流式拼出来那段往后长的：从头切', () => {
  experiment.seal = 1
  const state = emptyChunks()
  const streamed = '甲甲\n\n乙乙\n\n丙'
  chunkText(state, streamed, null, true)
  assert.equal(state.sealed.length, 2)
  const final = '完全不同\n\n的结果'
  const chunks = chunkText(state, final, streamed, false)
  assert.deepEqual(
    chunks.map((chunk) => chunk.text),
    ['完全不同', '的结果'],
  )
})

test('空文字：流式时没有块，定稿也没有（默认的封口字数）', () => {
  experiment.seal = 300
  assert.deepEqual(chunkText(emptyChunks(), '', null, true), [])
  assert.deepEqual(chunkText(emptyChunks(), '  \n', null, false), [])
})
