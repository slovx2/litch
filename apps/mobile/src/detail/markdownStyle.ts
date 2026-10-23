// 回答正文的 Markdown 样式：颜色一律从当前皮肤、明暗的配色取。
// 这个 Markdown 组件没写的样式项用它自己的默认值，而默认值是一套浅色（白底的表格行、深色的表头字、
// 浅灰的引用底、深色的四到六级标题……），深色主题下会和配色里的浅色字撞在一起。
// 所以凡是带颜色的项都在这里写全，测试（test/markdown-style.test.mjs）逐项看有没有漏、对比度够不够。
// 表格照桌面端（packages/ui 的 transcript-prose.css）：表体不铺底、跟着对话区，表头一层淡的墨色，没有斑马纹。
import type { MarkdownStyle } from 'react-native-enriched-markdown'
import type { Palette, Theme } from '../ui/theme'

/** 每套配色一份 Markdown 样式（对象不变，组件不会因为它重新排版） */
const styleCache = new WeakMap<Palette, MarkdownStyle>()

/** 每种皮肤、每种明暗的配色是各自的一份，按配色缓存就是按皮肤缓存 */
export function markdownStyleOf({
  c,
  font,
  radius,
  skin,
}: Pick<Theme, 'c' | 'font' | 'radius' | 'skin'>): MarkdownStyle {
  let style = styleCache.get(c)
  if (style) return style
  const ui = font.ui
  // 人文皮肤正文行距放开一点
  const body = skin === 'human' ? 25 : 22
  const heading = (fontSize: number, lineHeight: number) => ({
    fontSize,
    lineHeight,
    color: c.ink,
    fontWeight: '700',
    fontFamily: ui,
  })
  style = {
    paragraph: { fontSize: 15, lineHeight: body, color: c.ink, fontFamily: ui },
    h1: heading(20, 28),
    h2: heading(19, 26),
    h3: heading(17, 24),
    h4: heading(16, 23),
    h5: heading(15, 22),
    h6: { ...heading(15, 22), color: c.ink2 },
    list: {
      fontSize: 15,
      lineHeight: body,
      color: c.ink,
      fontFamily: ui,
      bulletColor: c.ink2,
      markerColor: c.ink2,
    },
    codeBlock: {
      fontSize: 13,
      lineHeight: 19,
      fontFamily: font.mono,
      color: c.ink,
      backgroundColor: c.sunken,
      borderColor: c.line1,
      borderWidth: 1,
      padding: 10,
      borderRadius: radius.m,
    },
    code: {
      fontSize: 13,
      fontFamily: font.mono,
      color: c.ink,
      backgroundColor: c.sunken,
      borderColor: c.line1,
    },
    blockquote: { borderColor: c.line3, color: c.ink2, backgroundColor: 'transparent' },
    link: { color: c.accent, underline: true },
    // 文件路径和网址一个颜色，只是不画下划线：改写前后字形一样（links.ts）
    linkVariants: {
      '^litch-file:': { color: c.accent, underline: false },
      // 回答里指向评论的 [N]（comments/refs.ts）：一个小记号
      '^litch-comment:': { color: c.accent, underline: false, backgroundColor: c.sel },
    },
    strikethrough: { color: c.ink3 },
    underline: { color: c.ink },
    thematicBreak: { color: c.line2 },
    table: {
      fontSize: 14,
      color: c.ink,
      fontFamily: ui,
      headerFontFamily: ui,
      headerTextColor: c.ink,
      headerBackgroundColor: c.press,
      rowEvenBackgroundColor: 'transparent',
      rowOddBackgroundColor: 'transparent',
      borderColor: c.line2,
      borderRadius: radius.s,
    },
    taskList: {
      checkedColor: c.accentSolid,
      checkmarkColor: c.onAccent,
      borderColor: c.line3,
      checkedTextColor: c.ink2,
    },
    math: { color: c.ink, backgroundColor: c.sunken },
    inlineMath: { color: c.ink },
    spoiler: { color: c.ink3 },
    highlight: { color: c.ink, backgroundColor: c.sel },
  } satisfies MarkdownStyle
  styleCache.set(c, style)
  return style
}
