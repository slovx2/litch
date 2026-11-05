import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { rowAccessibility } from '../src/ui/kit/row-accessibility.ts'

test('只有 iOS 无操作 Row 展开子控件，同名 Switch 标签只读一次', () => {
  for (const platform of ['ios', 'android', 'web']) {
    for (const [press, longPress] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]) {
      const separate = platform === 'ios' && !press && !longPress
      assert.deepEqual(rowAccessibility(platform, press, longPress, true), {
        accessible: separate ? false : undefined,
        hideTitle: separate,
      })
      assert.equal(rowAccessibility(platform, press, longPress, false).hideTitle, false)
    }
  }
  const source = readFileSync(new URL('../src/ui/kit/controls.tsx', import.meta.url), 'utf8')
  assert.match(source, /accessible=\{accessibility\.accessible\}/)
  assert.match(source, /right\.type === Switch/)
  assert.match(source, /right\.props\.accessibilityLabel === title/)
  assert.match(source, /accessibilityElementsHidden=\{accessibility\.hideTitle \|\| undefined\}/)
})
