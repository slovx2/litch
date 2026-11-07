import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewGestures } from '../src/web/file-preview-gestures.js'

test('离线图片视口：双指缩放、单指拖动、旋转复位和退出释放监听', () => {
  const handlers = new Map(),
    windowHandlers = new Map()
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
  }
  globalThis.document = {
    body: { setPointerCapture() {} },
    addEventListener: (name, fn) => handlers.set(name, fn),
    removeEventListener: (name) => handlers.delete(name),
  }
  const messages = []
  globalThis.window = {
    ReactNativeWebView: { postMessage: (value) => messages.push(JSON.parse(value)) },
    addEventListener: (name, fn) => windowHandlers.set(name, fn),
    removeEventListener: (name) => windowHandlers.delete(name),
  }
  globalThis.innerWidth = 400
  globalThis.innerHeight = 400
  try {
    const stage = { style: {} }
    const close = previewGestures(stage, 320, 240)
    const initial = stage.style.transform
    assert.deepEqual(messages.at(-1), { kind: 'zoom', percent: 100 })
    window.__litchImageZoom(1.25)
    assert.match(stage.style.transform, /scale\(1\.25\)/)
    assert.deepEqual(messages.at(-1), { kind: 'zoom', percent: 125 })
    window.__litchImageZoom(0.8)
    assert.equal(stage.style.transform, initial)
    const event = (type, pointerId, clientX, clientY) =>
      handlers.get(type)({ type, pointerId, clientX, clientY })
    event('pointerdown', 1, 150, 200)
    event('pointerdown', 2, 250, 200)
    event('pointermove', 2, 300, 200)
    assert.match(stage.style.transform, /scale\(1\.5\)/)
    event('pointerup', 2, 300, 200)
    event('pointerup', 1, 150, 200)
    event('pointerdown', 1, 100, 100)
    event('pointermove', 1, 140, 120)
    event('pointerup', 1, 140, 120)
    assert.notEqual(stage.style.transform, initial)
    windowHandlers.get('resize')()
    assert.equal(stage.style.transform, initial)
    close()
    assert.equal(handlers.size, 0)
    assert.equal(windowHandlers.size, 0)
    assert.equal(window.__litchImageZoom, undefined)
    const thumbnail = previewGestures(stage, 320, 240, true)
    assert.equal(handlers.size, 0)
    thumbnail()
  } finally {
    Object.assign(globalThis, original)
  }
})
