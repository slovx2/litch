import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { bareTextPixels, followsText, textRules } from '../../../scripts/text-size-scope.mjs'

test('首帧字号：六档正确写入，无效值回默认，不受查询参数改写', () => {
  const source = readFileSync(new URL('../public/prepaint.js', import.meta.url), 'utf8')
  for (const scale of [0.9, 1, 1.1, 1.2, 1.35, 1.5, 2, null, '1.5']) {
    const values = {}
    const root = {
      dataset: {},
      style: {
        setProperty: (key, value) => {
          values[key] = value
        },
      },
    }
    runInNewContext(source, {
      document: { documentElement: root },
      localStorage: { getItem: () => JSON.stringify({ treeText: scale, chatText: scale }) },
      location: { search: '?chatText=2' },
      URLSearchParams,
      navigator: { language: 'zh-CN' },
      window: {},
    })
    const expected = typeof scale === 'number' && scale <= 1.5 ? String(scale) : '1'
    assert.equal(values['--fs-tree'], expected)
    assert.equal(values['--fs-chat'], expected)
  }
})

test('检查脚本能拦字号、font 简写、像素行高，允许使用处计算及单位行高', () => {
  assert.equal(
    bareTextPixels('font-size: 12px; font: 500 13px / 20px serif; line-height: 19px;').length,
    3,
  )
  assert.equal(
    bareTextPixels('font-size: calc(12px + 2px); line-height: calc(20px * var(--fs));').length,
    2,
  )
  assert.equal(
    bareTextPixels('font: calc(12px * var(--fs)) / calc(18px * var(--fs)) serif;').length,
    1,
  )
  assert.deepEqual(
    bareTextPixels(
      'font: 500 calc(13px * var(--fs)) / round(calc(20px * var(--fs)), 1px) var(--ui); line-height: 1.5;',
    ),
    [],
  )
  const rules = textRules('@media (width < 900px) { .md {font-size: 14px;} } /*font-size: 1px*/')
  assert.equal(rules[0].selector, '.md')
  assert.equal(followsText('shell.css', '.ss-row .time'), true)
  assert.equal(followsText('shell.css', '.sb-btn'), false)
  assert.equal(followsText('skins/human.css', '[data-skin="human"] .cmp-text'), true)
})
