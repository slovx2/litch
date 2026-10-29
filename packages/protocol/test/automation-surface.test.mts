import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AutomationPointerSample,
  type AutomationSurface,
  automationContentRect,
  automationPointFromView,
  automationPointToView,
  isCurrentAutomationPointer,
  sameAutomationSurface,
} from '../src/automation-surface.mts'

const surface: AutomationSurface = {
  surfaceId: 'window-7',
  executorId: 'mac-remote',
  generation: 2,
  geometryRevision: 4,
  kind: 'nativeWindow',
  width: 600,
  height: 400,
}
const frame = {
  pixelWidth: 1240,
  pixelHeight: 880,
  contentRect: { x: 20, y: 60, width: 1200, height: 800 },
  cursorComposited: false,
}
const viewport = { x: -40, y: 10, width: 620, height: 620 }
const pointer: AutomationPointerSample = {
  ...surface,
  actionId: 'click-1',
  seq: 10,
  timeUs: 900,
  phase: 'dispatched',
  kind: 'click',
  position: { x: 120, y: 90 },
  pressed: true,
}

test('Retina、帧边框、标题栏和 contain 留白只换算一次', () => {
  assert.deepEqual(automationContentRect(frame, viewport), {
    x: -30,
    y: 130,
    width: 600,
    height: 400,
  })
  assert.deepEqual(automationPointToView({ x: 300, y: 200 }, surface, frame, viewport), {
    x: 270,
    y: 330,
  })
  assert.deepEqual(automationPointFromView({ x: 270, y: 330 }, surface, frame, viewport), {
    x: 300,
    y: 200,
  })
  assert.equal(automationPointFromView({ x: 270, y: 110 }, surface, frame, viewport), null)
  assert.equal(automationPointFromView({ x: -35, y: 330 }, surface, frame, viewport), null)
})

test('浏览器 CSS px 在非整数缩放下可往返，负的布局位置不影响内容坐标', () => {
  const browser = { ...surface, kind: 'browserViewport' as const, width: 900, height: 600 }
  const image = {
    pixelWidth: 1350,
    pixelHeight: 900,
    contentRect: { x: 0, y: 0, width: 1350, height: 900 },
    cursorComposited: false,
  }
  const box = { x: -1200, y: -30, width: 440, height: 400 }
  const point = { x: 801.5, y: 321.25 }
  const shown = automationPointToView(point, browser, image, box)
  assert.ok(shown)
  const restored = automationPointFromView(shown, browser, image, box)
  assert.ok(restored)
  assert.ok(Math.abs(restored.x - point.x) < 1e-9)
  assert.ok(Math.abs(restored.y - point.y) < 1e-9)
})

test('越界、非有限值和错误裁剪不能变成可用点击', () => {
  for (const point of [
    { x: -1, y: 0 },
    { x: 600, y: 0 },
    { x: 0, y: 400 },
    { x: NaN, y: 0 },
  ]) {
    assert.equal(automationPointToView(point, surface, frame, viewport), null)
  }
  assert.equal(automationContentRect({ ...frame, pixelWidth: 0 }, viewport), null)
  assert.equal(
    automationContentRect(
      { ...frame, contentRect: { x: 30, y: 0, width: 1240, height: 800 } },
      viewport,
    ),
    null,
  )
  assert.equal(automationContentRect(frame, { ...viewport, width: Infinity }), null)
  assert.equal(
    automationPointFromView({ x: 0, y: 0 }, { ...surface, height: 0 }, frame, viewport),
    null,
  )
})

test('设备相同窗口号、窗口重建、resize 和乱序报文不能串入当前预览', () => {
  assert.ok(isCurrentAutomationPointer(surface, pointer))
  for (const changed of [
    { executorId: 'local-mac' },
    { surfaceId: 'window-8' },
    { generation: 1 },
    { geometryRevision: 3 },
  ]) {
    assert.equal(isCurrentAutomationPointer(surface, { ...pointer, ...changed }), false)
  }
  assert.equal(isCurrentAutomationPointer(surface, pointer, pointer), false)
  assert.equal(isCurrentAutomationPointer(surface, { ...pointer, seq: 9 }, pointer), false)
  assert.ok(isCurrentAutomationPointer(surface, { ...pointer, seq: 11 }, pointer))
  assert.ok(
    isCurrentAutomationPointer(surface, { ...pointer, seq: 0 }, { ...pointer, generation: 1 }),
  )
  assert.equal(sameAutomationSurface({ ...surface, generation: NaN }, surface), false)
})

test('取消和失败同样按序到达；不以远端时钟与本地时钟差决定是否丢弃', () => {
  assert.ok(
    isCurrentAutomationPointer(
      surface,
      { ...pointer, seq: 11, phase: 'cancelled', pressed: false },
      pointer,
    ),
  )
  assert.ok(
    isCurrentAutomationPointer(
      surface,
      { ...pointer, seq: 11, phase: 'failed', timeUs: 1 },
      pointer,
    ),
  )
  assert.equal(isCurrentAutomationPointer(surface, { ...pointer, seq: 1.5 }), false)
  assert.equal(isCurrentAutomationPointer(surface, { ...pointer, timeUs: Infinity }), false)
})
