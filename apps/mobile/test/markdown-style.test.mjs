// 回答正文的 Markdown 样式（src/detail/markdownStyle.ts）：三种皮肤、深浅两种，带颜色的项都写全、对比度够
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownStyleOf } from '../src/detail/markdownStyle.ts'
import { PALETTES } from '../src/ui/palettes.ts'

const themes = Object.entries(PALETTES).flatMap(([skin, pair]) =>
  Object.entries(pair).map(([mode, c]) => ({
    name: `${skin}/${mode}`,
    theme: {
      skin,
      dark: mode === 'dark',
      c,
      font: { mono: 'monospace', size: {} },
      radius: { s: 0, m: 0, l: 0 },
    },
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
    assert.ok(
      contrast(table.headerTextColor, header) >= 7,
      `表头 ${contrast(table.headerTextColor, header)}`,
    )
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
      h6: [style.h6.color, ground],
      blockquote: [style.blockquote.color, over(style.blockquote.backgroundColor, ground)],
      codeBlock: [style.codeBlock.color, style.codeBlock.backgroundColor],
      code: [style.code.color, over(style.code.backgroundColor, ground)],
      math: [style.math.color, style.math.backgroundColor],
      highlight: [style.highlight.color, over(style.highlight.backgroundColor, ground)],
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

for (const { name, theme } of themes) {
  test(`${name}：行内代码照桌面端，一层淡的墨色、不描边，看得出是一块`, () => {
    const { code, paragraph } = markdownStyleOf(theme)
    const ground = theme.c.raised
    assert.equal(code.borderColor, 'transparent')
    assert.equal(code.fontFamily, theme.font.mono)
    // 比正文小一号，不把行撑高
    assert.ok(code.fontSize < paragraph.fontSize)
    const box = over(code.backgroundColor, ground)
    assert.ok(
      contrast(box, ground) > 1.1,
      `代码底和正文底分不开 ${contrast(box, ground).toFixed(2)}`,
    )
  })
}

/** 组件给深底配的那套上色里要换掉的记号（运算符、标点、变量、内嵌的跟着代码块的字色，不用写） */
const SYNTAX_KEYS = [
  'comment',
  'keyword',
  'string',
  'number',
  'constant',
  'function',
  'type',
  'property',
  'attribute',
  'tag',
]

for (const { name, theme } of themes) {
  test(`${name}：代码上色每种记号都写了，在代码块的底上看得清`, () => {
    const { codeBlock } = markdownStyleOf(theme)
    for (const key of SYNTAX_KEYS) {
      const color = codeBlock.syntaxColors?.[key]
      assert.equal(typeof color, 'string', `syntaxColors.${key} 没写`)
      const ratio = contrast(color, codeBlock.backgroundColor)
      // 和桌面端同一套颜色：注释是三级字，其余是线色，按非正文的大字标准 3:1
      assert.ok(ratio >= 3, `syntaxColors.${key} ${ratio.toFixed(2)}`)
    }
  })
}

test('浅色复古另配了更深的代码颜色，深色用皮肤的线色', () => {
  const light = themes.find((t) => t.name === 'retro/light').theme
  const dark = themes.find((t) => t.name === 'retro/dark').theme
  assert.equal(markdownStyleOf(light).codeBlock.syntaxColors.string, '#0b6b3d')
  assert.equal(markdownStyleOf(dark).codeBlock.syntaxColors.string, dark.c.wire.green)
})

test('同一套配色拿到的是同一个样式对象（组件不因此重新排版）', () => {
  const [{ theme }] = themes
  assert.equal(markdownStyleOf(theme), markdownStyleOf({ ...theme }))
})

test('行内代码的组件补丁对得上装的版本（升级组件时要重做补丁）', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const version = pkg.dependencies['react-native-enriched-markdown']
  const patches = readdirSync(new URL('../patches/', import.meta.url))
  assert.ok(patches.includes(`react-native-enriched-markdown+${version}.patch`), patches.join(', '))
  assert.equal(pkg.scripts.postinstall, 'patch-package')
})

test('删除线只认两个波浪号：组件补丁改了 md4c 认 ~ 的那一处（桌面端 markdown-lex.ts 是同一条规矩）', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const version = pkg.dependencies['react-native-enriched-markdown']
  const patch = readFileSync(
    new URL(`../patches/react-native-enriched-markdown+${version}.patch`, import.meta.url),
    'utf8',
  )
  assert.match(
    patch,
    /^\+ *\} else if\(tmp - off == 2 {2}&& {2}\(ctx->parser\.flags & MD_FLAG_STRIKETHROUGH\)\) \{$/m,
  )
})
