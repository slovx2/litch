import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watchForeground } from '../src/app/foreground.ts'

function fixture(native = false) {
  let visible = true
  let focused = true
  let nativeChanged
  const listeners = new Map()
  const values = []
  const stop = watchForeground(
    {
      visible: () => visible,
      focused: () => focused,
      listen(event, changed) {
        listeners.set(event, changed)
        return () => listeners.delete(event)
      },
      ...(native
        ? {
            native(changed) {
              nativeChanged = changed
              return () => {
                nativeChanged = undefined
              }
            },
          }
        : {}),
    },
    (value) => values.push(value),
  )
  return {
    value: () => values.at(-1),
    stop,
    focus(value) {
      focused = value
      listeners.get(value ? 'focus' : 'blur')?.()
    },
    visible(value) {
      visible = value
      listeners.get('visibilitychange')?.()
    },
    page(event) {
      listeners.get(event)?.()
    },
    native(value) {
      nativeChanged?.(value)
    },
    listeners,
  }
}

test('浏览器必须可见且聚焦；切后台、隐藏及页面离开即时停止，返回重新开始', () => {
  const f = fixture()
  assert.equal(f.value(), true)
  f.focus(false)
  assert.equal(f.value(), false)
  f.visible(false)
  f.focus(true)
  assert.equal(f.value(), false)
  f.visible(true)
  assert.equal(f.value(), true)
  f.page('pagehide')
  assert.equal(f.value(), false)
  f.focus(true)
  assert.equal(f.value(), false)
  f.page('pageshow')
  assert.equal(f.value(), true)
  f.stop()
  assert.equal(f.value(), false)
  assert.equal(f.listeners.size, 0)
})

test('桌面等原生状态确认；内置网页获得焦点仍属同一前台窗口，隐藏与最小化停止', () => {
  const f = fixture(true)
  assert.equal(f.value(), false)
  f.native(true)
  assert.equal(f.value(), true)
  f.focus(false)
  assert.equal(f.value(), true)
  f.native(false)
  assert.equal(f.value(), false)
  f.native(true)
  f.visible(false)
  assert.equal(f.value(), false)
  f.visible(true)
  assert.equal(f.value(), true)
  f.stop()
  f.native(true)
  assert.equal(f.value(), false)
})
