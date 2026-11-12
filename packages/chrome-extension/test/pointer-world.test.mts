import assert from 'node:assert/strict'
import test from 'node:test'
import { pointerDOM } from '../../browser/test/fixtures/pointer-dom.mjs'
import { CHROME_POINTER_LIFETIME_MS, installPointerWorld } from '../src/pointer-world.mjs'

test('指针认领清残留、重装不重复、到期自行移除、正常释放清零', async () => {
  const dom = pointerDOM()
  const doc = dom.doc as any
  const create = doc.createElement
  doc.createElement = (tag: string) => {
    const node = create(tag)
    node.animate = () => ({ cancel() {} })
    return node
  }
  doc.documentElement = dom.parent
  doc.querySelectorAll = () =>
    dom.parent.children.filter(
      (node: any) => node.isConnected && 'litchChromePointer' in node.dataset,
    )
  const globals = {
    document: doc,
    window: doc.defaultView,
    visualViewport: null,
    innerWidth: 375,
    innerHeight: 667,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 2,
    matchMedia: () => ({ matches: true }),
  }
  const saved = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  )
  const count = () => doc.querySelectorAll().length
  const surface = {
    surfaceId: 'fixture',
    executorId: 'fixture',
    generation: 1,
    geometryRevision: 0,
    kind: 'browserViewport',
    width: 375,
    height: 667,
  }
  try {
    Object.assign(globalThis, globals)
    const stale = doc.createElement('div')
    stale.dataset.litchChromePointer = 'old'
    dom.parent.append(stale)
    installPointerWorld()
    let api = (globalThis as any).__litchChromePointer
    api.configure(surface, 'first')
    assert.equal(count(), 1)
    assert.equal(stale.isConnected, false)
    // 模拟新 isolated world：旧 world 的 renderer 无法直接 dispose，仍不能留下第二个节点。
    installPointerWorld()
    api = (globalThis as any).__litchChromePointer
    api.configure(surface, 'second')
    assert.equal(count(), 1)
    dom.time(CHROME_POINTER_LIFETIME_MS)
    assert.equal(count(), 0)
    assert.equal(dom.pending.observers, 0)
    await api.hide()
    await api.restore()
    assert.equal(count(), 0, '光标到期不阻断截图')
    api.configure(surface, 'third')
    assert.equal(count(), 1)
    api.dispose()
    assert.equal(count(), 0)
    assert.equal(dom.pending.timers, 0)
  } finally {
    delete (globalThis as any).__litchChromePointer
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
