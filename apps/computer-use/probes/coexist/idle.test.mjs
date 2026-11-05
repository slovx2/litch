import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHidIdleSeconds } from './idle.mjs'

test('HIDIdleTime 按纳秒解析，60秒之前不得启动', () => {
  assert.equal(parseHidIdleSeconds('    | | | "HIDIdleTime" = 59999999999'), 59.999)
  assert.equal(parseHidIdleSeconds('"HIDIdleTime" = 60000000000'), 60)
  assert.equal(parseHidIdleSeconds('"HIDIdleTime" = 7200000000000'), 7200)
})

test('缺失或损坏的HID读数必须拒绝，不能当作空闲', () => {
  assert.throws(() => parseHidIdleSeconds(''), /HIDIdleTime/)
  assert.throws(() => parseHidIdleSeconds('"HIDIdleTime" = unavailable'), /HIDIdleTime/)
})
