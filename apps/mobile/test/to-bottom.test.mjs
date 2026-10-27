// “回到底部”出不出：离开底部一段才出，回到很近才收，中间来回不闪
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Away } from '../src/detail/to-bottom.ts'

test('回到底部：过 48 才出，回到 8 以内才收，只在变了时通知', () => {
  const away = new Away()
  let calls = 0
  away.subscribe(() => calls++)
  away.scrolled(30)
  assert.equal(away.get(), false)
  away.scrolled(60)
  assert.equal(away.get(), true)
  away.scrolled(20)
  assert.equal(away.get(), true, '中间段不收')
  away.scrolled(500)
  away.scrolled(4)
  assert.equal(away.get(), false)
  assert.equal(calls, 2)
})
