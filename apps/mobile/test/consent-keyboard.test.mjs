import assert from 'node:assert/strict'
import test from 'node:test'
import { consentKeyboard } from '../src/privacy/consent-keyboard.ts'

test('同意框主动收键盘，动画期间返回不拒绝；收完后的明确返回才取消', async () => {
  let shown = true
  let finish
  let dismissals = 0
  let cancelled = 0
  const keyboard = consentKeyboard({
    visible: () => shown,
    dismiss: () => {
      dismissals++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    cancel: () => cancelled++,
  })
  const pending = keyboard.hide()
  assert.equal(dismissals, 1)
  assert.equal(keyboard.back(), pending)
  shown = false
  assert.equal(keyboard.back(), pending, '系统先更新可见性、动画尚未完成也不取消')
  assert.equal(cancelled, 0)
  finish()
  await pending
  await keyboard.back()
  assert.equal(cancelled, 1)
})

test('同意期间键盘再次出现，返回只收键盘；没有键盘时正常取消', async () => {
  let shown = false
  let cancelled = 0
  let dismissals = 0
  const keyboard = consentKeyboard({
    visible: () => shown,
    dismiss: async () => {
      dismissals++
      shown = false
    },
    cancel: () => cancelled++,
  })
  await keyboard.hide()
  shown = true
  await keyboard.back()
  assert.equal(dismissals, 2)
  assert.equal(cancelled, 0)
  await keyboard.back()
  assert.equal(cancelled, 1)
})
