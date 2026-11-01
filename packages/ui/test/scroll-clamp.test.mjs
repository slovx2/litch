import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scrollClampBase } from '../src/transcript/scroll-clamp.ts'

test('整数范围与真实顶部相差 1px 时，收起仍从夹限前补偿，不重复减掉步骤组的 166px', () => {
  // 实测：收起前 scrollTop=-871；收起后范围为 706，实际已夹到 -705。
  // 原来的 abs(-705 + 706) < 1 为假，错误地再补 166px 到 -539。
  const base = scrollClampBase(-871, -705, 66, 66.84375)
  assert.equal(base, -871)
  assert.equal(base - -166, -705)
})

test('Retina 的半像素、整数顶部都从夹限前补偿', () => {
  assert.equal(scrollClampBase(-861.5, -695.5, 66.5, 66.5), -861.5)
  assert.equal(scrollClampBase(-861, -695, 66, 66), -861)
})

test('用户在范围内移动、内容增长或没有历史位置时使用当前值', () => {
  assert.equal(scrollClampBase(-871, -600, -39, 66), -600)
  assert.equal(scrollClampBase(-695, -861, 66, 66), -861)
  assert.equal(scrollClampBase(null, -705, 66, 66), -705)
  assert.equal(scrollClampBase(-705, -705, 66, 66), -705)
})
