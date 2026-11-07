import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watchFilePanel } from '../src/files/lifecycle.ts'

test('可见与焦点分开：隐藏停止订阅，重复 focus 不重复补读，原生窗口焦点覆盖 DOM 焦点', () => {
  const listeners = new Map()
  let shown = true,
    focused = true,
    native
  const source = {
    visible: () => shown,
    focused: () => focused,
    listen(event, fn) {
      const group = listeners.get(event) ?? new Set()
      group.add(fn)
      listeners.set(event, group)
      return () => group.delete(fn)
    },
    native(fn) {
      native = fn
      return () => {
        native = undefined
      }
    },
  }
  const emit = (event) => {
    for (const fn of listeners.get(event) ?? []) fn()
  }
  let visible,
    reads = 0
  const close = watchFilePanel(
    source,
    (next) => {
      visible = next
    },
    () => reads++,
  )
  assert.equal(visible, true)
  assert.equal(reads, 0)
  native(true)
  assert.equal(reads, 1)
  emit('focus')
  emit('focus')
  assert.equal(reads, 1)
  focused = false
  emit('blur')
  emit('focus')
  assert.equal(reads, 1)
  native(false)
  native(true)
  assert.equal(reads, 2)
  shown = false
  emit('visibilitychange')
  assert.equal(visible, false)
  native(true)
  assert.equal(reads, 2)
  shown = true
  emit('visibilitychange')
  assert.equal(visible, true)
  assert.equal(reads, 3)
  close()
  emit('focus')
  emit('visibilitychange')
  assert.equal(reads, 3)
  assert.equal(
    [...listeners.values()].reduce((n, s) => n + s.size, 0),
    0,
  )
})
