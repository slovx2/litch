import assert from 'node:assert/strict'
import test from 'node:test'
import { cardActionOffset } from '../src/screens/managers/card-action-layout.ts'

test('长卡操作栏在可视底部、卡尾回归原位、未进入视口时跟随卡片', () => {
  assert.equal(cardActionOffset(100, 2100, 60, 800), -1360)
  assert.equal(cardActionOffset(100, 740, 60, 800), 0)
  assert.equal(cardActionOffset(100, 700, 60, 800), 0)
  assert.equal(cardActionOffset(900, 2100, 60, 800), -1200)
  // 键盘缩短视口，操作条随新的可用底部上移。
  assert.equal(cardActionOffset(100, 2100, 60, 420), -1740)
})

test('滚动经过多张卡：位移始终受本卡边界限制，末行与操作栏的原始空间保持完整', () => {
  for (const cardTop of [0, 800, 1600]) {
    const footerTop = cardTop + 1500
    const height = 64
    for (let bottom = 200; bottom < 4000; bottom += 37) {
      const moved = footerTop + cardActionOffset(cardTop, footerTop, height, bottom)
      assert.ok(moved >= cardTop)
      assert.ok(moved <= footerTop)
      if (bottom >= footerTop + height) assert.equal(moved, footerTop)
      if (bottom > cardTop + height && bottom < footerTop + height)
        assert.equal(moved + height, bottom)
    }
  }
})
