import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHROME_WIRE_MIN,
  CHROME_WIRE_VERSION,
  negotiateChromeWire,
} from '../src/chrome-browser.mts'

test('两边范围重叠时取双方都会说的最高协议号', () => {
  const own = { protocol: 3, minProtocol: 2 }
  assert.deepEqual(negotiateChromeWire({ protocol: 3, minProtocol: 3 }, own), { protocol: 3 })
  // 扩展新一版、还会说旧协议：按 Litch 的来
  assert.deepEqual(negotiateChromeWire({ protocol: 4, minProtocol: 3 }, own), { protocol: 3 })
  // 扩展旧一版：按扩展的来
  assert.deepEqual(negotiateChromeWire({ protocol: 2, minProtocol: 1 }, own), { protocol: 2 })
})

test('不重叠时指出该更新哪一边', () => {
  const own = { protocol: 3, minProtocol: 2 }
  assert.deepEqual(negotiateChromeWire({ protocol: 1, minProtocol: 1 }, own), {
    incompatible: 'extensionOutdated',
  })
  assert.deepEqual(negotiateChromeWire({ protocol: 5, minProtocol: 4 }, own), {
    incompatible: 'litchOutdated',
  })
})

test('按升号规则，相邻小版本无论谁新都能协商', () => {
  // 上一小版说 P，这一版最多把 MIN 抬到 P
  const previous = { protocol: 1, minProtocol: 1 }
  const current = { protocol: CHROME_WIRE_VERSION, minProtocol: CHROME_WIRE_MIN }
  assert.ok(CHROME_WIRE_MIN <= CHROME_WIRE_VERSION)
  assert.ok('protocol' in negotiateChromeWire(previous, current))
  assert.ok('protocol' in negotiateChromeWire(current, previous))
  const next = { protocol: 2, minProtocol: 1 }
  assert.ok('protocol' in negotiateChromeWire(next, previous))
  assert.ok('protocol' in negotiateChromeWire(previous, next))
})
