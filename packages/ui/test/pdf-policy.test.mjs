import assert from 'node:assert/strict'
import test from 'node:test'
import {
  pageLayout,
  rasterScale,
  validSize,
  visiblePages,
} from '../src/files/preview/pdf/policy.ts'

test('PDF 虚拟页：只挂载可见页和两端邻页，旋转纸张仍按实际尺寸占位', () => {
  const sizes = Array.from({ length: 200 }, (_, index) =>
    index === 1 ? { width: 800, height: 600 } : { width: 600, height: 800 },
  )
  const boxes = pageLayout(sizes, 632, 1)
  assert.deepEqual(visiblePages(boxes, 0, 800), [0, 1])
  assert.deepEqual(visiblePages(boxes, boxes[100].top, 600), [99, 100, 101])
  assert.deepEqual(visiblePages(boxes, boxes[199].top, 600), [198, 199])
  assert.equal(boxes[1].width, 600)
  assert.equal(boxes[1].height, 450)
  assert.equal(pageLayout([{ width: 20_000, height: 10_000 }], 632, 1)[0].width, 600)
})
test('PDF 像素预算不随缩放/DPR/可见页数膨胀，异常尺寸被拒绝', () => {
  const box = { width: 1800, height: 2400 }
  for (const count of [1, 3, 10]) {
    const density = rasterScale(box, count, 3)
    assert(box.width * box.height * density ** 2 * count <= 16_000_001)
  }
  for (const width of [0, -1, Infinity, NaN, 20_001])
    assert.equal(validSize({ width, height: 800 }), false)
  assert(validSize({ width: 800, height: 600 }))
})
