import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAutomationPointer } from '../src/automation-preview/pointer-renderer.ts'
import { pointerDOM } from './fixtures/pointer-dom.mjs'

const surface = {
  surfaceId: 'tab',
  executorId: 'chrome',
  generation: 1,
  geometryRevision: 1,
  kind: 'browserViewport',
  width: 200,
  height: 100,
}
const frame = {
  pixelWidth: 400,
  pixelHeight: 200,
  contentRect: { x: 0, y: 0, width: 400, height: 200 },
  cursorComposited: false,
}
const sample = (seq, extra = {}) => ({
  ...surface,
  actionId: `a${seq}`,
  seq,
  timeUs: seq,
  phase: 'planned',
  kind: 'click',
  position: { x: 50, y: 30 },
  ...extra,
})
function setup(extra = {}) {
  const dom = pointerDOM()
  const renderer = createAutomationPointer(dom.parent, {
    surface,
    frame,
    color: 'blue',
    outlineColor: 'white',
    fixed: true,
    ...extra,
  })
  return { dom, renderer }
}

test('宿主隔离、鼠标穿透和 AX 隐藏；可见回执等待绘制机会', async () => {
  const { dom, renderer } = setup()
  assert.equal(dom.host.shadowMode, 'closed')
  assert.equal(dom.host.attributes['aria-hidden'], 'true')
  assert.match(dom.host.style.cssText, /pointer-events:none/)
  assert.match(dom.host.style.cssText, /position:fixed/)
  const value = sample(1)
  const pending = renderer.update(value)
  let done = false
  void pending.then(() => {
    done = true
  })
  dom.frame()
  await Promise.resolve()
  assert.equal(done, false)
  assert.equal(dom.svg.style.transform, 'translate(47px,28px)')
  dom.frame()
  assert.deepEqual(await pending, { sample: value, result: 'arrived' })
  renderer.dispose()
  assert.deepEqual(dom.pending, { frames: 0, timers: 0, observers: 0 })
})

test('顺序和版本拒绝旧事件，新动作与销毁结束旧等待', async () => {
  const { dom, renderer } = setup()
  const first = renderer.update(sample(1))
  assert.equal((await renderer.update(sample(1))).result, 'stale')
  assert.equal((await renderer.update(sample(2, { generation: 0 }))).result, 'stale')
  const second = renderer.update(sample(2))
  assert.equal((await first).result, 'superseded')
  renderer.geometry({ ...surface, geometryRevision: 2 }, frame)
  assert.equal((await second).result, 'superseded')
  assert.equal(dom.svg.style.display, 'none')
  const third = renderer.update(sample(1, { geometryRevision: 2 }))
  renderer.dispose()
  assert.equal((await third).result, 'disposed')
  assert.equal((await renderer.update(sample(3))).result, 'disposed')
  renderer.dispose()
  assert.deepEqual(dom.pending, { frames: 0, timers: 0, observers: 0 })
})

test('节流超时不冒充到位，隐藏页面不等待动画', async () => {
  const { dom, renderer } = setup()
  const pending = renderer.update(sample(1))
  dom.time(160)
  assert.equal((await pending).result, 'timedOut')
  dom.doc.hidden = true
  assert.equal((await renderer.update(sample(2))).result, 'hidden')
  assert.equal(dom.pending.frames, 0)
  renderer.dispose()
})

test('绘制与回执之间隐藏或移除节点不返回到位', async () => {
  for (const change of [
    (dom) => {
      dom.doc.hidden = true
    },
    (dom) => {
      dom.host.isConnected = false
    },
  ]) {
    const { dom, renderer } = setup()
    const pending = renderer.update(sample(1))
    dom.frame()
    change(dom)
    dom.frame()
    assert.equal((await pending).result, 'hidden')
    renderer.dispose()
  }
})

test('未知命中点、越界和已合成光标都隐藏，不沿用旧位置', async () => {
  const { dom, renderer } = setup()
  const pending = renderer.update(sample(1, { phase: 'dispatched', pressed: true }))
  assert.equal(dom.svg.children[0].style.opacity, '0.8')
  assert.equal(
    (await renderer.update(sample(2, { position: undefined, kind: 'semantic' }))).result,
    'hidden',
  )
  assert.equal((await pending).result, 'superseded')
  assert.equal(dom.svg.style.display, 'none')
  assert.equal(dom.svg.children[0].style.opacity, '0')
  assert.equal((await renderer.update(sample(3, { position: { x: 200, y: 20 } }))).result, 'hidden')
  renderer.geometry(surface, { ...frame, cursorComposited: true })
  assert.equal((await renderer.update(sample(4))).result, 'hidden')
  assert.equal(dom.svg.style.display, 'none')
  renderer.dispose()
})

test('视图缩放和帧裁剪变化取消旧回执并按新几何映射', async () => {
  const { dom, renderer } = setup()
  const pending = renderer.update(sample(1))
  dom.frame()
  dom.resize(400, 200)
  assert.equal((await pending).result, 'superseded')
  assert.equal(dom.svg.style.transform, 'translate(97px,58px)')
  const second = renderer.update(sample(2))
  renderer.geometry(surface, { ...frame, contentRect: { x: 0, y: 0, width: 200, height: 100 } })
  assert.equal((await second).result, 'superseded')
  assert.equal(dom.svg.style.transform, 'translate(47px,28px)')
  renderer.dispose()
})

test('轨迹沿采样点插值，最后仍停在动作目标', async () => {
  const { dom, renderer } = setup()
  let pending = renderer.update(sample(1, { position: { x: 0, y: 0 } }))
  dom.frame(0)
  dom.frame(0)
  await pending
  pending = renderer.update(
    sample(2, {
      position: { x: 100, y: 50 },
      path: [
        { x: 0, y: 0, offsetMs: 0 },
        { x: 100, y: 0, offsetMs: 60 },
        { x: 100, y: 50, offsetMs: 120 },
      ],
    }),
  )
  dom.frame(60)
  assert.equal(dom.svg.style.transform, 'translate(97px,-2px)')
  dom.frame(120)
  dom.frame(136)
  assert.equal((await pending).result, 'arrived')
  assert.equal(dom.svg.style.transform, 'translate(97px,48px)')
  renderer.dispose()
})

test('截图嵌套隐藏，失败恢复，销毁后不复活', async () => {
  const { dom, renderer } = setup()
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const first = renderer.withoutPointer(() => held)
  const second = renderer.withoutPointer(async () => 'shot')
  assert.equal(dom.host.style.visibility, 'hidden')
  dom.frame()
  dom.frame()
  assert.equal(await second, 'shot')
  assert.equal(dom.host.style.visibility, 'hidden')
  release('first')
  assert.equal(await first, 'first')
  assert.equal(dom.host.style.visibility, '')
  const failed = renderer.withoutPointer(async () => {
    throw new Error('capture failed')
  })
  const rejected = assert.rejects(failed, /capture failed/)
  dom.frame()
  dom.frame()
  await rejected
  assert.equal(dom.host.style.visibility, '')
  const disposed = renderer.withoutPointer(async () => 'done')
  renderer.dispose()
  dom.time(200)
  assert.equal(await disposed, 'done')
  assert.equal(dom.host.isConnected, false)
  assert.equal(dom.host.style.visibility, 'hidden')
})
