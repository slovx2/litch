import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readingMemory, readingOffset, readPosition } from '../src/detail/reading-position.ts'

function list(keys = ['latest', 'middle', 'oldest']) {
  return {
    props: { data: keys.map((key) => ({ key })) },
    offset: 0,
    head: 10,
    height: 200,
    getAbsoluteLastScrollOffset() {
      return this.offset
    },
    getFirstItemOffset() {
      return this.head
    },
    getLayout(index) {
      return { y: index * this.height, height: this.height }
    },
    computeVisibleIndices() {
      return { startIndex: Math.floor(this.offset / this.height), endIndex: 2 }
    },
  }
}

test('贴底离开：重新进入按最新底部定位，离开期间加消息、尾巴长高都不使用旧偏移', () => {
  const before = list()
  before.offset = 12
  const position = readPosition(before)
  assert.deepEqual(position, { kind: 'bottom' })
  const after = list(['new-2', 'new-1', 'latest', 'middle', 'oldest'])
  after.head = 1800
  after.offset = 723
  assert.equal(readingOffset(after, position), 0)
})

test('翻看历史离开：按消息身份恢复，同一消息换下标、行高和表头高度仍落在原处', () => {
  const before = list()
  before.offset = 250
  const position = readPosition(before)
  assert.deepEqual(position, { kind: 'anchor', key: 'middle', top: 160 })
  const after = list(['new', 'latest', 'middle', 'oldest'])
  after.height = 220
  after.head = 50
  after.offset = 0
  assert.equal(readingOffset(after, position), 550)
  after.offset = 400
  assert.equal(readingOffset(after, position), 550)
})

test('分批挂载尚未包含消息时等待，不用 0 覆盖历史锚点', () => {
  const position = { kind: 'anchor', key: 'middle', top: 160 }
  const partial = list(['new'])
  assert.equal(readingOffset(partial, position), null)
  partial.props.data.push({ key: 'middle' })
  assert.equal(readingOffset(partial, position), 250)
})

test('流式中的可变行不当阅读锚点，未测量的可见区不覆盖旧记忆', () => {
  const current = list(['stream', 'stable', 'oldest'])
  current.offset = 80
  assert.deepEqual(readPosition(current, 1), { kind: 'anchor', key: 'stable', top: 330 })
  current.computeVisibleIndices = () => ({ startIndex: 0, endIndex: 0 })
  assert.equal(readPosition(current, 1), null)
})

test('同一会话重进保留阅读意图，设备和核心实例互不串位置', () => {
  const owner = {}
  const memory = readingMemory(owner, 'device', 'manager')
  memory.position = { kind: 'anchor', key: 'message', top: 120 }
  assert.equal(readingMemory(owner, 'device', 'manager'), memory)
  assert.deepEqual(readingMemory(owner, 'another', 'manager').position, { kind: 'bottom' })
  assert.deepEqual(readingMemory({}, 'device', 'manager').position, { kind: 'bottom' })
})
