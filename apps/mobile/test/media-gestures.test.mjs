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

test('全屏图片单击关闭、双击放大，拖动及无位移的双指松手都不关闭', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] })
  const handlers = new Map()
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
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.innerWidth = 400
  globalThis.innerHeight = 400
  let closed = 0
  const stage = { style: {} }
  const release = previewGestures(stage, 320, 240, false, () => closed++)
  const event = (type, pointerId = 1, clientX = 150, clientY = 200) =>
    handlers.get(type)({ type, pointerId, clientX, clientY })
  const tap = () => {
    event('pointerdown')
    event('pointerup')
  }
  try {
    tap()
    ctx.mock.timers.tick(100)
    tap()
    ctx.mock.timers.tick(400)
    assert.equal(closed, 0)
    assert.match(stage.style.transform, /scale\(2.5\)/)
    event('pointerdown')
    event('pointermove', 1, 190, 240)
    event('pointerup', 1, 190, 240)
    ctx.mock.timers.tick(400)
    assert.equal(closed, 0)
    event('pointerdown', 1)
    event('pointerdown', 2, 250, 200)
    event('pointerup', 2, 250, 200)
    event('pointerup', 1)
    ctx.mock.timers.tick(400)
    assert.equal(closed, 0)
    event('pointerdown')
    event('pointercancel')
    ctx.mock.timers.tick(400)
    assert.equal(closed, 0)
    tap()
    ctx.mock.timers.tick(300)
    assert.equal(closed, 1, '放大后单击仍直接关闭')
    tap()
    release()
    ctx.mock.timers.tick(400)
    assert.equal(closed, 1, '退出后没有延迟回调')
  } finally {
    release()
    Object.assign(globalThis, original)
  }
})
