import assert from 'node:assert/strict'
import test from 'node:test'
import { createPendingInputStore } from '../src/device/pending-inputs.mjs'

test('待发持久化：保留多条顺序、图片和评论；重启后只暂停，不自动重发', () => {
  let raw: unknown = null
  const file = {
    read: () => raw,
    write: (value: unknown) => {
      raw = structuredClone(value)
    },
  }
  const store = createPendingInputStore(file)
  const messages = [
    {
      id: 'a',
      text: '同文',
      images: [{ url: 'data:image/png;base64,AA', name: '图' }],
      extras: [],
    },
    {
      id: 'b',
      clientId: 'sent-b',
      delivery: 'unknown' as const,
      text: '同文',
      images: [],
      extras: [{ kind: 'text' as const, name: '笔记', text: '不要遗漏附件' }],
    },
  ]
  store.save('thread', messages)
  const restored = createPendingInputStore(file).load('thread')
  assert.deepEqual(
    restored.map((entry) => entry.delivery),
    ['held', 'unknown'],
  )
  assert.deepEqual(restored[0]?.images, messages[0]?.images)
  assert.deepEqual(restored[1]?.extras, messages[1]?.extras)
  store.save('thread', [])
  assert.deepEqual(createPendingInputStore(file).load('thread'), [])
})

test('待发持久化：写入失败不污染已保存数据', () => {
  const store = createPendingInputStore({
    read: () => ({
      version: 1,
      sessions: { thread: [{ id: 'a', text: '原文', images: [], extras: [] }] },
    }),
    write: () => {
      throw new Error('磁盘不可写')
    },
  })
  assert.throws(() => store.save('thread', []), /磁盘不可写/)
  assert.equal(store.load('thread')[0]?.text, '原文')
})
