import assert from 'node:assert/strict'
import test from 'node:test'
import { nextOpenDecision } from '../src/projection/manager-next.mjs'

const entries = [
  { id: 'D-1', status: 'open' },
  { id: 'D-2', status: 'answered' },
  { id: 'D-3', status: 'open' },
  { id: 'D-4', status: 'open' },
  { id: 'D-5', status: 'ignored' },
  { id: 'D-6', status: 'open' },
]
const none = () => false

test('没有展开项时取列表里第一个待答的；展开项不在列表里时同样从头找', () => {
  assert.equal(nextOpenDecision(entries, null, none), 'D-1')
  assert.equal(nextOpenDecision(entries, 'D-99', none), 'D-1')
})

test('按列表顺序取展开项后面的待答决策，跳过已答和忽略的', () => {
  assert.equal(nextOpenDecision(entries, 'D-1', none), 'D-3')
  assert.equal(nextOpenDecision(entries, 'D-4', none), 'D-6')
})

test('写了草稿的跳过；后面没有待答的返回 null', () => {
  const drafted = (id: string) => id === 'D-3' || id === 'D-6'
  assert.equal(nextOpenDecision(entries, 'D-1', drafted), 'D-4')
  assert.equal(nextOpenDecision(entries, 'D-4', drafted), null)
  assert.equal(nextOpenDecision(entries, 'D-6', none), null)
})
