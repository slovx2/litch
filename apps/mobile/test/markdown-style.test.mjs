// 回答正文的 Markdown 样式（src/detail/markdownStyle.ts）：三种皮肤、深浅两种，带颜色的项都写全、对比度够
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownStyleOf } from '../src/detail/markdownStyle.ts'
import { PALETTES } from '../src/ui/palettes.ts'

const themes = Object.entries(PALETTES).flatMap(([skin, pair]) =>
  Object.entries(pair).map(([mode, c]) => ({
    name: `${skin}/${mode}`,
    theme: { skin, c, font: { mono: 'monospace', size: {} }, radius: { s: 0, m: 0, l: 0 } },
  })),
)

/**
 * 组件默认值是浅色的那些颜色项（node_modules/react-native-enriched-markdown/src/normalizeMarkdownStyle.ts）。
 * 漏写一项，深色主题下它就是白底或深字
 */
const COLOR_KEYS = {
  paragraph: ['color'],
  h1: ['color'],
  h2: ['color'],
  h3: ['color'],
  h4: ['color'],
  h5: ['color'],
  h6: ['color'],
  list: ['color', 'bulletColor', 'markerColor'],
  codeBlock: ['color', 'backgroundColor', 'borderColor'],
  code: ['color', 'backgroundColor', 'borderColor'],
  blockquote: ['color', 'borderColor', 'backgroundColor'],
  link: ['color'],
  strikethrough: ['color'],
  underline: ['color'],
  thematicBreak: ['color'],
  table: [
    'color',
    'headerTextColor',
    'headerBackgroundColor',
    'rowEvenBackgroundColor',
    'rowOddBackgroundColor',
    'borderColor',
  ],
  taskList: ['checkedColor', 'checkmarkColor', 'borderColor', 'checkedTextColor'],
  math: ['color', 'backgroundColor'],
  inlineMath: ['color'],
  spoiler: ['color'],
  highlight: ['color', 'backgroundColor'],
}

/** '#rrggbb'、'rgba(r,g,b,a)'、'transparent' → [r, g, b, a] */
function parse(color) {
  if (color === 'transparent') return [0, 0, 0, 0]
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    return [n >> 16, (n >> 8) & 255, n & 255, 1]
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color)
  assert.ok(rgba, `认不出的颜色 ${color}`)
  const [r, g, b, a = 1] = rgba[1].split(',').map(Number)
  return [r, g, b, a]
}

/** 半透明的颜色叠在不透明的底上 */
function over(color, ground) {
  const [r, g, b, a] = parse(color)
  const [R, G, B] = parse(ground)
  return `rgba(${[r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)].join(',')})`
}

function luminance(color) {
  const [r, g, b] = parse(color).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

for (const { name, theme } of themes) {
  test(`${name}：带颜色的项都写了，不落到组件的浅色默认值`, () => {
    const style = markdownStyleOf(theme)
    for (const [block, keys] of Object.entries(COLOR_KEYS)) {
      for (const key of keys) {
        const value = style[block]?.[key]
        assert.equal(typeof value, 'string', `${block}.${key} 没写`)
        parse(value)
      }
    }
  })

  test(`${name}：表格的字和底对比度够，表体跟着对话区、没有斑马纹`, () => {
    const { c } = theme
    const { table } = markdownStyleOf(theme)
    // 对话区的底是 raised（Transcript.tsx）
    const ground = c.raised
    const header = over(table.headerBackgroundColor, ground)
    assert.ok(contrast(table.headerTextColor, header) >= 7, `表头 ${contrast(table.headerTextColor, header)}`)
    for (const row of [table.rowEvenBackgroundColor, table.rowOddBackgroundColor]) {
      assert.equal(row, 'transparent')
      assert.ok(contrast(table.color, over(row, ground)) >= 7)
    }
    // 表头要看得出是一层：和表体的底不一样
    assert.ok(contrast(header, ground) > 1.05, `表头底色和表体分不开 ${contrast(header, ground)}`)
    // 格线看得见
    assert.ok(contrast(over(table.borderColor, ground), ground) >= 1.3)
  })

  test(`${name}：正文里其余的字和底对比度够`, () => {
    const { c } = theme
    const style = markdownStyleOf(theme)
    const ground = c.raised
    const pairs = {
      'h6': [style.h6.color, ground],
      'blockquote': [style.blockquote.color, over(style.blockquote.backgroundColor, ground)],
      'codeBlock': [style.codeBlock.color, style.codeBlock.backgroundColor],
      'code': [style.code.color, over(style.code.backgroundColor, ground)],
      'math': [style.math.color, style.math.backgroundColor],
      'highlight': [style.highlight.color, over(style.highlight.backgroundColor, ground)],
      'taskList.checkedText': [style.taskList.checkedTextColor, ground],
      'taskList.checkmark': [style.taskList.checkmarkColor, style.taskList.checkedColor],
    }
    for (const [what, [fg, bg]] of Object.entries(pairs)) {
      assert.ok(contrast(fg, bg) >= 4.5, `${what} ${contrast(fg, bg).toFixed(2)}`)
    }
    // 列表记号、分隔线是非文字的图形，3:1 和 1.3:1 就够
    assert.ok(contrast(style.list.bulletColor, ground) >= 3)
    assert.ok(contrast(over(style.thematicBreak.color, ground), ground) >= 1.3)
  })
}

test('同一套配色拿到的是同一个样式对象（组件不因此重新排版）', () => {
  const [{ theme }] = themes
  assert.equal(markdownStyleOf(theme), markdownStyleOf({ ...theme }))
})
