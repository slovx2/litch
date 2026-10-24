// 对话区两档视图按会话记住的那一份（transcript/view.ts）：读、改、上限。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { parseViews, withView, VIEW_KEEP, viewOf, setTranscriptView, onViewSwitch } = await import(
  '../src/transcript/view.ts'
)

test('没记着、记坏了的都是空名单（新会话默认精简）', () => {
  assert.deepEqual(parseViews(null), [])
  assert.deepEqual(parseViews(''), [])
  assert.deepEqual(parseViews('not json'), [])
  assert.deepEqual(parseViews('{"verbose":"a:b"}'), [])
  assert.deepEqual(parseViews('[1,2]'), [])
})

test('读的时候丢掉不是字符串的、空的、重复的', () => {
  assert.deepEqual(parseViews('{"verbose":["d:1",2,"","d:2","d:1",null]}'), ['d:1', 'd:2'])
})

test('切成详细排到最后，切回精简就从名单里去掉', () => {
  assert.deepEqual(withView([], 'd:1', 'verbose'), ['d:1'])
  assert.deepEqual(withView(['d:1', 'd:2'], 'd:1', 'verbose'), ['d:2', 'd:1'])
  assert.deepEqual(withView(['d:1', 'd:2'], 'd:1', 'compact'), ['d:2'])
  assert.deepEqual(withView(['d:2'], 'd:1', 'compact'), ['d:2'])
})

test('记多了丢最早切成详细的', () => {
  const many = Array.from({ length: VIEW_KEEP }, (_, index) => `d:${index}`)
  const next = withView(many, 'd:new', 'verbose')
  assert.equal(next.length, VIEW_KEEP)
  assert.equal(next[0], 'd:1')
  assert.equal(next.at(-1), 'd:new')
  const raw = JSON.stringify({ verbose: [...many, 'd:extra'] })
  assert.deepEqual(parseViews(raw), [...many.slice(1), 'd:extra'])
})

test('换档：没切过是精简，切过之后按会话各记各的；换之前先叫一声，同一档不叫', () => {
  const heard = []
  const off = onViewSwitch((key) => heard.push([key, viewOf(key)]))
  assert.equal(viewOf('dev:a'), 'compact')
  setTranscriptView('dev:a', 'verbose')
  assert.equal(viewOf('dev:a'), 'verbose')
  assert.equal(viewOf('dev:b'), 'compact')
  setTranscriptView('dev:a', 'verbose')
  setTranscriptView('dev:a', 'compact')
  assert.equal(viewOf('dev:a'), 'compact')
  off()
  setTranscriptView('dev:b', 'verbose')
  // 叫的时候还是换之前的那一档（页面还没重画）
  assert.deepEqual(heard, [
    ['dev:a', 'compact'],
    ['dev:a', 'verbose'],
  ])
})
