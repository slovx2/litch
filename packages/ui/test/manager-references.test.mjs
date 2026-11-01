import assert from 'node:assert/strict'
import test from 'node:test'
import { boardReferences } from '../src/manager/references.ts'

test('事项和决策的说明链接所有现存编号，不限制在阻塞关系内，缺失编号保持原文', () => {
  const text = '参见I-3、D-15；I-3 已完成，D-99 不存在。'
  const parts = boardReferences(text, new Set(['I-3', 'D-15']))
  assert.equal(parts.map((part) => part.text).join(''), text)
  assert.deepEqual(
    parts.filter((part) => part.id).map((part) => part.id),
    ['I-3', 'D-15', 'I-3'],
  )
  assert.deepEqual(boardReferences('I-3 D-15', new Set()), [{ text: 'I-3 D-15' }])
})

test('只认完整编号，保留换行与标点，不截取单词或更长编号，斜杠分隔也能识别', () => {
  const text = 'XI-3 D-15x I-30 D-150\n（I-3）[D-15] I-3/D-15'
  const parts = boardReferences(text, new Set(['I-3', 'D-15']))
  assert.equal(parts.map((part) => part.text).join(''), text)
  assert.deepEqual(
    parts.filter((part) => part.id).map((part) => part.id),
    ['I-3', 'D-15', 'I-3', 'D-15'],
  )
  assert.deepEqual(boardReferences('', new Set(['I-3'])), [])
})

test('议题编号支持井号和报告，链接键不包含井号', () => {
  const parts = boardReferences('#D-1、#I-2、#P-3。', new Set(['D-1', 'I-2', 'P-3']))
  assert.deepEqual(
    parts.filter((p) => p.id).map((p) => [p.id, p.text]),
    [
      ['D-1', '#D-1'],
      ['I-2', '#I-2'],
      ['P-3', '#P-3'],
    ],
  )
})
